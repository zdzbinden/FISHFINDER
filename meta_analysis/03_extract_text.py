#!/usr/bin/env python3
"""
Step 3: Extract plain text from downloaded PDFs using PyMuPDF.

Reads each PDF in cache/pdfs/, extracts text, and writes to cache/texts/.
Skips already-extracted files for resume support.

Output: cache/texts/<doi_hash>.txt
"""

import json
import fitz  # PyMuPDF
from config import PAPERS_CACHE, PDF_DIR, TEXT_DIR


def load_papers():
    """Load the papers cache."""
    if not PAPERS_CACHE.exists():
        print('Error: papers.json not found. Run previous steps first.')
        raise SystemExit(1)
    with open(PAPERS_CACHE, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_papers(cache):
    """Write updated papers cache."""
    with open(PAPERS_CACHE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def extract_text_from_pdf(pdf_path):
    """Extract all text from a PDF file. Returns text string or None on error."""
    try:
        doc = fitz.open(str(pdf_path))
        pages = []
        for page in doc:
            text = page.get_text()
            if text.strip():
                pages.append(text)
        doc.close()
        return '\n\n'.join(pages)
    except Exception as e:
        print(f'    Error extracting {pdf_path.name}: {e}')
        return None


def extract_all():
    """Extract text from all downloaded PDFs."""
    cache = load_papers()
    papers = cache['papers']
    TEXT_DIR.mkdir(parents=True, exist_ok=True)

    extracted = 0
    skipped = 0
    failed = 0

    # Only process papers with successful downloads
    downloadable = {doi: p for doi, p in papers.items()
                    if p.get('download_status') == 'downloaded' and p.get('pdf_file')}

    print(f'Processing {len(downloadable)} downloaded PDFs for text extraction.\n')

    for doi, paper in downloadable.items():
        filename = paper['pdf_file']
        pdf_path = PDF_DIR / f'{filename}.pdf'
        txt_path = TEXT_DIR / f'{filename}.txt'

        # Skip already-extracted
        if txt_path.exists() and txt_path.stat().st_size > 0:
            if paper.get('text_status') != 'extracted':
                paper['text_status'] = 'extracted'
            skipped += 1
            continue

        if not pdf_path.exists():
            paper['text_status'] = 'missing_pdf'
            failed += 1
            continue

        text = extract_text_from_pdf(pdf_path)

        if text and len(text.strip()) > 100:  # sanity check: at least 100 chars
            txt_path.write_text(text, encoding='utf-8')
            paper['text_status'] = 'extracted'
            paper['text_length'] = len(text)
            extracted += 1
            if extracted % 10 == 0:
                print(f'  Extracted {extracted} texts...')
        else:
            paper['text_status'] = 'extraction_failed'
            failed += 1

    save_papers(cache)
    print(f'\nExtraction complete: {extracted} new, {skipped} cached, {failed} failed.')
    print(f'Texts available: {extracted + skipped}')


if __name__ == '__main__':
    extract_all()
