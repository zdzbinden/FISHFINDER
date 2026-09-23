#!/usr/bin/env python3
"""
rescrape_transfers.py — Re-scrape genus-transfer species that returned empty
results because Eschmeyer files them under the original description genus.

Strategy: query the family page and extract just the matching epithet entry.

This script rewrites data["synonyms"] wholesale, so it re-applies the 2025
Addenda overlay afterwards (addenda_overlay.apply_synonyms). Any future script
that writes that key must do the same or it will silently revert the addenda.

Usage:
    uv run --with requests --with beautifulsoup4 python rescrape_transfers.py
"""

import json
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

import addenda_overlay

DATA_PATH  = Path(__file__).parent / "fishfinder" / "data" / "fish_names.json"
CACHE_PATH = Path(__file__).parent / "eschmeyer_cache.json"
EXTRALIMITAL_PATH = Path(__file__).parent / "extralimital_valids.json"

BASE_URL = (
    "https://researcharchive.calacademy.org"
    "/research/ichthyology/catalog/fishcatget.asp"
)
HEADERS = {
    "User-Agent": (
        "FishNameChecker/1.0 (scientific research tool; "
        "contact via https://github.com/zdzbinden/FISHFINDER)"
    )
}
DELAY = 2.0


def fetch_family_species(family: str, epithet: str, session: requests.Session) -> str | None:
    """Fetch the family page and return the HTML, or None on failure."""
    params = {"tbl": "species", "family": family, "species": epithet}
    try:
        r = session.get(BASE_URL, params=params, headers=HEADERS, timeout=30)
        r.raise_for_status()
        return r.text
    except requests.RequestException as e:
        print(f"  FAILED: {e}")
        return None


def parse_for_genus_transfer(html: str, target_genus: str, target_epithet: str) -> set[str]:
    """
    Parse a family+epithet result page looking for entries that reference the
    target genus (AFS name). Collects the original genus as a synonym.
    """
    from scrape_eschmeyer import entry_header_re

    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(separator=" ")
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'\s+,', ',', text)

    # Find entry headers matching our epithet. Built by the shared helper so this
    # copy carries the mid-word anchor and trinomial support too — an epithet like
    # "alia" would otherwise match inside "Somalia, Raja ...".
    ENTRY_HEADER = entry_header_re(target_epithet)

    original_genera = set()
    for m in ENTRY_HEADER.finditer(text):
        original_genus = m.group(2)
        if original_genus != target_genus:
            original_genera.add(original_genus)

    if not original_genera:
        # Try a simpler pattern — look for "Valid as <target_genus> <epithet>"
        valid_as = re.findall(
            r'Valid as ' + re.escape(target_genus) + r' ' + re.escape(target_epithet),
            text
        )
        if valid_as:
            # Find the entry header before each "Valid as" match
            for vm in re.finditer(
                r'Valid as ' + re.escape(target_genus) + r' ' + re.escape(target_epithet),
                text
            ):
                # Look backwards for any "epithet, Genus" header. Uses the shared
                # strict pattern: this fallback previously matched a bare
                # "word, Capitalized" anywhere in the page, so ordinary prose could
                # supply the "original genus".
                before = text[:vm.start()]
                hdr_matches = list(entry_header_re().finditer(before))
                if hdr_matches:
                    last_hdr = hdr_matches[-1]
                    orig_g = last_hdr.group(2)
                    if orig_g != target_genus:
                        original_genera.add(orig_g)

    return original_genera


