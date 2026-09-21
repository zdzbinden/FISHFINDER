#!/usr/bin/env python3
"""
scrape_eschmeyer.py — Enrich fish_names.json with synonym data from
Eschmeyer's Catalog of Fishes.
https://researcharchive.calacademy.org/research/ichthyology/catalog/

For each valid species in fish_names.json, queries the catalog and collects:
  - synonyms (older names that map to the current accepted name)
  - any cases where the AFS 8th ed. name differs from Eschmeyer's accepted name

Results are cached to eschmeyer_cache.json so interrupted runs resume cleanly.
A cold run over all ~5,200 species takes ~3 hours at 2 s/request; with a warm
cache only the new binomials are fetched.

Re-applies the 2025 Addenda overlay (addenda_overlay.apply_synonyms) after
rebuilding the map — without it a scrape silently reverts the addenda's
demotions, retargeting and curated pairs.

Usage:
    uv run --with requests --with beautifulsoup4 python scrape_eschmeyer.py --merge
        --merge          keep the existing synonym map, fold in only what is
                         missing (production path: surgical diff, loses nothing)
        (no flag)        rebuild the whole map from cache (verification path;
                         must converge on the same map as --merge)
        --rebuild-only   rebuild without scraping
"""

import datetime
import json
import re
import sys
import time
from pathlib import Path

import addenda_overlay

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("ERROR: missing dependencies.")
    print("Run: uv run --with requests --with beautifulsoup4 python scrape_eschmeyer.py")
    sys.exit(1)

DATA_PATH  = Path(__file__).parent / "fishfinder" / "data" / "fish_names.json"
CACHE_PATH = Path(__file__).parent / "eschmeyer_cache.json"
EXTRALIMITAL_PATH = Path(__file__).parent / "extralimital_valids.json"

BASE_URL = (
    "https://researcharchive.calacademy.org"
    "/research/ichthyology/catalog/fishcatget.asp"
)
DELAY        = 2.0   # seconds between requests
PAUSE_EVERY  = 50    # take a longer break every N requests
PAUSE_SECS   = 15    # length of the longer break
MAX_RETRIES  = 3     # retries on connection failure
RETRY_BACKOFF = 10   # seconds for first retry; doubles each attempt
HEADERS = {
    "User-Agent": (
        "FishNameChecker/1.0 (scientific research tool; "
        "contact via https://github.com/zdzbinden/FISHFINDER)"
    )
}

# Eschmeyer entry header: "epithet, Genus" with lookahead for "Author [Year]"
# Used in both parse_results() and _find_original_genus() to locate entry boundaries.
ENTRY_HEADER_RE = re.compile(
    r'([a-z][a-z-]+),\s+([A-Z][a-z]+)'
    r'(?=(?:\s+\([A-Z][a-z]+\))?\s+[A-Z][a-z]+\s+\[)'
)


# ── Fetch ─────────────────────────────────────────────────────────────────────

def fetch_species(genus: str, species: str, session: requests.Session) -> str | None:
    """Return raw HTML for the catalog page, or None after retries are exhausted."""
    params = {"tbl": "species", "genus": genus, "species": species}
    wait = RETRY_BACKOFF
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = session.get(BASE_URL, params=params, headers=HEADERS, timeout=20)
            r.raise_for_status()
            return r.text
        except requests.RequestException as e:
            if attempt < MAX_RETRIES:
                print(f"\n  retry {attempt}/{MAX_RETRIES} in {wait}s ({e})", flush=True)
                time.sleep(wait)
                wait *= 2
                # Reset connection pool (requests reconnects lazily)
                session.close()
            else:
                print(f"WARNING: gave up on {genus} {species}: {e}")
                return None


# ── Parse ─────────────────────────────────────────────────────────────────────

