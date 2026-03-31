#!/usr/bin/env python3
"""
Step 2: Download open-access PDFs for discovered papers.

Tries multiple strategies per paper:
  1. Publisher-specific direct PDF URL (heuristic from OA URL or DOI)
  2. OpenAlex OA URL as-is
  3. Unpaywall url_for_pdf (strict — skips HTML landing pages)

Skips already-downloaded files for resume support.
Stops early once MIN_USABLE_PDFS are on disk.

Usage:
    python 02_download_pdfs.py            # normal run (skip previously failed)
    python 02_download_pdfs.py --retry    # reset failed papers and retry

Output: cache/pdfs/<doi_hash>.pdf
"""

import hashlib
import json
import sys
import time
import re
import requests
from config import (
    PAPERS_CACHE, PDF_DIR, CACHE_DIR,
    UNPAYWALL_API, UNPAYWALL_EMAIL, UNPAYWALL_DELAY,
    PDF_DOWNLOAD_DELAY, USER_AGENT, MIN_USABLE_PDFS,
)


def doi_to_filename(doi):
    """Convert a DOI to a safe filename hash."""
    return hashlib.sha256(doi.encode()).hexdigest()[:16]


def load_papers():
    """Load the papers cache."""
    if not PAPERS_CACHE.exists():
        print('Error: papers.json not found. Run 01_discover_papers.py first.')
        raise SystemExit(1)
    with open(PAPERS_CACHE, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_papers(cache):
    """Write updated papers cache."""
    with open(PAPERS_CACHE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def resolve_pdf_urls(oa_url, doi):
    """Generate candidate direct-PDF URLs from an OA URL or DOI.

    Returns a list of URLs to try in order (best guess first).
    Publisher-specific heuristics convert landing pages to PDF endpoints.
    """
    candidates = []
    url = oa_url or ''

    # Wiley: /doi/X → /doi/pdfdirect/X?download=true
    if 'onlinelibrary.wiley.com' in url:
        m = re.search(r'/doi/(10\.\d{4,}/[^\s?#]+)', url)
        if m:
            candidates.append(
                f'https://onlinelibrary.wiley.com/doi/pdfdirect/{m.group(1)}?download=true'
            )

    # MDPI: article URL → /pdf
    if 'mdpi.com' in url and '/pdf' not in url:
        candidates.append(url.rstrip('/') + '/pdf')

    # OUP: attempt /pdf suffix
    if 'academic.oup.com' in url and '/pdf' not in url:
        candidates.append(url.rstrip('/') + '/pdf')

    # Springer/Nature: often already direct PDF, but try /fulltext.pdf
    if 'link.springer.com/article' in url and '.pdf' not in url:
        candidates.append(url.replace('/article/', '/content/pdf/') + '.pdf')

    # Frontiers: try /pdf if not already
    if 'frontiersin.org' in url and '/pdf' not in url:
        candidates.append(url.rstrip('/') + '/pdf')

    # Generic DOI URL — construct publisher URL from DOI
    if doi and not candidates:
        doi_url = f'https://doi.org/{doi}'
        if url != doi_url:
            candidates.append(doi_url)

    # Always try the original OA URL as fallback
    if url and url not in candidates:
        candidates.append(url)

    return candidates


def get_unpaywall_pdf_url(doi):
    """Query Unpaywall for a direct PDF URL (strict — url_for_pdf only)."""
    url = f'{UNPAYWALL_API}/{doi}'
    params = {'email': UNPAYWALL_EMAIL}
    headers = {'User-Agent': USER_AGENT}

    try:
        resp = requests.get(url, params=params, headers=headers, timeout=30)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
        best = data.get('best_oa_location', {}) or {}
        # Only return url_for_pdf — the generic 'url' is usually an HTML page
        return best.get('url_for_pdf')
    except requests.RequestException:
        return None


def download_pdf(url, output_path):
    """Download a PDF from a URL. Returns True on success."""
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/pdf,*/*',
    }
    try:
        resp = requests.get(url, headers=headers, timeout=60, stream=True,
                            allow_redirects=True)
        resp.raise_for_status()

        # Verify it looks like a PDF
        content_type = resp.headers.get('content-type', '')
        first_bytes = b''

        with open(output_path, 'wb') as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if not first_bytes:
                    first_bytes = chunk[:5]
                f.write(chunk)

        # Check PDF magic bytes or content type
        if first_bytes.startswith(b'%PDF') or 'pdf' in content_type.lower():
            return True

        # Not a PDF — remove the file
        output_path.unlink(missing_ok=True)
        return False

    except requests.RequestException:
        output_path.unlink(missing_ok=True)
        return False


def count_downloaded_pdfs():
    """Count existing PDF files on disk."""
    if not PDF_DIR.exists():
        return 0
    return sum(1 for f in PDF_DIR.iterdir() if f.suffix == '.pdf' and f.stat().st_size > 0)


def download_all():
    """Download PDFs for all papers in the cache."""
    retry = '--retry' in sys.argv

    cache = load_papers()
    papers = cache['papers']
    PDF_DIR.mkdir(parents=True, exist_ok=True)

    # Reset failed papers if --retry
    if retry:
        reset_count = 0
        for paper in papers.values():
            if paper.get('download_status') == 'failed':
                paper['download_status'] = 'pending'
                reset_count += 1
        if reset_count:
            print(f'Reset {reset_count} failed papers for retry.')
            save_papers(cache)

    total = len(papers)
    downloaded = 0
    skipped = 0
    failed = 0

    existing_pdfs = count_downloaded_pdfs()
    print(f'Processing {total} papers for PDF download.')
    print(f'Already have {existing_pdfs} PDFs on disk. Target: {MIN_USABLE_PDFS}.\n')

    if existing_pdfs >= MIN_USABLE_PDFS:
        print(f'Already at target ({existing_pdfs} >= {MIN_USABLE_PDFS}). Nothing to do.')
        return

    for doi, paper in papers.items():
        filename = doi_to_filename(doi)
        pdf_path = PDF_DIR / f'{filename}.pdf'

        # Skip if already downloaded
        if pdf_path.exists() and pdf_path.stat().st_size > 0:
            if paper.get('download_status') != 'downloaded':
                paper['download_status'] = 'downloaded'
                paper['pdf_file'] = filename
            skipped += 1
            continue

        # Skip if previously marked as failed (unless --retry)
        if paper.get('download_status') == 'failed':
            failed += 1
            continue

        # Try publisher-specific PDF URLs first
        oa_url = paper.get('oa_url', '')
        success = False
        candidate_urls = resolve_pdf_urls(oa_url, doi)

        for url in candidate_urls:
            if download_pdf(url, pdf_path):
                success = True
                break
            time.sleep(0.5)  # brief pause between retries

        # Fallback to Unpaywall (strict: url_for_pdf only)
        if not success:
            time.sleep(UNPAYWALL_DELAY)
            unpaywall_url = get_unpaywall_pdf_url(doi)
            if unpaywall_url:
                success = download_pdf(unpaywall_url, pdf_path)

        if success:
            paper['download_status'] = 'downloaded'
            paper['pdf_file'] = filename
            downloaded += 1
            if downloaded % 10 == 0:
                on_disk = count_downloaded_pdfs()
                print(f'  Downloaded {downloaded} PDFs (total on disk: {on_disk})...')

            # Early exit once we have enough
            on_disk = count_downloaded_pdfs()
            if on_disk >= MIN_USABLE_PDFS:
                print(f'\n  Reached target: {on_disk} PDFs on disk.')
                save_papers(cache)
                break
        else:
            paper['download_status'] = 'failed'
            failed += 1

        # Save periodically for resumability
        if (downloaded + failed) % 20 == 0:
            save_papers(cache)

        time.sleep(PDF_DOWNLOAD_DELAY)

    # Final save
    save_papers(cache)
    total_on_disk = count_downloaded_pdfs()
    print(f'\nDownload complete: {downloaded} new, {skipped} cached, {failed} failed.')
    print(f'PDFs on disk: {total_on_disk}')
    if total_on_disk < MIN_USABLE_PDFS:
        print(f'WARNING: Only {total_on_disk} PDFs available (target: {MIN_USABLE_PDFS}).')
        print(f'Consider running with --retry or increasing MAX_PAPERS in config.py.')


if __name__ == '__main__':
    download_all()
