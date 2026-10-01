#!/usr/bin/env python3
"""
parse_pdf.py — Extract fish names and metadata from the AFS 8th edition
"Names of Fishes" Table 1 PDF and write fishfinder/data/fish_names.json.

Source: names_of_fishes/Names-of-Fishes-8-Table1.pdf
This is the table-only PDF distributed by AFS. Each species row uses dot-leader
column separators; text is correctly encoded (no reversal needed).

Class, order and family come from the header lines between species rows. A run
aborts if a header-shaped line is not recognized (see audit_header), because a
missed header does not fail; it silently files every following species under
the previous taxon. That is how 51% of species shipped with the wrong order
until 2026-10-01.

Usage:
    uv run --with pymupdf python parse_pdf.py

Requires: pymupdf
"""

import json
import re
import sys
from pathlib import Path

PDF_PATH    = Path(__file__).parent / "names_of_fishes" / "Names-of-Fishes-8-Table1.pdf"
OUTPUT_PATH = Path(__file__).parent / "fishfinder" / "data" / "fish_names.json"

# ── Regexes ───────────────────────────────────────────────────────────────────

HAS_DOTS_RE = re.compile(r'\.{4,}')   # species rows have 4+ consecutive dots

# Headers carry the same `*` flag as species rows when the taxon is new or changed
# since the 7th edition ("*ORDER SILURIFORMES"). ORDER_RE once anchored on a bare
# "^ORDER" and missed all 20 flagged orders.
CLASS_RE  = re.compile(r'^[*^&+]?\s*CLASS\s+([A-Z]+)\s*[–—-]+\s*(.+)$')
ORDER_RE  = re.compile(r'^[*^&+]?\s*ORDER\s+([A-Z]{4,})')
# The separator is a dash everywhere except "Gobiesocidae, En-clingfishes", which
# the book prints with a comma; without it all 43 clingfishes were filed as mullets.
FAMILY_RE = re.compile(r'^[*^&+]?\s*([A-Z][a-z]+(?:idae|inae))\s*[–—,-]')

# A line that names a taxon. Used only to audit that every such line was parsed.
HEADER_LIKE_RE = re.compile(r'\bCLASS\s|\bORDER\s|^[*^&+]?\s*[A-Z][a-z]+idae\b.*\bEn-')

# Order headers the printed book omits. The 8th edition has no
# "ORDER CHARACIFORMES": *Characidae follows Leuciscidae directly on p. 76, and
# the order appears nowhere in Table 1, Appendix 1 or the Index, so read literally
# the tetras would be cypriniforms. Neither Appendix 1 nor any other source moves
# them there. The book says its arrangement follows Fricke et al. (2022,
# Eschmeyer's Catalog of Fishes), which places Characidae and Bryconidae in
# Characiformes, as did the 7th edition. Keyed by the family header the missing
# order header should precede; main() aborts unless each fires exactly once.
MISSING_ORDER_HEADERS = {
    "Characidae": "Characiformes",
}

GENUS_RE   = re.compile(r'^[A-Z][a-z]{1,}$')          # allow 2-char genera e.g. Zu
SPECIES_RE = re.compile(r'^[a-z][a-z-]{2,}$')         # allow hyphens e.g. x-punctatus

# Lines that are never species data
SKIP_RE = re.compile(
    r'^\d+$'                              # page number
    r'|^NAMES OF FISHES$'                # running header
    r'|^SCIENTIFIC NAME'                 # column header
    r'|^\s*OCCURRENCE'                   # column header
    r'|^COMMON NAME'                     # column header
    r'|^TABLE\s+1\.'                     # table caption
    r'|^A\s*='                           # legend: code definitions
    r'|^[*^]\s+indicates'               # legend: flag definitions
    r'|^Common names'                    # legend
    r'|^the exclusive'                   # legend continuation
    r'|^added to the'                    # legend continuation
    r'|^in French'                       # legend continuation
    r'|^En-,\s*Sp-'                      # legend continuation
)


# ── Parsers ───────────────────────────────────────────────────────────────────

def parse_species_line(line: str) -> dict | None:
    """
    Parse one species data row. Returns None if not a valid species entry.

    Column format (dot-leader separated):
        [flags\\t]Genus species Author, Year  ....  OCC  ....  English  ....  Spanish  ....  French
    """
    if not HAS_DOTS_RE.search(line):
        return None

    parts = re.split(r'\.{2,}', line)
    if len(parts) < 3:   # need at least: name, occurrence, English name
        return None

    col0    = parts[0]
    col_occ = parts[1].strip()
    col_en  = parts[2].strip()
    col_es  = parts[3].strip() if len(parts) > 3 else ''
    col_fr  = parts[4].strip() if len(parts) > 4 else ''

    # Validate occurrence code — must start with a known letter
    occ = re.sub(r'\s+', '', col_occ)
    if not re.match(r'^[APFarCMU]', occ):
        return None

    # Extract flags (* ^ & +) from the start of col0
    text = col0.lstrip('\t ')
    flag_m = re.match(r'^([*^&+]+)\s*', text)
    flags = ''
    if flag_m:
        flags = flag_m.group(1)
        text = text[flag_m.end():]
    text = text.strip()

    # Parse genus, species epithet, author
    tokens = text.split()
    if len(tokens) < 3:   # need genus + epithet + at least one author token
        return None

    genus      = tokens[0]
    species_ep = tokens[1].rstrip('.,')
    author     = ' '.join(tokens[2:]).strip().strip('.,')

    if not GENUS_RE.match(genus):
        return None
    if not SPECIES_RE.match(species_ep):
        return None

    return {
        'genus':          genus,
        'species':        species_ep,
        'author':         author,
        'flags':          flags,
        'occurrence':     occ,
        'common_name_en': col_en,
        'common_name_es': col_es,
        'common_name_fr': col_fr,
    }


