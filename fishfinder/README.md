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
| Green  | **Valid** — exact match in the 8th edition |
| Blue   | **Changed in 8th edition** — name is valid but was reassigned or revised since the 7th edition; confirm this is the intended species (hover for current common name) |
| Orange | **Outdated / Synonym** — replaced by a different name; suggestion shown with common name |
| Red    | **Misspelled** — close match found; check the suggestion |
| Purple | **Unknown** — genus looks fish-like but no close species match |

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

Extracts ~5,086 species with full metadata per entry:
`class`, `order`, `family`, `author`, `occurrence`, `flags`, `common_name_en`,
`common_name_es`, `common_name_fr`

### Step 2 — Enrich with synonyms from Eschmeyer's Catalog of Fishes

```powershell
uv run --with requests --with beautifulsoup4 python ../scrape_eschmeyer.py
```

Queries [Eschmeyer's Catalog of Fishes](https://researcharchive.calacademy.org/research/ichthyology/catalog/fishcatmain.asp) for
each species and adds older/synonymized names to `fish_names.json`. Handles both
strict synonyms and genus transfers (reclassifications).

Results are cached to `../eschmeyer_cache.json` so interrupted runs resume cleanly.
The full run takes ~3 hours at a respectful request rate.

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
3. Delete `../eschmeyer_cache.json` and re-run the synonym scraper:
   ```powershell
   uv run --with requests --with beautifulsoup4 python ../scrape_eschmeyer.py
   ```
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
against the real dataset (62 tests across 4 files):

| File | Coverage |
|------|----------|
| `levenshtein.test.js` | Edit-distance algorithm (identical, substitution, insertion, deletion, transposition, early-exit, pruning) |
| `classify.test.js` | Classification decision tree (valid, changed, outdated, misspelled, unknown, common name, abbreviation filtering, confidence scoring) |
| `extract.test.js` | Binomial regex extraction + common name matching (exact and fuzzy) |
| `edge-cases.test.js` | Fuzzy matching boundaries, genus first-letter filter, charCode proximity, database integrity |

---

## Security

- **Content Security Policy (CSP):** Enforced via `<meta>` tag with exact
  versioned CDN URLs (no directory wildcards) and Firebase transport support.
  `'unsafe-inline'` in `style-src` is required by Leaflet.
- **Subresource Integrity (SRI):** All CDN-loaded scripts and stylesheets
  include `sha384` integrity hashes and `crossorigin="anonymous"` attributes.
  The `loadScript()` and `loadStyle()` helpers in `app.js` apply SRI
  automatically from the centralized `CDN` config object.
- **Firebase security rules:** Writes restricted to `fishfinder/visits` (push
  with schema validation for lat/lng bounds, string lengths, timestamp sanity)
  and `fishfinder/stats` (increment-only counters). No extra fields allowed.
  Rules deployed via `firebase deploy --only database` from
  `database.rules.json` at the project root. API key restricted by domain
  in Google Cloud Console.
- **Privacy & consent:** Analytics (geolocation via ipapi.co, scan counts)
  are gated on explicit user consent via a localStorage-based banner with
  accept/decline. All `localStorage` calls are wrapped in try/catch for
  private browsing mode. Client-side rate limiting prevents write spam.
  No manuscript text leaves the user's device.

---

## Accessibility

FISHFINDER targets WCAG AA compliance (Lighthouse Accessibility score: 100):

- All interactive elements have `:focus-visible` indicators
- `aria-label` on highlight spans, `aria-live` on count badges
- Screen-reader-friendly results table (`<caption>`, `scope="col"`)
- Modal focus trap with return-to-trigger on close
- Skip-to-content link for keyboard navigation
- Semantic headings (`<h1>`/`<h2>`) and `<main>` landmark
- All 23 text/background color pairs pass 4.5:1 contrast ratio

---

## GitHub Pages deployment

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`).
Pushing to `main` triggers a workflow that uploads the `fishfinder/` directory
as a Pages artifact and deploys it. The `.nojekyll` file in this directory
prevents Jekyll processing, which would interfere with the `data/` directory.

---

## Citation

Page, L. M., H. Espinosa-Pérez, L. T. Findley, C. R. Gilbert, R. N. Lea,
N. E. Mandrak, R. L. Mayden, and J. S. Nelson. 2023.
*Common and Scientific Names of Fishes from the United States, Canada, and Mexico*,
8th edition. American Fisheries Society, Special Publication 36, Bethesda, Maryland.
