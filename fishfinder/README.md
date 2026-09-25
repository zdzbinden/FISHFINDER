# FISHFINDER

A static web app that validates scientific fish names in manuscript text against
*Common and Scientific Names of Fishes from the United States, Canada, and Mexico*,
8th edition (Page et al., 2023), published by the American Fisheries Society (AFS)
and the American Society of Ichthyologists and Herpetologists (ASIH).

---

## How to use

1. Visit the deployed URL (GitHub Pages).
2. Paste your manuscript text into the text box.
3. Click **SCAN** (or press Ctrl/⌘+Enter).
4. Review the highlighted preview and the issues table.
5. Click **COPY** to copy the text with outdated/misspelled names
   automatically replaced by the suggested corrections.

### Color coding

| Color  | Meaning |
|--------|---------|
| Green  | **Valid** — exact match in the 8th edition or its published addenda |
| Blue   | **Changed in 8th edition** — name is valid but was reassigned or revised since the 7th edition; confirm this is the intended species (hover for current common name) |
| Orange | **Outdated / Synonym** — replaced by a different name; suggestion shown with common name |
| Red    | **Misspelled** — close match found; check the suggestion |
| Purple | **Unknown** — genus looks fish-like but no close species match |
| Purple | **Removed from the List** — the name was in the 8th edition but has since been withdrawn by a published addendum; no replacement is offered because none was published |

Hover over any highlighted name to see its common name or suggested correction.

---

## Data pipeline

The name database (`data/fish_names.json`) is built in two steps:

### Step 1 — Parse the AFS table PDF

```powershell
uv run --with pymupdf python ../parse_pdf.py
```

Source: `../names_of_fishes/Names-of-Fishes-8-Table1.pdf`
(The table-only PDF distributed by AFS — not the full book.)

Extracts ~5,086 species with full metadata per entry (the published addenda then
bring this to ~5,200 — see `apply_addenda.py`):
`class`, `order`, `family`, `author`, `occurrence`, `flags`, `common_name_en`,
`common_name_es`, `common_name_fr`

### Step 2 — Enrich with synonyms from Eschmeyer's Catalog of Fishes

```powershell
uv run --with requests --with beautifulsoup4 python ../scrape_eschmeyer.py
```

