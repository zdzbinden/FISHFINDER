#!/usr/bin/env python3
"""
scrape_eschmeyer.py — Enrich fish_names.json with synonym data from
Eschmeyer's Catalog of Fishes.
https://researcharchive.calacademy.org/research/ichthyology/catalog/

For each valid species in fish_names.json, queries the catalog and collects:
  - synonyms (older names that map to the current accepted name)
  - any cases where the AFS 8th ed. name differs from Eschmeyer's accepted name

Results are cached two ways, and the distinction matters:
  - eschmeyer_cache.json  — PARSED results, one entry per species
  - eschmeyer_text/       — the normalized page TEXT the parser ran on
Only the second lets a parser fix be replayed offline (--reparse). The first
alone does not: it already contains whatever the old parser produced.

Interrupted runs resume cleanly from either. A cold run over all ~5,200 species
takes roughly 4.5-5.5 hours — 5,096 x 2 s plus 104 x 15 s of pauses is already
~3 h 16 m of sleeping before per-request latency. With a warm cache only the new
binomials are fetched.

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
        --reparse        re-run the parser over eschmeyer_text/ with no network,
                         then rebuild. Use after any parser change.
        --dry-run        scrape and rebuild, but do NOT write fish_names.json;
                         dump the proposed map to synonyms_dryrun.json instead.
        --accessed=DATE  record YYYY-MM-DD as the date the catalog was queried
                         (metadata.synonym_accessed, shown in the site citation).
"""

import datetime
import gzip
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
# Normalized page text, one gzipped JSON file per species. eschmeyer_cache.json
# holds only PARSED results, so a parser bug used to cost a full ~5 h re-fetch to
# correct. With this, a parser change replays offline via --reparse.
TEXT_CACHE_DIR = Path(__file__).parent / "eschmeyer_text"

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
#
# The leading (?<![A-Za-z-]) is load-bearing. Without it the scan can start in the
# MIDDLE of a capitalized word and read its tail as an epithet, because type-locality
# prose satisfies the whole pattern including the "Word [" lookahead:
#   "Unalaska Island, Bering Sea [North Pacific]"  ->  ('sland', 'Bering')
#   "...Cove, Isabela Island [Albemarle]"          ->  ('ove',   'Isabela')
# That shipped 36 junk synonyms before it was caught. A bare \b is NOT sufficient —
# it still admits hyphenated place names ("Ponta-delgada, Santa Maria [...]").
#
# Group 3 is the optional middle token of a TRINOMIAL header:
#   "hawaiensis, Argyropelecus lynchus Schultz [L. P.] 1961"
# Subspecies entries were previously invisible, so their status lines were attributed
# to whatever entry preceded them. Callers use groups 1 and 2 only, which keeps the
# emitted name "Genus epithet" (Argyropelecus hawaiensis); group 3 exists so the
# header is SEEN, which is what stops the mis-attribution.
def entry_header_re(epithet: str | None = None) -> re.Pattern:
    """
    Compile an entry-header pattern. Pass `epithet` to pin it to one epithet
    (rescrape_transfers.py does this); omit it to match any header.

    Shared so the two scrapers cannot drift apart — they previously carried
    separate copies and only one of them got fixed.
    """
    first = re.escape(epithet) if epithet else r'[a-z][a-z-]+'
    # Author token in the lookahead is [A-Z][^\s\[]* , not [A-Z][a-z]+ : catalog
    # authors are routinely non-ASCII (Lütken, Günther, Lacepède), and the pages
    # additionally arrive with encoding damage ("G?nther"). Requiring ASCII there
    # left 324 pages with NO matchable header at all, so their synonyms were only
    # ever harvested by accident, via a spurious header. Tolerating the author
    # rescues 250 of them. The anchor above is what rejects prose, not this token.
    return re.compile(
        r'(?<![A-Za-z-])(' + first + r'),\s+([A-Z][a-z]+)(?:\s+([a-z][a-z-]+))?'
        r'(?=(?:\s+\([A-Z][a-z]+\))?\s+[A-Z][^\s\[]*\s+\[)'
    )


