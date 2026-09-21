#!/usr/bin/env python3
"""Apply the 2025 Addenda overlay to fishfinder/data/fish_names.json.

Runs after parse_pdf.py and before scrape_eschmeyer.py, so the new species exist
in valid_names when the scraper builds its work list:

    uv run --with pymupdf python parse_pdf.py
    python apply_addenda.py
    uv run --with requests --with beautifulsoup4 python scrape_eschmeyer.py --merge

Idempotent — re-running is a no-op. fish_names.json is a generated artifact, so
this writes it via a script rather than by hand.

Usage:
    python apply_addenda.py [--dry-run] [--synonyms-only]
"""
import argparse
import json
import sys
from pathlib import Path

import addenda_overlay as ao

ROOT    = Path(__file__).parent
DB_PATH = ROOT / "fishfinder" / "data" / "fish_names.json"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="report the full ledger and write nothing")
    ap.add_argument("--synonyms-only", action="store_true",
                    help="re-assert only the synonym layer (Phase B)")
    args = ap.parse_args()

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ov = ao.load_overlay()
    if ov is None:
        print(f"ERROR: {ao.OVERLAY_PATH.name} not found. "
              f"Run parse_addenda.py first.", file=sys.stderr)
        return 1

    with open(DB_PATH, encoding="utf-8") as f:
        data = json.load(f)

    before = {"species": len(data["valid_names"]),
              "genera": len(data.get("genera", [])),
              "synonyms": len(data.get("synonyms", {}))}

    state = "ALREADY APPLIED" if ao.is_applied(data, ov) else "FRESH"
    print(f"Overlay {ov['data_version']} ({ov['source']['doi']}) — {state}")
    print(f"Before: {before['species']} species, {before['genera']} genera, "
          f"{before['synonyms']} synonyms")

    tax = {}
    if not args.synonyms_only:
        tax = ao.apply_taxonomy(data, ov)
        print(f"  taxonomy: +{tax['added']} added, {tax['renamed']} renamed, "
              f"{tax['updated']} updated, {tax['removed']} removed"
              + (f", {tax['drift']} DRIFT" if tax["drift"] else ""))

    syn = ao.apply_synonyms(data, ov)
    print(f"  synonyms: {syn['demoted']} demoted, {syn['retargeted']} retargeted, "
          f"{syn['conflicts_removed']} conflict(s) removed, "
          f"{syn['curated']} curated, {syn['misspellings']} table-typo aliases, "
          f"{syn['dangling_dropped']} dangling dropped")

    ao.stamp_metadata(data, ov, {**tax, **syn})

    after = {"species": len(data["valid_names"]),
             "genera": len(data["genera"]),
             "synonyms": len(data["synonyms"])}
    print(f"After:  {after['species']} species, {after['genera']} genera, "
          f"{after['synonyms']} synonyms")

    errs = ao.check_invariants(data, ov)
    if errs:
        print("\nINVARIANT FAILURES — nothing written:", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("Invariants: OK")

    if args.dry_run:
        print("\n--dry-run: no changes written.")
        return 0

    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\nWrote {DB_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