Queries [Eschmeyer's Catalog of Fishes](https://researcharchive.calacademy.org/research/ichthyology/catalog/fishcatmain.asp) for
each species and adds older/synonymized names to `fish_names.json`. Handles both
strict synonyms and genus transfers (reclassifications).

Results are cached two ways, and the difference matters:

- `../eschmeyer_cache.json` — the *parsed* results, one entry per species.
- `../eschmeyer_text/` — the *normalized page text* the parser ran on.

Interrupted runs resume from either. Only the second makes a parser change
replayable: `--reparse` re-runs the parser over the stored text with no network
and finishes in seconds, where re-fetching takes hours. Both are gitignored and
have no copy in version control, so back them up before deleting.

A cold run over all ~5,200 species takes **~5 hours** at a respectful request
rate. Useful flags:

| flag | effect |
|---|---|
| `--merge` | keep the existing map, add only what is missing (production path) |
| `--reparse` | re-parse the stored page text, no network — use after a parser change |
| `--rebuild-only` | rebuild the map from the parsed cache, no network |
| `--dry-run` | build the map but do not write `fish_names.json` |
| `--accessed=YYYY-MM-DD` | record the date the catalog was queried, shown in the site citation |

---

## Running locally

The app loads `data/fish_names.json` via `fetch()`, so it must be served over HTTP
(opening `index.html` directly as a `file://` URL will fail in most browsers).

```powershell
cd fishfinder
python -m http.server 8080
# then open http://localhost:8080
```

---

## Updating the data (new edition)

When a new edition of *Names of Fishes* is published:

1. Replace `../names_of_fishes/Names-of-Fishes-8-Table1.pdf` with the new table PDF.
2. Re-run the parser:
   ```powershell
   uv run --with pymupdf python ../parse_pdf.py
   ```
3. Back up, then delete, `../eschmeyer_cache.json` **and** `../eschmeyer_text/`
   (neither is in version control), and re-run the synonym scraper:
   ```powershell
   uv run --with requests --with beautifulsoup4 python ../scrape_eschmeyer.py --dry-run
   ```
   `--dry-run` writes the proposed map to `../synonyms_dryrun.json` so it can be
   diffed against the shipped one before anything is overwritten. Re-run without
   the flag, or with `--rebuild-only`, once the diff looks right.
4. Commit and push `data/fish_names.json`.

---

## Architecture

The classification engine (`js/engine.js`) is a pure module with no DOM
dependencies. It exports functions via the `FishEngine` global (in the browser)
or `module.exports` (in Node.js). `js/app.js` handles the UI, Firebase
analytics, animations, and event wiring — it delegates all name validation to
`FishEngine.*`.

---

## Testing

```powershell
cd fishfinder
node --test test/*.test.js
```

Uses the Node.js built-in test runner (`node:test` + `node:assert`). Zero npm
dependencies. Tests load `fish_names.json` directly and exercise the engine
against the real dataset (226 tests across 8 files):

| File | Coverage |
|------|----------|
| `levenshtein.test.js` | Edit-distance algorithm (identical, substitution, insertion, deletion, transposition, early-exit, pruning) |
| `classify.test.js` | Classification decision tree (valid, changed, outdated, misspelled, unknown, common name, abbreviation filtering, confidence scoring) |
| `extract.test.js` | Binomial regex extraction + common name matching (exact and fuzzy) |
| `edge-cases.test.js` | Fuzzy matching boundaries, genus first-letter filter, charCode proximity, database integrity |
| `abbrev.test.js` | Abbreviated genus resolution (`P. olivaris`), ambiguity tie-breaks, and the false-positive guards (author initials, `e.g.`, `Ph.D.`, reference lists) |
| `low-confidence.test.js` | Prose demotion across the unknown/misspelled/outdated tiers, the English-word epithets that must *not* demote, and the `ae-`/`e-` epithet variants |
| `addenda.test.js` | The FF-8.1 addenda overlay |
| `security.test.js` | The CSP, integrity hashes on every CDN file, HTML escaping, the Firebase rules, the deploy workflow's action pins, and the shape of every name in the database |

---

## Security

A static site has no server of its own to attack. What remains is the page's
code, its third-party libraries, and the Firebase database that stores usage
statistics and REPORT submissions. Each is protected as follows:

- **Content Security Policy.** A `<meta>` CSP, placed first in `<head>` because
  it only governs what comes after it. Scripts load only from the page itself,
  from exact versioned CDN URLs, and from `*.firebaseio.com`: Firebase moves
  connections between shard hosts and falls back to long-polling with JSONP
  scripts, so no single host can be named. There is no `'unsafe-inline'` or
  `'unsafe-eval'` anywhere, and `object-src 'none'`, `base-uri 'self'` and
  `form-action 'self'` are set. GitHub Pages cannot send HTTP headers, so
  `frame-ancestors` (anti-framing) and HSTS are not available.
- **Subresource Integrity.** Every CDN file, the pdf.js worker included, is
  pinned by an `sha384` hash in the `CDN` object in `app.js` and refused if the
  CDN serves anything else. pdf.js is never allowed to fetch its worker by
  itself, because that path carried no hash. SheetJS comes from
  `cdn.sheetjs.com`, since its fixed releases are not on npm or cdnjs.
- **Untrusted text.** Everything rendered as HTML goes through `esc()`: names
  and common names from the database, text from uploaded files, and the
  location strings in visit records, which anyone can write.
- **Firebase rules** (`database.rules.json`). Visit records and reports are
  create-only and validated field by field. The two counters only go up and
  cannot be deleted. Reports cannot be read by visitors at all, and the visit
  history can be read only 500 records at a time. The rules are deployed with
  `firebase deploy --only database`; GitHub Actions does not deploy them.
- **Privacy & consent.** Analytics (geolocation via ipapi.co, scan counts) run
  only after explicit consent. Visit records keep coordinates rounded to about
  1 km and the hour of the visit. No manuscript text leaves the device.
- **Deploy pipeline.** The workflow's actions are pinned to commit SHAs, kept
  current by Dependabot, and run with no permissions beyond what Pages needs.

Two checks keep this true: `test/security.test.js`, part of the suite above,
and `tools/csp-smoke.js`. The smoke check loads the page in headless Chrome,
exercises every feature that pulls in third-party code, and fails on any CSP
violation or integrity failure. One pass swaps every CDN file for tampered
code and confirms none of it runs. It never writes to the live database.

```powershell
node tools/csp-smoke.js                              # from the repo root; or: cd fishfinder && npm run csp
node tools/csp-smoke.js --url https://fishnames.net/ # the deployed site
```

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

---

## Accessibility

FISHFINDER targets WCAG 2.2 AA. Contrast and target size are measured on the
rendered page, not estimated from the stylesheet:

```powershell
node tools/a11y-audit.js          # from the repo root; or: cd fishfinder && npm run a11y
```

The audit serves the site itself, drives headless Chrome over the DevTools
protocol, scans a sample manuscript, opens every panel and collapsed group, and
reads each text element's real background from screenshot pixels — the housing,
footer and buttons are gradients, so the CSS colour is not what the text sits
on. It covers both themes at 1280 px and 390 px and exits non-zero on any
failure. Needs Node 22+ and Chrome; no packages. Last run: 0 failures across all
16 configurations.


- All interactive elements have `:focus-visible` indicators
- `aria-label` on highlight spans, `aria-live` on count badges
- Screen-reader-friendly results table (`<caption>`, `scope="col"`)
- Modal focus trap with return-to-trigger on close
- Skip-to-content link for keyboard navigation
- Semantic headings (`<h1>`/`<h2>`) and `<main>` landmark
- Every text element passes 4.5:1 (3:1 for large text), and every
  interactive target is at least 24×24 px, verified by the audit above
- **HI-CON button** toggles a high-contrast display mode (white LCD,
  dark text, ≥7:1 classification colors) for users who prefer it over
  the default sage-green palette. State persists across sessions.

---

## GitHub Pages deployment

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`).
Pushing to `main` triggers a workflow that uploads the `fishfinder/` directory
as a Pages artifact and deploys it. The `.nojekyll` file in this directory
prevents Jekyll processing, which would interfere with the `data/` directory.

---

## Citation

Page, L. M., K. E. Bemis, T. E. Dowling, H. Espinosa-Pérez, L. T. Findley,
C. R. Gilbert, K. E. Hartel, R. N. Lea, N. E. Mandrak, M. A. Neighbors,
J. J. Schmitter-Soto, and H. J. Walker, Jr. 2023.
*Common and Scientific Names of Fishes from the United States, Canada, and Mexico*,
8th edition. American Fisheries Society, Special Publication 37, Bethesda, Maryland.
