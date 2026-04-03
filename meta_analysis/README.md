# Meta-Analysis Pipeline

Automated literature analysis that uses the FISHFINDER engine to assess the
prevalence of taxonomic naming errors in recent ichthyological publications.

---

## What it does

The pipeline searches for recent open-access fish ecology papers, downloads
their PDFs, extracts the text, and runs every scientific name through the
FISHFINDER classification engine. The output is a per-paper breakdown of
valid names, outdated synonyms, misspellings, and 8th-edition changes —
plus aggregate statistics and publication-ready figures.

## Pipeline steps

| Step | Script | Function |
|------|--------|----------|
| 1 | `01_discover_papers.py` | Query OpenAlex API with filters; accept papers matching title keywords |
| 2 | `02_download_pdfs.py` | Download PDFs via publisher heuristics, OpenAlex URLs, and Unpaywall fallback |
| 3 | `03_extract_text.py` | Extract plain text from each PDF using PyMuPDF |
| 4 | `04_analyze_names.js` | Run each text through the FISHFINDER classification engine (Node.js) |
| 5 | `05_summarize.py` | Aggregate results; apply North American species ratio filter; generate summary |
| 6 | `06_make_figures.py` | Generate publication-ready figures (PNG + PDF) and CSV tables |

## Running the pipeline

### Prerequisites

- Python 3.11+ (managed by [uv](https://docs.astral.sh/uv/))
- Node.js 18+
- Set your email for API polite-pool access:
  ```
  export OPENALEX_EMAIL="your.email@example.com"
  ```

### Full run

```bash
uv run --with requests --with pymupdf --with matplotlib python run_pipeline.py
```

This runs all six steps in sequence. Each step caches its output in `cache/`,
so interrupted runs resume automatically.

### Individual steps

```bash
uv run --with requests python 01_discover_papers.py
uv run --with requests python 02_download_pdfs.py
uv run --with pymupdf python 03_extract_text.py
node 04_analyze_names.js
uv run python 05_summarize.py
uv run --with matplotlib python 06_make_figures.py
```

## Configuration

All parameters are centralized in `config.py`:

- **Search filters** — publication year, language, institution countries,
  OpenAlex concept ID, title include/exclude keywords
- **Rate limits** — courtesy delays for OpenAlex (200 ms), Unpaywall (1 s),
  and publisher PDF downloads (2 s)
- **Analysis thresholds** — North American species ratio filter (0.3) to
  exclude papers with predominantly non-AFS species

## Search strategy

Papers are identified via the [OpenAlex API](https://openalex.org/) with
these filters:

- Published 2024 or later (post-AFS 8th edition)
- English language, open access, article type
- Tagged with Fish (Actinopterygii) concept
- At least one author at a US, Canadian, or Mexican institution

A secondary title-keyword filter selects multi-species field studies (e.g.,
"fish assemblage," "fish community," "fish diversity") while excluding
aquaculture, food science, and review articles.

PDFs are obtained through publisher-specific URL heuristics, direct OpenAlex
URLs, and [Unpaywall](https://unpaywall.org/) as a fallback.

## APIs used

Both APIs are free and require no authentication — just an email address:

- **OpenAlex** — bibliographic metadata and open-access URLs
- **Unpaywall** — fallback PDF URL resolution via DOI

## Output

All outputs are written to `cache/` (gitignored):

- `papers.json` — discovered paper metadata
- `pdfs/` — downloaded PDFs
- `texts/` — extracted plain text
- `results/` — per-paper classification JSON
- `summary.json` / `summary.md` — aggregate statistics
- `figures/` — publication figures (PNG + PDF) and CSV tables
