# Changelog

All notable changes to FISHFINDER — the database, the classification engine, and
the interface.

The **data version** (`FF-8.x`, shown on the device badge and in
`fishfinder/data/fish_names.json` under `metadata.data_version`) tracks the
*database* only. Engine and interface changes are listed under the date they
shipped and do not move it.

The companion paper in *Fisheries* describes **FF-8.0**. Its figures are a
snapshot of that version and are deliberately not revised here; this file is the
record of what has changed since, and the numbers below are the ones a future
update publication should cite.

---

## Unreleased

### Engine

- **Abbreviated genus names are now detected.** Journals abbreviate the genus
  after first mention, so most mentions of a species in a real manuscript are
  written `P. olivaris` rather than *Pylodictis olivaris*. None of the previous
  extraction patterns could match a genus containing a period, so those mentions
  were invisible — a manuscript was effectively checked at first mention only.
  An abbreviation is resolved against genera spelled out **elsewhere in the same
  text**, so the genus is always one the author actually wrote.
  - Resolution requires the epithet to be within edit distance 2 of one the
    resolved genus really uses. This gate is what stops the pass inventing a
    binomial: without it `C. catla` becomes *Cyprinus catla* when the author
    meant *Catla*. A misspelling is within distance 2 by definition, so the gate
    costs nothing.
  - Ties are broken by epithet distance, then by preferring a valid name over a
    synonym (`S. namaycush` is *Salvelinus*, not *Salmo*), then by the nearest
    spelled-out mention. Genuine ties are declined rather than guessed.
  - Synonym genera are indexed too, so `S. vitreum` still reports *Sander
    vitreus*.
  - Corrections preserve the author's abbreviation — `P. olivarus` becomes
    `P. olivaris` — except when the genus itself changes, where the new genus is
    spelled out so the change is not hidden behind an initial.
  - Measured over 95 fisheries papers: **602 abbreviated mentions resolved**
    (487 valid, 54 changed, 45 outdated, **16 genuine misspellings**, 0 unknown),
    with 61 of 95 papers containing at least one.
- **Prose matches are demoted instead of reported as errors.** A genus followed
  by an ordinary English word reads as a binomial to the extractor
  ("Ranzania includes", "Bagre mainly"). These now sink into a collapsed
  low-confidence group rather than appearing as issues, and are excluded from
  the corrected text — previously "Auxis may" could be silently rewritten to
  *Auxis rochei*. Demoted, never suppressed: 199 real epithets are also ordinary
  English words (*Hypanus say*, *Haemulon album*, *Etheostoma obama*), and the
  rule subtracts the live database so it can never demote a real name.
- **Classical `ae-` / `e-` epithet spellings now match.** All 14 `ae-` epithets
  in the database had an unreachable `e-` variant, because `a` and `e` are 4
  character codes apart and the first-letter filter allows 2 — *Alosa
  estivalis*, *Melanogrammus eglefinus* and *Icosteus enigmaticus* all classified
  as UNKNOWN. The exemption is deliberately narrow rather than a wider threshold:
  of the 16 within-genus epithet pairs that the filter currently blocks (*Coregonus
  hoyi*/*kiyi*, *Percina maculata*/*bimaculata* among them), not one is an `a`/`e`
  pair, so this recovers all 14 names at no measured cost.

### Interface

- Low-confidence matches appear in a collapsed group below the issues table. The
  issues badge now counts the rows actually shown; it previously reported a
  pre-deduplication total and could claim more issues than it listed.
- An abbreviated mention shows the form as written (`P. olivarus`) beside the
  expanded name, so a reader can find it in their manuscript. A valid abbreviated
  mention folds into the spelled-out species row rather than repeating it.

### Accessibility

- **Full contrast and target-size sweep**, measured from rendered screenshot
  pixels rather than CSS values, across desktop and phone widths in both the
  default and HI-CON themes. 23 failures found and fixed; the page now measures
  **0 failures** in all four configurations, and every interactive target clears
  24×24 (inline links in running prose are exempt under WCAG 2.5.8).
  - Fixed: `--lcd-muted` (4.07:1), `.common-name`, `.confirm-hint` (3.21:1), the
    data-version badge (3.65:1), `COPY CITATIONS` and `CHIP IN A BUCK` (3.70:1),
    the consent `Decline` label (4.18:1), and the addenda badge (2.96:1).
  - Pixel sampling matters: the housing, footer and buttons are gradients, and
    the real background behind the version badge is lighter than its CSS
    mid-stop. Reading CSS alone is what let `.privacy-link` ship at 3.10:1.

