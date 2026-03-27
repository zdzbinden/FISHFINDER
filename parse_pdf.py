#!/usr/bin/env python3
"""
parse_pdf.py — Extract fish names and metadata from the AFS 8th edition
"Names of Fishes" Table 1 PDF and write fishfinder/data/fish_names.json.

Source: names_of_fishes/Names-of-Fishes-8-Table1.pdf
This is the table-only PDF distributed by AFS. Each species row uses dot-leader
column separators; text is correctly encoded (no reversal needed).

Usage:
    uv run --with pymupdf python parse_pdf.py

Requires: pymupdf
"""

import json
import re
import sys
from pathlib import Path

try:
    import fitz  # pymupdf
except ImportError:
    print("ERROR: pymupdf not installed.")
    print("Run: uv run --with pymupdf python parse_pdf.py")
    sys.exit(1)

PDF_PATH    = Path(__file__).parent / "names_of_fishes" / "Names-of-Fishes-8-Table1.pdf"
OUTPUT_PATH = Path(__file__).parent / "fishfinder" / "data" / "fish_names.json"

# ── Regexes ───────────────────────────────────────────────────────────────────

HAS_DOTS_RE = re.compile(r'\.{4,}')   # species rows have 4+ consecutive dots

CLASS_RE  = re.compile(r'^CLASS\s+([A-Z]+)\s*[–—-]+\s*(.+)$')
ORDER_RE  = re.compile(r'^ORDER\s+([A-Z]{4,})')
FAMILY_RE = re.compile(r'^[*^&+]?\s*([A-Z][a-z]+(?:idae|inae))\s*[–—-]')

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


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not PDF_PATH.exists():
        print(f"ERROR: PDF not found at {PDF_PATH}")
        sys.exit(1)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    valid_names: dict = {}
    genera: set = set()
    current_class  = ''
    current_order  = ''
    current_family = ''

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
                    continue

                order = parse_order(stripped)
                if order:
                    current_order = order
                    continue

                family = parse_family(stripped)
                if family:
                    current_family = family
                    continue

                entry = parse_species_line(line)
                if not entry:
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


if __name__ == '__main__':
    main()
