#!/usr/bin/env python3
"""
scrape_eschmeyer.py — Enrich fish_names.json with synonym data from
Eschmeyer's Catalog of Fishes.
https://researcharchive.calacademy.org/research/ichthyology/catalog/

For each valid species in fish_names.json, queries the catalog and collects:
  - synonyms (older names that map to the current accepted name)
  - any cases where the AFS 8th ed. name differs from Eschmeyer's accepted name

Results are cached to eschmeyer_cache.json so interrupted runs resume cleanly.
Running all ~5,300 species takes ~90 minutes at 1 req/sec.

Usage:
    uv run --with requests --with beautifulsoup4 python scrape_eschmeyer.py
"""

import json
import re
import sys
import time
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("ERROR: missing dependencies.")
    print("Run: uv run --with requests --with beautifulsoup4 python scrape_eschmeyer.py")
    sys.exit(1)

DATA_PATH  = Path(__file__).parent / "fishfinder" / "data" / "fish_names.json"
CACHE_PATH = Path(__file__).parent / "eschmeyer_cache.json"

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
        "contact via https://github.com/zdzbinden/fish-name-checker)"
    )
}


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
                # Fresh session in case the connection was closed by the server
                session.close()
                session.__init__()
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

    # Require "Author [" after the genus (with optional subgenus) to avoid
    # matching geographic text like "Bay, California" or "sections, Families".
    ENTRY_HEADER  = re.compile(
        r'([a-z][a-z-]+),\s+([A-Z][a-z]+)'
        r'(?=(?:\s+\([A-Z][a-z]+\))?\s+[A-Z][a-z]+\s+\[)'
    )
    SYNONYM_OF_RE = re.compile(r'Synonym of ([A-Z][a-z]+ [a-z]+)')

    def last_header_before(pos):
        """Return (epithet, genus) of the entry header nearest before `pos`."""
        best = None
        for m in ENTRY_HEADER.finditer(text[:pos]):
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


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not DATA_PATH.exists():
        print(f"ERROR: {DATA_PATH} not found. Run parse_pdf.py first.")
        sys.exit(1)

    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)

    species_list = list(data["valid_names"].keys())
    print(f"Loaded {len(species_list)} species from fish_names.json")

    # Load or initialise cache
    if CACHE_PATH.exists():
        with open(CACHE_PATH, encoding="utf-8") as f:
            cache = json.load(f)
        print(f"Resuming — {len(cache)} species already cached")
    else:
        cache = {}

    remaining = [s for s in species_list if s not in cache]
    print(f"{len(remaining)} species left to query  (~{len(remaining)//60} min at 1 req/s)\n")

    session = requests.Session()

    for i, binomial in enumerate(remaining, 1):
        genus, epithet = binomial.split(" ", 1)
        print(f"[{i}/{len(remaining)}] {binomial} ...", end=" ", flush=True)

        html = fetch_species(genus, epithet, session)
        if html is not None:
            entry = parse_results(html, genus, epithet)
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
    synonyms: dict[str, str] = {}
    mismatches: list[tuple[str, str]] = []

    for binomial, entry in cache.items():
        if entry.get("valid") is None:
            continue  # failed request; skip

        for old_name in entry.get("synonyms", []):
            # Only add as synonym if it's not already a valid AFS name
            if old_name not in data["valid_names"]:
                synonyms[old_name] = binomial

        # Track names AFS considers valid that Eschmeyer considers outdated
        current = entry.get("current_name", "")
        if not entry.get("valid") and current and current != binomial:
            mismatches.append((binomial, current))

    # Write enriched fish_names.json
    data["synonyms"] = synonyms
    data["metadata"]["synonym_source"] = "Eschmeyer's Catalog of Fishes"
    data["metadata"]["synonym_count"]  = len(synonyms)

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\nfish_names.json updated.")
    print(f"  Synonyms added  : {len(synonyms)}")
    print(f"  Name mismatches : {len(mismatches)}  (AFS valid ≠ Eschmeyer valid)")

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