def parse_results(html: str, target_genus: str, target_species: str) -> dict:
    """
    Parse a catalog result page for one genus+species query.

    Returns a dict:
        valid        – True if Eschmeyer considers this the accepted name
        current_name – accepted binomial (may differ from AFS name)
        synonyms     – list of older binomials that map to this species
    """
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(separator=" ")
    text = re.sub(r'\s+', ' ', text)       # collapse all whitespace to single spaces
    text = re.sub(r'\s+,', ',', text)      # fix "word , word" from tag-boundary spaces

    result = {"valid": False, "current_name": "", "synonyms": []}

    # "Current status: Valid as Genus species"
    m = re.search(r'Current status[:\s]+Valid as\s+([A-Z][a-z]+\s+[a-z]+)', text)
    if m:
        result["valid"] = True
        result["current_name"] = m.group(1)

    # "Current status: Synonym of Genus species"
    m = re.search(r'Current status[:\s]+Synonym of\s+([A-Z][a-z]+\s+[a-z]+)', text)
    if m:
        result["valid"] = False
        result["current_name"] = m.group(1)

    # Collect synonyms: entries that say "Synonym of <target>" in their status line.
    # Each entry block starts with "genus, species Author Year" then has a status line.
    target_binomial = f"{target_genus} {target_species}"

    # Find synonyms by searching for each status-string occurrence and looking
    # backwards to the nearest preceding "epithet, Genus" entry header.
    #
    # This is more robust than block-splitting because Eschmeyer's HTML often
    # renders multiple entries without blank lines between them, which causes
    # re.split(r'\n{2,}') to lump everything into one block and re.match to
    # only see the first entry.
    #
    # Eschmeyer entry header format: "epithet, OriginalGenus Author Year"
    # (lowercase epithet first, then title-case genus — reversed from normal)

    SYNONYM_OF_RE = re.compile(r'Synonym of ([A-Z][a-z]+ [a-z]+)')

    def last_header_before(pos):
        """Return (epithet, genus) of the entry header nearest before `pos`."""
        best = None
        for m in ENTRY_HEADER_RE.finditer(text[:pos]):
            best = m   # keep advancing; last match is the one we want
        return best

    # 1. Strict synonyms: "Synonym of <target>"
    for status_m in re.finditer(r'Synonym of ' + re.escape(target_binomial), text):
        hdr = last_header_before(status_m.start())
        if not hdr:
            continue
        old_binomial = f"{hdr.group(2)} {hdr.group(1)}"
        if old_binomial != target_binomial and old_binomial not in result["synonyms"]:
            result["synonyms"].append(old_binomial)

        # Also capture historical names cited within this same entry's text span.
        # e.g. an entry may say "•Synonym of Phoxinus erythrogaster ... •Synonym of
        # Chrosomus erythrogaster" — the earlier name is also a synonym of the target.
        entry_text = text[hdr.start():status_m.end()]
        for other_m in SYNONYM_OF_RE.finditer(entry_text):
            other_binomial = other_m.group(1)
            if (other_binomial != target_binomial
                    and other_binomial not in result["synonyms"]):
                result["synonyms"].append(other_binomial)

    # 2. Reclassifications: "Valid as <target>" where genus differs
    #    e.g. querying Nothonotus juliae → entry "juliae, Etheostoma ... Valid as Nothonotus juliae"
    for status_m in re.finditer(r'Valid as ' + re.escape(target_binomial), text):
        hdr = last_header_before(status_m.start())
        if not hdr:
            continue
        old_genus    = hdr.group(2)
        old_binomial = f"{old_genus} {hdr.group(1)}"
        if old_genus != target_genus and old_binomial != target_binomial \
                and old_binomial not in result["synonyms"]:
            result["synonyms"].append(old_binomial)

        # Also capture other genus placements cited within this entry's text span.
        # e.g. querying Rhizoprionodon terraenovae → entry "terraenovae, Squalus"
        # contains both "Valid as Scoliodon terraenovae" and "Valid as Rhizoprionodon
        # terraenovae" — the Scoliodon placement is also an old synonym.
        entry_text = text[hdr.start():status_m.end()]
        valid_as_re = re.compile(
            r'Valid as ([A-Z][a-z]+) ' + re.escape(target_species)
        )
        for other_m in valid_as_re.finditer(entry_text):
            other_genus    = other_m.group(1)
            other_binomial = f"{other_genus} {target_species}"
            if (other_genus != target_genus
                    and other_binomial != target_binomial
                    and other_binomial not in result["synonyms"]):
                result["synonyms"].append(other_binomial)

    return result


# ── Genus-transfer fallback ───────────────────────────────────────────────────

