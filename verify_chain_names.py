#!/usr/bin/env python3
"""
verify_chain_names.py — Look up, in Eschmeyer's Catalog, each name that the
historical-chain gate in scrape_eschmeyer.py rejected, and decide what it is.

Background. parse_text() used to read every "Synonym of X" bullet in an entry as
a former name of the page's species. That holds for an older combination of the
same species. It is wrong when one author put the entry under a DIFFERENT
species: "pullus, Pimelodus ... Synonym of Ictalurus melas -- (La Rivers 1994)"
shipped Ictalurus melas -> Brown Bullhead. The gate now refuses a cited name
unless the page itself ties it to the target. One case it cannot see is a name
that an earlier Names of Fishes edition applied to this fish although the name
belongs to a species elsewhere. Antennarius striatus (6th and 7th eds.) is now
A. scaber in the Atlantic. Telling the two apart needs the name's own page.

For each rejected name that nothing else in the map claims, this fetches the
name's page (genus + species). If the name has no entry there, it fetches the
whole family of the target the chain proposed. Then it reads the name's own
entry:

  restore        its current status resolves to the target the chain proposed
  retarget       it resolves to a different Names of Fishes species
  prior_edition  the 6th or 7th ed. list (Nelson et al. 2004, Page et al. 2013)
                 used it as valid. Kept, pointing at the chain's target. The
                 successor is NOT verified by this; confirm it by hand. Squalus
                 mitsukurii's chain target was S. acanthias, but the 7th ed.'s
                 fish is S. clarkae.
  remove         valid elsewhere, or a synonym of a species not on the list
  review         no entry found; decide by hand

Writes chain_verdicts.json (committed). An entry with "reviewed" set records a
decision made by a person and is never overwritten. scrape_eschmeyer.py applies
restore, retarget and prior_edition when it builds the map.

Fetched page text goes to eschmeyer_text/verify/ (gitignored), so --offline
replays a parser change without the network, as --reparse does for the scrape.

Usage:
  uv run --with requests --with beautifulsoup4 python verify_chain_names.py
      --offline   no network; use stored pages only
      --dry-run   print the verdicts, do not write chain_verdicts.json
then:
  uv run --with requests --with beautifulsoup4 python scrape_eschmeyer.py --rebuild-only
"""

import datetime
import gzip
import json
import re
import sys
import time
from pathlib import Path

import requests

import addenda_overlay
import scrape_eschmeyer as esch

VERIFY_DIR = esch.TEXT_CACHE_DIR / "verify"

# Catalog reference ids of the Names of Fishes lists. The catalog cites the 6th
# and 7th editions thousands of times. It cites the 5th (Robins et al. 1991) six
# times, which is too rarely to rely on, so the 5th is not counted.
AFS_REFS = {"27807": "6th", "32708": "7th", "32709": "7th"}

STATUS_RE = re.compile(
    r"Current status:\s*(Valid as|Synonym of|Uncertain as)\s+([A-Z][a-z]+ [a-z]+(?:-[a-z]+)*)")


# ── Stored pages ──────────────────────────────────────────────────────────────

def _page_path(key: str) -> Path:
    return VERIFY_DIR / (key.replace(" ", "_") + ".json.gz")


def load_page(key: str) -> dict | None:
    p = _page_path(key)
    if not p.exists():
        return None
    with gzip.open(p, "rt", encoding="utf-8") as f:
        return json.load(f)


def save_page(key: str, params: dict, text: str, fetched: str) -> dict:
    VERIFY_DIR.mkdir(parents=True, exist_ok=True)
    page = {"params": params, "fetched": fetched, "text": text}
    with gzip.open(_page_path(key), "wt", encoding="utf-8") as f:
        json.dump(page, f, ensure_ascii=False)
    return page


# ── Parse ─────────────────────────────────────────────────────────────────────

def entries(text: str):
    """Yield (header match, entry text) for every entry on a page."""
    hs = list(esch.ENTRY_HEADER_RE.finditer(text))
    for i, h in enumerate(hs):
        yield h, text[h.start(): hs[i + 1].start() if i + 1 < len(hs) else len(text)]


def own_entries(text: str, name: str) -> list[str]:
    """The entries for the nominal species `name` denotes.

    First, any entry some author treated as valid under exactly this name; then
    an entry whose header is this genus and epithet. Never a fuzzy match:
    "caurinus, Sebastes" is 2 edits from Sebastes marinus, which is a different
    fish (the catalog's misapplied-name entry for S. norvegicus).
    """
    genus, epithet = name.split(" ", 1)
    ents = list(entries(text))
    out = [b for h, b in ents if re.search(r"Valid as " + re.escape(name) + r"\b", b)]
    return out or [b for h, b in ents if h.group(2) == genus and h.group(1) == epithet]


