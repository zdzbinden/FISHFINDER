<p align="center">
  <img src="fishfinder/data/logo.png" alt="FISHFINDER logo" width="300"/>
</p>

<h1 align="center">FISHFINDER</h1>

<p align="center">
  <strong>Validate scientific fish names against the AFS/ASIH standard</strong><br>
  <em>Common and Scientific Names of Fishes from the United States, Canada, and Mexico</em>, 8th edition (Page et al., 2023)
</p>

---

Keeping up with fish taxonomy is hard. Names get revised, genera get
reshuffled, and the 8th edition introduced hundreds of changes. **FISHFINDER**
scans your manuscript text and flags every scientific fish name that is outdated,
misspelled, or changed since the previous edition -- so you can submit with
confidence.

## What it does

Paste your text, hit **SCAN**, and every binomial is color-coded:

| Color | Meaning |
|-------|---------|
| **Green** | Valid in the 8th edition |
| **Blue** | Valid but changed since the 7th edition -- confirm the intended species |
| **Orange** | Outdated synonym -- suggested replacement shown |
| **Red** | Likely misspelling -- closest match shown |
| **Purple** | Genus looks fish-like but no species match found |

Hover any highlighted name to see its common name or correction.
Click **COPY** to get your text back with outdated names auto-replaced.

## Try it

> **Live site:** [fishnames.net](https://fishnames.net/)

To run locally:

```
cd fishfinder
python -m http.server 8080
# open http://localhost:8080
```

## How the data is built

The name database is assembled in two stages:

1. **Parse** the AFS table PDF (~5,086 species with full metadata)
2. **Enrich** with synonyms scraped from [Eschmeyer's Catalog of Fishes](https://researcharchive.calacademy.org/research/ichthyology/catalog/fishcatmain.asp) (genus transfers, strict synonyms, and historical synonym chains)

See [`fishfinder/README.md`](fishfinder/README.md) for full pipeline documentation.

## Repository layout

```
FISHFINDER/
├── parse_pdf.py              # Step 1: AFS table PDF → fish_names.json
├── scrape_eschmeyer.py       # Step 2: synonym enrichment from Eschmeyer's
├── database.rules.json       # Firebase Realtime DB security rules
├── .github/workflows/        # GitHub Actions deploy workflow
├── fishfinder/               # Static web app (GitHub Pages)
│   ├── index.html
│   ├── css/style.css         # Retro Lowrance fish-finder aesthetic
│   ├── js/engine.js          # Classification engine (shared browser/Node.js)
│   ├── js/app.js             # UI, Firebase analytics, event handling
│   ├── data/fish_names.json  # Generated name database
│   ├── test/                 # Automated test suite (Node.js)
│   ├── robots.txt            # Crawler directives
│   └── sitemap.xml           # Sitemap for search engines
├── meta_analysis/            # Automated literature analysis pipeline
├── names_of_fishes/          # Source PDFs (copyrighted, not in repo)
└── publication/              # Companion manuscript materials
```

## Citation

Page, L. M., H. Espinosa-Perez, L. T. Findley, C. R. Gilbert, R. N. Lea,
N. E. Mandrak, R. L. Mayden, and J. S. Nelson. 2023.
*Common and Scientific Names of Fishes from the United States, Canada, and
Mexico*, 8th edition. American Fisheries Society, Special Publication 36,
Bethesda, Maryland.

## License

FISHFINDER source code is licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).
See [LICENSE](LICENSE) for the full text and [NOTICE](NOTICE) for attribution
of the underlying fish name data.

**Free for noncommercial use**, including:

- Academic research and teaching at universities and colleges
- Government agencies (federal, state, tribal, provincial, municipal)
- Public research organizations and natural history museums
- Environmental and conservation nonprofits
- Personal study, hobby projects, and amateur ichthyology

**Commercial use requires a separate license.** This includes for-profit
publishers, commercial copy-editing services, and any other use intended to
generate revenue. To inquire about commercial licensing, please open an issue
on the [GitHub repository](https://github.com/zdzbinden/FISHFINDER).

The underlying fish name database is derived from Page et al. 2023 (cited
above) and remains the intellectual property of the American Fisheries
Society. It is reproduced here for scholarly name verification and is **not**
covered by the PolyForm Noncommercial license. See [NOTICE](NOTICE) for
details.