def _find_original_genus(
    family: str, epithet: str, afs_genus: str, session: requests.Session
) -> str | None:
    """
    When a species query returns empty (genus transfer), query by family+epithet
    and look for "Valid as <afs_genus> <epithet>" to find the original genus.
    Returns the original genus name, or None if not found.
    """
    if not family:
        return None
    params = {"tbl": "species", "family": family, "species": epithet}
    try:
        r = session.get(BASE_URL, params=params, headers=HEADERS, timeout=30)
        r.raise_for_status()
    except requests.RequestException:
        return None

    soup = BeautifulSoup(r.text, "html.parser")
    text = soup.get_text(separator=" ")
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'\s+,', ',', text)

    # Look for "Valid as <afs_genus> <epithet>" and find the entry header before it
    target_pattern = re.compile(
        r'Valid as ' + re.escape(afs_genus) + r' ' + re.escape(epithet)
    )

    for vm in target_pattern.finditer(text):
        # Find nearest entry header before this "Valid as" match
        best = None
        for hm in ENTRY_HEADER_RE.finditer(text[:vm.start()]):
            best = hm
        if best and best.group(1).lower() == epithet.lower():
            orig_genus = best.group(2)
            if orig_genus != afs_genus:
                return orig_genus

    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Status lines contain "→" and scraped names contain accented characters; the
    # default Windows console codec (cp1252) cannot encode either and would abort
    # a multi-hour scrape mid-run.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    if not DATA_PATH.exists():
        print(f"ERROR: {DATA_PATH} not found. Run parse_pdf.py first.")
        sys.exit(1)

    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)

    species_list = list(data["valid_names"].keys())
    print(f"Loaded {len(species_list)} species from fish_names.json")

    # Valid extralimital species that must never be recorded as synonyms
    # (Reviewer 1, round 2 — e.g. Misgurnus fossilis). See extralimital_valids.json.
    extralimital_valids: set[str] = set()
    if EXTRALIMITAL_PATH.exists():
        with open(EXTRALIMITAL_PATH, encoding="utf-8") as f:
            extralimital_valids = set(json.load(f).keys())
        print(f"Loaded {len(extralimital_valids)} extralimital valids to exclude from synonyms")

    rebuild_only = "--rebuild-only" in sys.argv
    # --merge keeps the existing synonym map and folds in only the entries for
    # names missing from it (i.e. species the addenda just added). This is the
    # production path: it gives a surgical diff on a 2 MB generated file and
    # cannot drop a synonym it never touched. The full rebuild stays available
    # as the verification path — the two must converge.
    merge = "--merge" in sys.argv

    # Load or initialise cache
    if CACHE_PATH.exists():
        with open(CACHE_PATH, encoding="utf-8") as f:
            cache = json.load(f)
        print(f"Resuming — {len(cache)} species already cached")
    else:
        cache = {}

    remaining = [s for s in species_list if s not in cache]
    if rebuild_only:
        print("--rebuild-only: skipping scrape; rebuilding synonym map from cache")
        remaining = []
    print(f"{len(remaining)} species left to query  (~{len(remaining)//60} min at 1 req/s)\n")

    session = requests.Session()

    for i, binomial in enumerate(remaining, 1):
        genus, epithet = binomial.split(" ", 1)
        print(f"[{i}/{len(remaining)}] {binomial} ...", end=" ", flush=True)

        html = fetch_species(genus, epithet, session)
        if html is not None:
            entry = parse_results(html, genus, epithet)

            # If no results and species was a genus transfer (parenthesized author),
            # try querying by family + epithet to find the original genus, then retry.
            if (not entry["synonyms"] and not entry["current_name"]
                    and data["valid_names"][binomial].get("author", "").startswith("(")):
                orig_genus = _find_original_genus(
                    data["valid_names"][binomial].get("family", ""),
                    epithet, genus, session
                )
                if orig_genus:
                    print(f"(retry as {orig_genus}) ", end="", flush=True)
                    time.sleep(DELAY)
                    retry_html = fetch_species(orig_genus, epithet, session)
                    if retry_html:
                        entry = parse_results(retry_html, genus, epithet)
                        old_binomial = f"{orig_genus} {epithet}"
                        if old_binomial not in entry["synonyms"] and old_binomial != binomial:
                            entry["synonyms"].append(old_binomial)

            cache[binomial] = entry
            status = "valid" if entry["valid"] else f"→ {entry['current_name'] or '?'}"
            print(f"{status}  ({len(entry['synonyms'])} synonyms)")
        else:
            cache[binomial] = {"valid": None, "current_name": "", "synonyms": []}
            print("FAILED")

        # Periodic save + longer pause to avoid rate-limiting
        if i % PAUSE_EVERY == 0:
            _save_cache(cache)
            print(f"  [cache saved — {len(cache)} entries total; pausing {PAUSE_SECS}s ...]")
            time.sleep(PAUSE_SECS)
        else:
            time.sleep(DELAY)

    _save_cache(cache)
    print(f"\nAll queries done. Building synonym map ...")

    # Build synonym map: old_binomial → current AFS valid name
    # --merge starts from what is already shipped and only adds what is missing.
    synonyms: dict[str, str] = dict(data.get("synonyms", {})) if merge else {}
    mismatches: list[tuple[str, str]] = []

    # The cache is keyed by the name that was queried, so after the addenda demotes
    # a name (e.g. Beringraja rhina -> Caliraja rhina) its cache entry survives and
    # still points at a name that is no longer valid. Retarget those entries rather
    # than dropping them — the synonyms they carry (7 for Galeocerdo cuvier alone)
    # are legitimate and exist nowhere else.
    _overlay = addenda_overlay.load_overlay()
    demotions = ({r["from"]: r["to"] for r in _overlay["renames"]}
                 if _overlay is not None else {})

    for binomial, entry in cache.items():
        binomial = demotions.get(binomial, binomial)
        if binomial not in data["valid_names"]:
            continue  # withdrawn from the List, or otherwise stale
        if entry.get("valid") is None:
            continue  # failed request; skip

        for old_name in entry.get("synonyms", []):
            # Only add as synonym if it's not already a valid AFS name, and not a
            # valid extralimital species (Reviewer 1, round 2). Without the second
            # guard a valid non-North-American species (e.g. Misgurnus fossilis) is
            # mislabeled as an "outdated synonym" of an AFS congener.
            if old_name not in data["valid_names"] and old_name not in extralimital_valids:
                # In merge mode never clobber an existing edge — it may have been
                # retargeted by the addenda overlay and the cache still holds the
                # pre-addenda target.
                if merge and old_name in synonyms:
                    continue
                synonyms[old_name] = binomial

        # Track names AFS considers valid that Eschmeyer considers outdated
        current = entry.get("current_name", "")
        if not entry.get("valid") and current and current != binomial:
            mismatches.append((binomial, current))

    # Write enriched fish_names.json
    data["synonyms"] = synonyms
    data["metadata"]["synonym_source"] = "Eschmeyer's Catalog of Fishes"
    data["metadata"]["synonym_count"]  = len(synonyms)
    data["metadata"]["extralimital_excluded"] = sorted(extralimital_valids)
    data["metadata"]["synonym_generated"] = datetime.date.today().isoformat()

    # Re-assert the addenda synonym layer. Rebuilding the map above would otherwise
    # revert the demotions, retargeting and curated pairs. Any script that writes
    # data["synonyms"] must do this — same reasoning as the extralimital filter.
    if _overlay is not None:
        stats = addenda_overlay.apply_synonyms(data, _overlay)
        addenda_overlay.stamp_metadata(data, _overlay, stats)
        synonyms = data["synonyms"]
        print(f"  Addenda overlay re-applied: {stats['demoted']} demoted, "
              f"{stats['retargeted']} retargeted, {stats['curated']} curated, "
              f"{stats['dangling_dropped']} dangling dropped")
        errs = addenda_overlay.check_invariants(data, _overlay)
        if errs:
            print("\nINVARIANT FAILURES — nothing written:", file=sys.stderr)
            for e in errs:
                print(f"  - {e}", file=sys.stderr)
            sys.exit(1)

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\nfish_names.json updated.")
    print(f"  Synonyms added  : {len(synonyms)}")
    print(f"  Name mismatches : {len(mismatches)}  (AFS valid != Eschmeyer valid)")

    if mismatches:
        print("\n  First 10 mismatches:")
        for afs, esch in mismatches[:10]:
            print(f"    AFS: {afs:<35s}  Eschmeyer: {esch}")
        if len(mismatches) > 10:
            print(f"    ... and {len(mismatches) - 10} more (see eschmeyer_cache.json)")


def _save_cache(cache: dict) -> None:
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