def afs_editions(text: str, name: str, kinds: str = "Valid as") -> set[str]:
    """Names of Fishes editions cited in a '<kinds> <name>' bullet of `text`."""
    eds = set()
    for b in re.finditer(r"•\s*(?:" + kinds + r") " + re.escape(name) + r"\b[^•]*", text):
        eds |= {AFS_REFS[r] for r in re.findall(r"\[ref\. (\d+) \]", b.group(0)) if r in AFS_REFS}
    return eds


def classify(name: str, chain_targets: list[str], texts: list[str],
             target_texts: list[str], valid_names, esch_to_afs: dict) -> dict:
    """Verdict for one rejected name.

    texts         the name's own page, then the family listing, in that order
    target_texts  the stored pages of the chain targets. A Names of Fishes
                  list may have filed one of the target's nominal species
                  under this name there ("Synonym of X -- (Page et al. 2013)").
    """
    own = []
    for text in texts:
        own = own_entries(text, name)
        if own:
            break
    statuses = set()
    for body in own:
        m = STATUS_RE.search(body)
        if m:
            statuses.add((m.group(1), m.group(2)))
    if not own:
        # A header with "var." ("pilchardus, Clupea harengus var.") never parses,
        # but the page still states the status.
        for text in texts:
            if re.search(r"Current status:\s*Valid as " + re.escape(name) + r"\b", text):
                statuses.add(("Valid as", name))
                own = [""]
                break

    eds = set()
    for body in own:
        eds |= afs_editions(body, name)
    for text in target_texts:
        eds |= afs_editions(text, name, "Valid as|Synonym of")

    resolved = {n for _, n in statuses}
    # Eschmeyer's current name -> Names of Fishes name where they disagree
    # (the catalog's Allinectes pycnosoma is the List's Careproctus pycnosoma).
    resolved |= {esch_to_afs[n] for n in resolved if n in esch_to_afs}
    on_list = sorted(resolved & set(valid_names))
    hit = sorted(resolved & set(chain_targets))

    if hit:
        verdict, target = "restore", hit[0]
    elif len(on_list) == 1:
        verdict, target = "retarget", on_list[0]
    elif eds:
        verdict, target = (("prior_edition", chain_targets[0]) if len(chain_targets) == 1
                           else ("review", None))
    elif not own or on_list:
        verdict, target = "review", None
    else:
        verdict, target = "remove", None

    return {
        "verdict": verdict,
        "target": target,
        "chain_targets": chain_targets,
        "catalog_status": "; ".join(f"{k} {n}" for k, n in sorted(statuses)) or None,
        "afs_editions": sorted(eds),
        "_resolved": sorted(resolved),
    }


def inherit_prior_editions(recs: dict, reviewed: dict) -> None:
    """A combination of a prior-edition name takes its verdict. Oostethus
    brachyurus is "Valid as Microphis brachyurus", a 6th/7th ed. name."""
    prior = {n: r["target"] for n, r in {**recs, **reviewed}.items()
             if r.get("verdict") == "prior_edition" and r.get("target")}
    for name, r in recs.items():
        if r["verdict"] in ("remove", "review"):
            via = sorted(set(r.get("_resolved", [])) & set(prior))
            if via:
                r.update(verdict="prior_edition", target=prior[via[0]], via=via[0])


# ── Candidates ────────────────────────────────────────────────────────────────

