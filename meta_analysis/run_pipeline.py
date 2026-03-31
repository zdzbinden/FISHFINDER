#!/usr/bin/env python3
"""
FISHFINDER Meta-Analysis Pipeline — Orchestrator

Runs all six pipeline steps in sequence:
  1. Discover papers (OpenAlex API)
  2. Download PDFs (OpenAlex OA URLs + Unpaywall fallback)
  3. Extract text (PyMuPDF)
  4. Analyze names (Node.js + engine.js)
  5. Summarize results
  6. Generate publication figures and tables

Usage:
    uv run --with requests --with pymupdf --with matplotlib python meta_analysis/run_pipeline.py

Or run individual steps:
    uv run --with requests python meta_analysis/01_discover_papers.py
    uv run --with requests python meta_analysis/02_download_pdfs.py
    uv run --with pymupdf  python meta_analysis/03_extract_text.py
    node meta_analysis/04_analyze_names.js --batch cache/texts cache/results
    python meta_analysis/05_summarize.py
    uv run --with matplotlib python meta_analysis/06_make_figures.py
"""

import subprocess
import sys
import time
from pathlib import Path
from config import HERE, TEXT_DIR, RESULTS_DIR, OPENALEX_EMAIL, FIGURES_DIR


def run_step(description, cmd, cwd=None):
    """Run a pipeline step, printing status and timing."""
    print(f'\n{"=" * 60}')
    print(f'  {description}')
    print(f'{"=" * 60}\n')

    start = time.time()
    result = subprocess.run(cmd, cwd=cwd or str(HERE))
    elapsed = time.time() - start

    if result.returncode != 0:
        print(f'\n  FAILED (exit code {result.returncode}) after {elapsed:.1f}s')
        return False

    print(f'\n  Completed in {elapsed:.1f}s')
    return True


def main():
    # Sanity check: email configured?
    if 'CHANGEME' in OPENALEX_EMAIL:
        print('ERROR: Please update OPENALEX_EMAIL in config.py with your university email.')
        print('       This is required for OpenAlex and Unpaywall API access.')
        sys.exit(1)

    python = sys.executable
    node = 'node'

    print('FISHFINDER Meta-Analysis Pipeline')
    print('=' * 60)
    start_time = time.time()

    # Step 1: Discover papers
    if not run_step(
        'Step 1/6: Discovering papers via OpenAlex API',
        [python, str(HERE / '01_discover_papers.py')],
    ):
        print('Pipeline halted at Step 1.')
        sys.exit(1)

    # Step 2: Download PDFs
    if not run_step(
        'Step 2/6: Downloading open-access PDFs',
        [python, str(HERE / '02_download_pdfs.py')],
    ):
        print('Pipeline halted at Step 2.')
        sys.exit(1)

    # Step 3: Extract text
    if not run_step(
        'Step 3/6: Extracting text from PDFs',
        [python, str(HERE / '03_extract_text.py')],
    ):
        print('Pipeline halted at Step 3.')
        sys.exit(1)

    # Step 4: Analyze with FISHFINDER engine (Node.js)
    if not run_step(
        'Step 4/6: Analyzing fish names with FISHFINDER engine',
        [node, str(HERE / '04_analyze_names.js'),
         '--batch', str(TEXT_DIR), str(RESULTS_DIR)],
    ):
        print('Pipeline halted at Step 4.')
        sys.exit(1)

    # Step 5: Summarize
    if not run_step(
        'Step 5/6: Generating summary statistics',
        [python, str(HERE / '05_summarize.py')],
    ):
        print('Pipeline halted at Step 5.')
        sys.exit(1)

    # Step 6: Generate publication figures and tables
    if not run_step(
        'Step 6/6: Generating publication figures and tables',
        [python, str(HERE / '06_make_figures.py')],
    ):
        print('Pipeline halted at Step 6.')
        sys.exit(1)

    total_time = time.time() - start_time
    print(f'\n{"=" * 60}')
    print(f'  Pipeline complete! Total time: {total_time:.1f}s')
    print(f'{"=" * 60}')
    print(f'\nResults:')
    print(f'  Summary JSON: cache/summary.json')
    print(f'  Summary report: cache/summary.md')
    print(f'  Figures & tables: cache/figures/')


if __name__ == '__main__':
    main()
