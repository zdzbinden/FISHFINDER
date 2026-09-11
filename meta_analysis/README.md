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
| 3b | `03b_split_references.py` | Split each text into body vs. reference-list so names in cited titles aren't counted as author usage (round-2) |
| 4 | `04_analyze_names.js` | Run each text (body + refs) through the FISHFINDER classification engine (Node.js) |
| 5 | `05_summarize.py` | Aggregate body results; exclude papers per `paper_review.json`; report a deduplicated distinct-species count alongside per-paper detections |
| 6 | `06_make_figures.py` | Generate publication-ready figures (PNG + PDF) and CSV tables |

**Study-region review (round-2).** `07_geo_filter.py` scores each paper's study region against a
North-America gazetteer → `cache/geo_review.csv`; the reviewed decisions are committed to
`paper_review.json` (DOI-keyed include/exclude), which step 5 reads. `verify_extralimital.py`
audits flagged "outdated" names against Eschmeyer's validity → `../extralimital_valids.json` (the
synonym-DB exclusion list). Background: `../publication/round2_revision/REVISION_LOG.md`.

## Running the pipeline

### Prerequisites

- Python 3.11+ (managed by [uv](https://docs.astral.sh/uv/))
- Node.js 18+
- Set your email for API polite-pool access:
  ```
  export OPENALEX_EMAIL="your.email@example.com"
  ```

### Setup (one-time)

Dependencies are declared in `pyproject.toml` and pinned to exact versions
(including transitive dependencies) in `uv.lock`, ensuring reproducible
environments across machines and over time. From the `meta_analysis/` directory:

```bash
uv sync
```

### Full run

```bash
uv run run_pipeline.py
```

This runs all six steps in sequence. Each step caches its output in `cache/`,
so interrupted runs resume automatically.

### Individual steps

```bash
uv run 01_discover_papers.py
uv run 02_download_pdfs.py
uv run 03_extract_text.py
uv run 03b_split_references.py   # round-2: body vs. reference-list split
node 04_analyze_names.js
uv run 07_geo_filter.py          # round-2: study-region scores -> geo_review.csv (informs paper_review.json)
uv run 05_summarize.py
uv run 06_make_figures.py
```

## Configuration

All parameters are centralized in `config.py`:

- **Search filters** — publication year, language, institution countries,
  OpenAlex concept ID, title include/exclude keywords
- **Rate limits** — courtesy delays for OpenAlex (200 ms), Unpaywall (1 s),
  and publisher PDF downloads (2 s)
- **Analysis thresholds** — the North American species-ratio (0.3) is retained only as a
  *signal* for the study-region review (`07_geo_filter.py`), not as an automatic exclusion;
  final include/exclude decisions live in `paper_review.json` (round-2)

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

Most outputs are written to `cache/` (gitignored):

- `papers.json` — discovered paper metadata
- `pdfs/` — downloaded PDFs
- `texts/`, `texts_body/`, `texts_refs/` — extracted text (whole, body-only, refs-only)
- `results/`, `results_body/`, `results_refs/` — per-paper classification JSON
- `summary.json` / `summary.md` — aggregate statistics
- `figures/` — publication figures (PNG + PDF) and CSV tables
- `geo_review.csv` — study-region scores (from `07_geo_filter.py`)

Committed (not in `cache/`): `paper_review.json` (DOI-keyed include/exclude decisions) and
`../extralimital_valids.json` (synonym-DB exclusion list).