ENTRY_HEADER_RE = entry_header_re()


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

def _text_path(binomial: str) -> Path:
    return TEXT_CACHE_DIR / (binomial.replace(" ", "_") + ".json.gz")


def save_text(binomial: str, genus: str, epithet: str, text: str,
              retry_genus: str | None = None) -> None:
    """
    Persist the normalized page text that produced this species' cache entry.

    `retry_genus` records the genus-transfer fallback, so --reparse can reproduce
    the extra synonym the scrape loop appends outside parse_text().
    """
    TEXT_CACHE_DIR.mkdir(exist_ok=True)
    payload = {"binomial": binomial, "genus": genus, "epithet": epithet,
               "retry_genus": retry_genus, "text": text}
    with gzip.open(_text_path(binomial), "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)


def load_text(binomial: str) -> dict | None:
    """Return the stored payload for one species, or None if not cached."""
    p = _text_path(binomial)
    if not p.exists():
        return None
    with gzip.open(p, "rt", encoding="utf-8") as f:
        return json.load(f)


def normalize_html(html: str) -> str:
    """
    Flatten a catalog page to the single-line string every parser rule works on.

    This is the only thing parse_text() needs, so it is what the text cache
    stores — not the HTML.
    """
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(separator=" ")
    text = re.sub(r'\s+', ' ', text)       # collapse all whitespace to single spaces
    text = re.sub(r'\s+,', ',', text)      # fix "word , word" from tag-boundary spaces
    return text


def parse_results(html: str, target_genus: str, target_species: str) -> dict:
    """Parse a catalog result page for one genus+species query."""
    return parse_text(normalize_html(html), target_genus, target_species)


def parse_text(text: str, target_genus: str, target_species: str) -> dict:
    """
    Parse normalized page text for one genus+species query.

    Returns a dict:
        valid        – True if Eschmeyer considers this the accepted name
        current_name – accepted binomial (may differ from AFS name)
        synonyms     – list of older binomials that map to this species
    """
    # `from_trinomial` lists the subset of `synonyms` that came from a SUBSPECIES
    # header, where "Genus species subspecies" is flattened to "Genus subspecies".
    # That flattening can manufacture a binomial belonging to a different fish:
    # "auratus, Cyprinus tinca" (a variety of tench) flattens to "Cyprinus auratus",
    # which is Linnaeus's goldfish. The map build uses this to let a real binomial
    # always outrank a flattened subspecies.
    result = {"valid": False, "current_name": "", "synonyms": [], "from_trinomial": []}

    # Epithet fragment. The trailing (?:-[a-z]+)* is required for hyphenated
    # epithets: a bare [a-z]+ truncates "x-punctatus" to "x", which produced
    # phantom names like "Hybopsis x" and "Astroscopus y".
    EPITHET = r'[a-z]+(?:-[a-z]+)*'

    # "Current status: Valid as Genus species"
    m = re.search(r'Current status[:\s]+Valid as\s+([A-Z][a-z]+\s+' + EPITHET + r')', text)
    if m:
        result["valid"] = True
        result["current_name"] = m.group(1)

    # "Current status: Synonym of Genus species"
    m = re.search(r'Current status[:\s]+Synonym of\s+([A-Z][a-z]+\s+' + EPITHET + r')', text)
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

    SYNONYM_OF_RE = re.compile(r'Synonym of ([A-Z][a-z]+ ' + EPITHET + r')')

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
            if hdr.group(3):
                result["from_trinomial"].append(old_binomial)

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
            if hdr.group(3):
                result["from_trinomial"].append(old_binomial)

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

    # Eschmeyer is keyed by ITS OWN spelling. For a species the addenda renamed,
    # that is the PRE-addenda name: querying "Galeocerdo cuvieri" returns an empty
    # page because the catalog says "Galeocerdo cuvier". A warm cache used to hide
    # this — it still held entries under the old keys, which the map build below
    # retargets via `demotions`. A cold scrape has no such entries, so those
    # species silently lose every synonym (6 of the 22 renames, 16 edges).
    # Fetch the pre-addenda names too and let the existing retargeting fold them in.
    _renames = addenda_overlay.load_overlay()
    pre_addenda_names = [r["from"] for r in _renames["renames"]
                         if r["from"] not in data["valid_names"]] if _renames else []
    post_addenda = ({r["from"]: r["to"] for r in _renames["renames"]}
                    if _renames else {})
    scrape_list = species_list + pre_addenda_names
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
    # --reparse: rebuild the parsed cache from stored page text, no network.
    reparse = "--reparse" in sys.argv
    # --dry-run: do everything except overwrite fish_names.json; dump the proposed
    # synonym map so it can be diffed first.
    dry_run = "--dry-run" in sys.argv
    # --accessed=YYYY-MM-DD backfills the date the catalog was actually queried,
    # for a rebuild that runs offline after the fetch happened on an earlier day.
    accessed_override = next(
        (a.split("=", 1)[1] for a in sys.argv if a.startswith("--accessed=")), None)

    # Load or initialise cache
    if CACHE_PATH.exists():
        with open(CACHE_PATH, encoding="utf-8") as f:
            cache = json.load(f)
        print(f"Resuming — {len(cache)} species already cached")
    else:
        cache = {}

    # --reparse re-runs the parser over the stored page text with no network, then
    # rebuilds. This is the path for a parser fix: it replays in seconds instead of
    # a ~5 h re-fetch. Requires a text cache built by an earlier scrape.
    if reparse:
        if not TEXT_CACHE_DIR.exists():
            print(f"ERROR: --reparse needs {TEXT_CACHE_DIR.name}/, which does not exist.")
            print("It is populated by a normal scrape. Nothing to replay.")
            sys.exit(1)
        n_reparsed = n_missing = 0
        for binomial in scrape_list:
            payload = load_text(binomial)
            if payload is None:
                n_missing += 1
                continue
            entry = parse_text(payload["text"], payload["genus"], payload["epithet"])
            if payload.get("retry_genus"):
                old_binomial = f"{payload['retry_genus']} {payload['epithet']}"
                if old_binomial not in entry["synonyms"] and old_binomial != binomial:
                    entry["synonyms"].append(old_binomial)
            cache[binomial] = entry
            n_reparsed += 1
        print(f"--reparse: re-parsed {n_reparsed} species from stored text"
              + (f"; {n_missing} had no stored text (left as-is)" if n_missing else ""))
        _save_cache(cache)

    remaining = [s for s in scrape_list if s not in cache]
    if rebuild_only or reparse:
        print("skipping scrape; rebuilding synonym map from cache")
        remaining = []
    print(f"{len(remaining)} species left to query  (~{len(remaining)//60} min at 1 req/s)\n")

    session = requests.Session()

    for i, binomial in enumerate(remaining, 1):
        genus, epithet = binomial.split(" ", 1)
        print(f"[{i}/{len(remaining)}] {binomial} ...", end=" ", flush=True)

        html = fetch_species(genus, epithet, session)
        if html is not None:
            text = normalize_html(html)
            entry = parse_text(text, genus, epithet)
            used_retry_genus = None

            # If no results and species was a genus transfer (parenthesized author),
            # try querying by family + epithet to find the original genus, then retry.
            # For a pre-addenda name there is no valid_names record of its own, so
            # fall back to its post-addenda counterpart's author/family — otherwise
            # the fallback never fires and the species keeps zero synonyms.
            meta = data["valid_names"].get(binomial)
            if meta is None:
                meta = data["valid_names"].get(post_addenda.get(binomial, ""), {})
            if (not entry["synonyms"] and not entry["current_name"]
                    and meta.get("author", "").startswith("(")):
                orig_genus = _find_original_genus(
                    meta.get("family", ""),
                    epithet, genus, session
                )
                if orig_genus:
                    print(f"(retry as {orig_genus}) ", end="", flush=True)
                    time.sleep(DELAY)
                    retry_html = fetch_species(orig_genus, epithet, session)
                    if retry_html:
                        text = normalize_html(retry_html)
                        entry = parse_text(text, genus, epithet)
                        used_retry_genus = orig_genus
                        old_binomial = f"{orig_genus} {epithet}"
                        if old_binomial not in entry["synonyms"] and old_binomial != binomial:
                            entry["synonyms"].append(old_binomial)

            # Store the text that produced this entry, so --reparse is faithful.
            save_text(binomial, genus, epithet, text, used_retry_genus)
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

    # Two passes. A name flattened from a subspecies header ("Cyprinus tinca
    # auratus" -> "Cyprinus auratus") can collide with a real binomial belonging to
    # a different fish (Linnaeus's goldfish). Since first writer wins below, every
    # binomial-derived claim is laid down before any trinomial-derived one, so a
    # real name always outranks a flattened subspecies. 10 names collide this way.
    # Collect (target, name, is_flattened) once, then lay the claims down in two
    # passes so ordering is explicit rather than a side effect of cache order.
    claims: list[tuple[str, str, bool]] = []
    for binomial, entry in cache.items():
        binomial = demotions.get(binomial, binomial)
        if binomial not in data["valid_names"]:
            continue  # withdrawn from the List, or otherwise stale
        if entry.get("valid") is None:
            continue  # failed request; skip

        flattened = set(entry.get("from_trinomial", []))
        for old_name in entry.get("synonyms", []):
            # Drop epithets under 3 characters. These are source-side data errors
            # in the catalog ("um, Balistes Montrouzier [X.] 1857" — the epithet is
            # literally "um"), and engine.js's classifyName rejects anything shorter
            # than 3 anyway, so nothing usable is lost.
            parts = old_name.split()
            if len(parts) != 2 or len(parts[1]) < 3:
                continue
            claims.append((binomial, old_name, old_name in flattened))

        # Track names AFS considers valid that Eschmeyer considers outdated
        current = entry.get("current_name", "")
        if not entry.get("valid") and current and current != binomial:
            mismatches.append((binomial, current))

    for flattened_pass in (False, True):
        for binomial, old_name, is_flattened in claims:
            if is_flattened != flattened_pass:
                continue
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
                # A flattened subspecies never displaces a real binomial. Within a
                # pass the original last-writer-wins order is preserved, so this
                # change affects only binomial-vs-trinomial ties.
                if flattened_pass and old_name in synonyms:
                    continue
                synonyms[old_name] = binomial

    # Write enriched fish_names.json
    data["synonyms"] = synonyms
    data["metadata"]["synonym_source"] = "Eschmeyer's Catalog of Fishes"
    data["metadata"]["synonym_count"]  = len(synonyms)
    data["metadata"]["extralimital_excluded"] = sorted(extralimital_valids)
    data["metadata"]["synonym_generated"] = datetime.date.today().isoformat()

    # The date the catalog was actually queried over the network. This is what the
    # site's Eschmeyer citation renders, so it must NOT move on an offline rebuild
    # (--reparse / --rebuild-only do no fetching). synonym_generated does move, and
    # citing it would overstate when the data was last checked against the source.
    if accessed_override:
        data["metadata"]["synonym_accessed"] = accessed_override
    elif remaining:
        data["metadata"]["synonym_accessed"] = datetime.date.today().isoformat()
    elif "synonym_accessed" not in data["metadata"]:
        data["metadata"]["synonym_accessed"] = data["metadata"]["synonym_generated"]

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

    if dry_run:
        # Caches are still written (the scrape's work is never thrown away); only
        # fish_names.json is left alone, so the new map can be diffed against the
        # shipped one before anything is overwritten.
        out = Path(__file__).parent / "synonyms_dryrun.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data["synonyms"], f, ensure_ascii=False, indent=2, sort_keys=True)
        print(f"\n--dry-run: fish_names.json NOT written.")
        print(f"  Proposed map ({len(synonyms)} synonyms) written to {out.name} for diffing.")
        print(f"  Name mismatches : {len(mismatches)}  (AFS valid != Eschmeyer valid)")
        return

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