### Internal

- `runCheck` and `copyText` shared one duplicated scan pipeline with two
  different result shapes; both now call a single `scanText`, so the displayed
  results and the copied text cannot disagree.
- Test suite: 139 → **199 tests**, adding `test/abbrev.test.js` and
  `test/low-confidence.test.js`.

---

## 2026-09-23 — synonym map rebuild

### Database

- **Synonyms 8,853 → 10,152.** Four defects in the Eschmeyer catalog parser were
  found and fixed (`bee429a`):
  - the entry scan could start mid-word in capitalized text, which had shipped 36
    junk synonyms such as "Bering sland" from "Unalaska Island, Bering Sea";
  - trinomial headers never matched, so subspecies status lines were attributed
    to the preceding entry (+471 names);
  - hyphenated epithets were truncated at the hyphen, producing phantom names
    like "Hybopsis x";
  - the author token accepted ASCII only, so `Lütken` and `Günther` never
    matched — **324 pages had no usable header at all**, and 250 were recovered.
- `metadata.synonym_accessed` records the date the catalog was actually queried
  over the network (2026-09-22), separately from the rebuild date.

### Interface

- Database Coverage panel: species, genera and synonym counts, geographic
  coverage, trilingual common-name counts and data version, all counted from the
  loaded database at runtime rather than written into the markup (`77895e6`).
- The Eschmeyer citation shows the real access date instead of the visitor's
  current year. The device footer was reduced to the privacy link (`3e91e7b`),
  which was relabelled "Privacy Settings" and brought up to AA (`c614964`).

---

## 2026-09-21 — FF-8.1: the 2025 addenda

### Database

- Applied *Addenda, corrigenda, et explanenda to Common and Scientific Names of
  Fishes, Eighth Edition* (Schmitter-Soto et al. 2026, *Fisheries* 51(5):225–227,
  doi:10.1093/fshmag/vuaf083) — the Committee's first published update to the
  8th edition.
- **Species 5,086 → 5,200; genera 1,493 → 1,507.** From 244 species rows: 115
  additions, 22 renames, 1 removal, 103 in-place updates.
- Five transcription errors in the addenda's supplementary table are corrected
  against Eschmeyer, so the site deliberately differs from the printed addenda on
  those names. The difference is disclosed in the INFO panel.
- New `removed_names` key: a species withdrawn from the List now explains itself
  rather than reporting as a bare UNKNOWN.

### Interface

- Data version rendered from `metadata.data_version` into the model badge, footer
  and coverage line; "What's new in FF-8.1" and "Where FISHFINDER differs from
  the printed addenda" sections added to the INFO panel.

---

## 2026-09-11 — self-hosted basemap

- The usage map drew from CARTO's keyless tile CDN, which began stamping
  "API KEY REQUIRED" across every tile. Replaced with a self-hosted vector
  outline (`fishfinder/data/world-110m.json`, Natural Earth 1:110m, public
  domain), removing an external host and one CSP domain. Palette sampled from a
  real CARTO tile so the appearance is unchanged.

---

## 2026-07-15 — FF-8.0 (the published baseline)

**5,086 species · 8,729 synonyms · 1,493 genera.** This is the version the
*Fisheries* companion paper describes, and these numbers are deliberately frozen.

- Round-2 review fix: a scraped synonym is now excluded when it is valid in
  Eschmeyer as well as when it is valid in the List, which protects valid
  *extralimital* species from being recorded as synonyms of their North American
  congeners (*Misgurnus fossilis*, *Platichthys flesus*, *Ariopsis seemanni* and
  8 others). Synonyms 8,740 → 8,729; the verified list is
  `extralimital_valids.json`.

---

## Earlier

- **2026-06-08** — custom domain `fishnames.net`; support module; GitHub Actions
  bumped to Node 24 runtimes.
- **2026-05-26** — HI-CON high-contrast theme and first-visit onboarding banner,
  both added in response to *Fisheries* reviewer comments.
- **2026-04-02** — Damerau-Levenshtein distance, so a transposition
  ("Cyrpinus" → "Cyprinus") costs one edit rather than two; confidence and edit
  distance added to classification results.
- **2026-03-31** — hyphenated epithet extraction (*Erimystax x-punctatus*) and
  short-genus extraction validated against the database (*Zu cristatus*).