def parse_class(line: str) -> tuple[str, str] | None:
    m = CLASS_RE.match(line)
    if not m:
        return None
    return m.group(1).capitalize(), m.group(2).strip()


def parse_order(line: str) -> str | None:
    m = ORDER_RE.match(line)
    return m.group(1).capitalize() if m else None


def parse_family(line: str) -> str | None:
    m = FAMILY_RE.match(line)
    return m.group(1) if m else None


def audit_header(line: str) -> bool:
    """True when a stripped line that no parser accepted still looks like a header."""
    return not HAS_DOTS_RE.search(line) and bool(HEADER_LIKE_RE.search(line))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    try:
        import fitz  # pymupdf; imported here so the regexes are testable without it
    except ImportError:
        print("ERROR: pymupdf not installed.")
        print("Run: uv run --with pymupdf python parse_pdf.py")
        sys.exit(1)

    if not PDF_PATH.exists():
        print(f"ERROR: PDF not found at {PDF_PATH}")
        sys.exit(1)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    valid_names: dict = {}
    genera: set = set()
    current_class  = ''
    current_order  = ''
    current_family = ''
    classes: list = []
    orders: list = []
    families: list = []
    injected: list = []
    unparsed: list = []

    print(f"Opening {PDF_PATH} ...")
    with fitz.open(str(PDF_PATH)) as pdf:
        total = len(pdf)
        print(f"Total pages: {total}")

        for page_idx in range(1, total):   # table starts on page 2 (index 1)
            page = pdf[page_idx]
            for line in page.get_text("text").splitlines():
                stripped = line.strip()
                if not stripped or SKIP_RE.match(stripped):
                    continue

                cls = parse_class(stripped)
                if cls:
                    current_class = cls[0]
                    classes.append(current_class)
                    continue

                order = parse_order(stripped)
                if order:
                    current_order = order
                    orders.append(current_order)
                    continue

                family = parse_family(stripped)
                if family:
                    if family in MISSING_ORDER_HEADERS:
                        current_order = MISSING_ORDER_HEADERS[family]
                        injected.append(family)
                    current_family = family
                    families.append(current_family)
                    continue

                entry = parse_species_line(line)
                if not entry:
                    if audit_header(stripped):
                        unparsed.append(f"p{page_idx + 1}: {stripped}")
                    continue

                g, s    = entry['genus'], entry['species']
                binomial = f"{g} {s}"
                genera.add(g)

                if binomial not in valid_names:
                    valid_names[binomial] = {
                        'class':          current_class,
                        'order':          current_order,
                        'family':         current_family,
                        'author':         entry['author'],
                        'occurrence':     entry['occurrence'],
                        'flags':          entry['flags'],
                        'common_name_en': entry['common_name_en'],
                        'common_name_es': entry['common_name_es'],
                        'common_name_fr': entry['common_name_fr'],
                    }

            if page_idx % 20 == 0:
                print(f"  page {page_idx + 1}/{total}  ({len(valid_names)} names so far)")

    # Each check guards a failure that is otherwise silent: a missed or doubled
    # header, or an injected one the PDF no longer needs.
    errors = []
    if unparsed:
        errors.append(f"{len(unparsed)} header-like line(s) not parsed:\n    "
                      + "\n    ".join(unparsed))
    dup = sorted({f for f in families if families.count(f) > 1})
    if dup:
        errors.append(f"family header(s) seen more than once: {dup}")
    for fam in MISSING_ORDER_HEADERS:
        n = injected.count(fam)
        if n != 1:
            errors.append(f"MISSING_ORDER_HEADERS[{fam!r}] fired {n} times, expected 1")
        if MISSING_ORDER_HEADERS[fam] in orders:
            errors.append(f"{MISSING_ORDER_HEADERS[fam]} is now printed; drop the injection")
    if errors:
        print("\nERROR: header audit failed; nothing written.")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    data = {
        'metadata': {
            'edition':       8,
            'year':          2023,
            'source':        'Common and Scientific Names of Fishes from the United States, Canada, and Mexico (AFS/ASIH)',
            'species_count': len(valid_names),
            'synonym_count': 0,
        },
        'valid_names': valid_names,
        'genera':      sorted(genera),
        'synonyms':    {},
    }

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"\nDone.  ({size_kb:.0f} KB written to {OUTPUT_PATH})")
    print(f"  Valid species : {len(valid_names)}")
    print(f"  Unique genera : {len(genera)}")
    print(f"  Headers       : {len(classes)} classes, {len(orders)} orders "
          f"(+{len(injected)} injected), {len(families)} families")


if __name__ == '__main__':
    main()