def candidates(cache: dict, data: dict, extralimital: set) -> dict[str, list[str]]:
    """Rejected chain names that no other path in the map build claims."""
    ov = addenda_overlay.load_overlay()
    demotions = {r["from"]: r["to"] for r in ov["renames"]} if ov else {}
    # The addenda overlay re-asserts these after every rebuild, whatever the
    # scrape says (Doryrhamphus excisus is a demotion, Etrumeus teres a pin).
    overlay_names = set(demotions) | {c["old"] for c in (ov or {}).get("curated_synonyms", [])}
    valid = data["valid_names"]
    claimed, rejected = set(), {}
    for binomial, entry in cache.items():
        binomial = demotions.get(binomial, binomial)
        if binomial not in valid or entry.get("valid") is None:
            continue
        claimed.update(entry.get("synonyms", []))
        for n in entry.get("chain_rejected", []):
            rejected.setdefault(n, set()).add(binomial)
    out = {}
    for n, tgts in rejected.items():
        parts = n.split()
        if (n in claimed or n in valid or n in extralimital or n in overlay_names
                or len(parts) != 2 or len(parts[1]) < 3):
            continue
        out[n] = sorted(tgts)
    return dict(sorted(out.items()))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    offline = "--offline" in sys.argv
    dry_run = "--dry-run" in sys.argv
    today = datetime.date.today().isoformat()

    with open(esch.DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    with open(esch.CACHE_PATH, encoding="utf-8") as f:
        cache = json.load(f)
    if not any("chain_rejected" in e for e in cache.values()):
        print("ERROR: eschmeyer_cache.json has no chain_rejected lists; it predates the")
        print("chain gate. Run scrape_eschmeyer.py --reparse --dry-run first.")
        sys.exit(1)
    extralimital = set()
    if esch.EXTRALIMITAL_PATH.exists():
        with open(esch.EXTRALIMITAL_PATH, encoding="utf-8") as f:
            extralimital = set(json.load(f))
    existing = {}
    if esch.CHAIN_VERDICTS_PATH.exists():
        with open(esch.CHAIN_VERDICTS_PATH, encoding="utf-8") as f:
            existing = json.load(f)
    reviewed = {n: v for n, v in existing.items() if v.get("reviewed")}

    valid = data["valid_names"]
    esch_to_afs = {e["current_name"]: k for k, e in cache.items()
                   if k in valid and e.get("current_name") and e["current_name"] != k}
    todo = {n: t for n, t in candidates(cache, data, extralimital).items() if n not in reviewed}
    print(f"{len(todo)} rejected chain names to verify"
          f" ({len(reviewed)} reviewed verdicts kept as they are)"
          + ("  [offline]" if offline else ""))

    session = requests.Session()
    n_req = 0

    def fetch(key, params):
        nonlocal n_req
        page = load_page(key)
        if page is not None or offline:
            return page
        html = esch.fetch_params(params, session)
        n_req += 1
        time.sleep(esch.PAUSE_SECS if n_req % esch.PAUSE_EVERY == 0 else esch.DELAY)
        return None if html is None else save_page(key, params, esch.normalize_html(html), today)

    recs, missing = {}, []
    for i, (name, chain_targets) in enumerate(todo.items(), 1):
        genus, epithet = name.split(" ", 1)
        page = fetch(name, {"tbl": "species", "genus": genus, "species": epithet})
        if page is None:
            missing.append(name)
            continue
        texts = [page["text"]]
        if not own_entries(page["text"], name):
            # The family comes from the List's record for the chain target. Where
            # the catalog divides a family differently (Gobiidae vs Oxudercidae,
            # see classification_crosscheck.json) the listing can miss the entry;
            # that only costs a "review".
            family = valid.get(chain_targets[0], {}).get("family", "")
            fam = fetch("_family_" + family, {"tbl": "species", "family": family}) if family else None
            if fam is not None:
                texts.append(fam["text"])
        target_texts = [p["text"] for p in map(esch.load_text, chain_targets) if p]
        rec = classify(name, chain_targets, texts, target_texts, valid, esch_to_afs)
        rec["verified"] = f"{page['fetched']} (Eschmeyer's Catalog of Fishes)"
        recs[name] = rec
        print(f"[{i}/{len(todo)}] {rec['verdict']:13s} {name}"
              + (f" -> {rec['target']}" if rec["target"] else ""), flush=True)

    inherit_prior_editions(recs, reviewed)
    for r in recs.values():
        r.pop("_resolved", None)
    # A page we could not get keeps its previous verdict rather than vanishing.
    for name in missing:
        if name in existing:
            recs[name] = existing[name]

    out = {**recs, **reviewed}
    out = dict(sorted(out.items()))
    counts = {}
    for r in out.values():
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    print(f"\nVerdicts: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))
          + f"  ({n_req} catalog requests)")
    unconfirmed = [n for n, r in recs.items() if r["verdict"] == "prior_edition"]
    if unconfirmed:
        print("\nprior_edition, successor NOT checked (confirm, then mark reviewed):")
        for n in unconfirmed:
            r = recs[n]
            print(f"  {n:32s} -> {r['target']}   [{', '.join(r['afs_editions']) or 'via ' + r.get('via', '')}]")
    open_items = [n for n, r in out.items() if r["verdict"] == "review" and not r.get("reviewed")]
    if open_items:
        print("\nreview (no catalog entry found; decide by hand):")
        for n in open_items:
            print(f"  {n:32s} chain target {', '.join(out[n]['chain_targets'])}")
    if missing:
        print(f"\nNo page for {len(missing)} names" + (" (offline)" if offline else " (fetch failed)")
              + ": " + ", ".join(missing))

    if dry_run:
        print("\n--dry-run: chain_verdicts.json NOT written.")
        return
    with open(esch.CHAIN_VERDICTS_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"\nWrote {esch.CHAIN_VERDICTS_PATH.name} ({len(out)} verdicts). "
          "Next: scrape_eschmeyer.py --rebuild-only")


if __name__ == "__main__":
    main()