def main():
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    with open(CACHE_PATH, encoding="utf-8") as f:
        cache = json.load(f)

    # Find genus-transfer species with empty results
    transfers = [
        (k, v) for k, v in data["valid_names"].items()
        if v.get("author", "").startswith("(")
    ]
    empty = [
        k for k, v in transfers
        if k in cache
        and not cache[k].get("synonyms")
        and not cache[k].get("current_name")
    ]

    print(f"Found {len(empty)} genus-transfer species with empty cache results.\n")
    if not empty:
        print("Nothing to do.")
        return

    session = requests.Session()
    updated = 0

    for i, binomial in enumerate(empty, 1):
        genus, epithet = binomial.split(" ", 1)
        family = data["valid_names"][binomial].get("family", "")
        print(f"[{i}/{len(empty)}] {binomial} (family={family}) ...", end=" ", flush=True)

        if not family:
            print("no family — skip")
            continue

        html = fetch_family_species(family, epithet, session)
        if not html:
            continue

        original_genera = parse_for_genus_transfer(html, genus, epithet)

        if original_genera:
            # Re-query with the original genus to get full synonym data
            for orig_genus in original_genera:
                print(f"\n  retrying as {orig_genus} {epithet} ...", end=" ", flush=True)
                time.sleep(DELAY)

                from scrape_eschmeyer import fetch_species, parse_results
                retry_html = fetch_species(orig_genus, epithet, session)
                if retry_html:
                    entry = parse_results(retry_html, genus, epithet)
                    # Also add the original genus placement as a synonym
                    old_binomial = f"{orig_genus} {epithet}"
                    if old_binomial not in entry["synonyms"] and old_binomial != binomial:
                        entry["synonyms"].append(old_binomial)
                    cache[binomial] = entry
                    print(f"OK ({len(entry['synonyms'])} synonyms: {entry['synonyms'][:3]})")
                    updated += 1
                    break
        else:
            print("no original genus found")

        time.sleep(DELAY)

    # Save cache
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    print(f"\nCache saved. Updated {updated} entries.")

    # Rebuild synonyms in fish_names.json. Exclude valid extralimital species
    # (Reviewer 1, round 2) so they are never mislabeled as synonyms — mirrors
    # the guard in scrape_eschmeyer.py. See extralimital_valids.json.
    extralimital_valids = set()
    if EXTRALIMITAL_PATH.exists():
        with open(EXTRALIMITAL_PATH, encoding="utf-8") as f:
            extralimital_valids = set(json.load(f).keys())

    # The cache is keyed by the name that was queried, so after an addendum demotes
    # a name its cache entry survives pointing at a name that is no longer valid.
    # Retarget rather than skip — the synonyms those entries carry are legitimate
    # and exist nowhere else. Mirrors the same block in scrape_eschmeyer.py.
    overlay = addenda_overlay.load_overlay()
    demotions = ({r["from"]: r["to"] for r in overlay["renames"]}
                 if overlay is not None else {})

    synonyms = {}
    for binomial, entry in cache.items():
        binomial = demotions.get(binomial, binomial)
        if binomial not in data["valid_names"]:
            continue  # withdrawn from the List, or otherwise stale
        if entry.get("valid") is None:
            continue
        for old_name in entry.get("synonyms", []):
            if old_name not in data["valid_names"] and old_name not in extralimital_valids:
                synonyms[old_name] = binomial

    data["synonyms"] = synonyms
    data["metadata"]["synonym_count"] = len(synonyms)

    # Re-assert the addenda overlay: this rebuild would otherwise revert the
    # demotions, retargeting and curated pairs. Same obligation as the
    # extralimital filter above — every writer of data["synonyms"] must do it.
    if overlay is not None:
        stats = addenda_overlay.apply_synonyms(data, overlay)
        addenda_overlay.stamp_metadata(data, overlay, stats)
        synonyms = data["synonyms"]
        print(f"Addenda overlay re-applied: {stats['demoted']} demoted, "
              f"{stats['retargeted']} retargeted, {stats['curated']} curated.")
        errs = addenda_overlay.check_invariants(data, overlay)
        if errs:
            print("\nINVARIANT FAILURES — nothing written:", file=sys.stderr)
            for e in errs:
                print(f"  - {e}", file=sys.stderr)
            sys.exit(1)

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"fish_names.json updated with {len(synonyms)} synonyms.")


if __name__ == "__main__":
    main()
