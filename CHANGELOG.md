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

### Database

Data version stays **FF-8.1**: no name was added, removed or renamed. Synonyms
moved, and the classification fields (class, order, family) were corrected.

- **Orders and families corrected.** 2,673 of 5,200 species (51%) had the wrong
  order, and 48 the wrong family. FISHFINDER never reads these fields, so name
  checking was unaffected, but anyone reusing the database got bad data. There
  was no Perciformes at all: perches, snappers and sculpins were filed under
  Tetraodontiformes, and catfishes under Gymnotiformes.
  - **The cause.** The book marks the 20 orders that are new since the 7th
    edition with `*` (`*ORDER SILURIFORMES`), and the parser only read headers
    that start with `ORDER`. It also missed `Gobiesocidae, En-clingfishes`, the
    one family header printed with a comma, so 43 clingfishes were filed as
    mullets. An older note blamed page boundaries; that diagnosis was wrong.
  - **A gap in the book.** The 8th edition omits ORDER CHARACIFORMES (p. 76).
    Characidae and Bryconidae (19 species) are now in Characiformes, where
    Eschmeyer's Catalog and the 7th edition put them.
  - **Two addenda placements.** The addenda's table split two genera across
    families. All five *Stathmonotus* are now in Labrisomidae, where the addenda
    and the catalog agree, and *Polymetme corythaeola* is in Phosichthyidae with
    its congener.
  - **Checked against Eschmeyer's Catalog classification:** 325 of 345 families
    get the same order. The other 20 are deliberate choices of the 8th edition,
    most documented in its Appendix 1 (e.g. mullets in Blenniiformes, following
    Dornburg & Near 2021). `classification_crosscheck.json` lists each with its
    reason.
- The removal note for *Gambusia clarkhubbsi* now cites the addenda as the rest
  of the database does ("H.J. Walker, Jr.").
- **Synonyms 10,152 → 10,090.**
  - **The cause.** Within an Eschmeyer catalog entry, the parser read every
    "Synonym of X" bullet as a former name of the page's species. A bullet is
    one author's placement. When an author put the entry under a different
    species, the parser still recorded X as a former name. *Ictalurus melas*
    shipped as an outdated name for Brown Bullhead because La Rivers (1994)
    filed *Pimelodus pullus* under it. It is the Black Bullhead, *Ameiurus
    melas*.
  - **The fix.** Such a name is now kept only if the page ties it to the
    species. Every rejected name was looked up on its own catalog page.
- **13 names now point at the right species**, among them:
  - *Ictalurus melas* → *A. melas*;
  - *Salmo clarkii* → *Oncorhynchus clarkii*;
  - *Semotilus margarita* → *Margariscus margarita*;
  - *Squalus mitsukurii* → *S. clarkae*, not *S. acanthias*.
- **63 names removed:**
  - 50 are valid species elsewhere, and had been sending authors to an
    unrelated fish (*Coris julis* → Tautog; *Conger conger*, *Osmerus
    eperlanus*, *Squalus megalops* likewise);
  - 7 are synonyms of species not on the List;
  - 4 are misspellings the engine already corrects;
  - 1 is a catalog artifact, and 1 has no catalog record.
  - Names in genera on the List are still flagged, as UNKNOWN.
- **12 rejected names kept with their old target.**
  - 9 because the 6th or 7th edition of *Names of Fishes* used them for the
    North American fish, though they belong elsewhere today:
    - *Antennarius striatus* → *A. scaber*;
    - *Microphis brachyurus* → *M. lineatus*, with *Oostethus brachyurus* and
      a catalog misspelling of it;
    - *Hirundichthys rondeletii* → *H. volador*;
    - *Proterorhinus marmoratus* → *P. semilunaris*;
    - *Merluccius angustimanus*, *Makaira mazara* and *Sciades hymenorrhinos*.
  - 3 by catalog evidence the check cannot read. *Sebastes marinus* is a
    misapplied-name entry for *S. norvegicus*, and *Gobiomorus lateralis* was
    used for *G. maculatus*.
- **Added:** *Sciades hymenorrhinus*, the 6th edition's spelling for what is
  now *S. dowii* (occurrence PM, Flapnose Sea Catfish).

### Interface

- The INFO panel's **Privacy** section now says which records are public (the
  ones behind the usage map), that REPORT submissions, including the optional
  email, are private to the maintainer, and which third parties a page view or
  a file load contacts. The old "no personal information" line contradicted
  the optional REPORT email and is gone.

### Accessibility

- **The accessibility audit is now a committed tool**, `tools/a11y-audit.js`
  (`npm run a11y` from `fishfinder/`). It measures WCAG 2.2 AA contrast and
  target size on the rendered page across both themes, two widths and four
  passes, and exits non-zero on any failure. No dependencies; not deployed.
- Its first run opened the INFO and REPORT panels, which the previous sweep had
  never measured, and found two live defects:
  - The REPORT panel's **GITHUB ISSUES** button rendered as underlined
    dark-green text on the dark button, **1.33:1**. An earlier fix for it was
    losing a cascade tie: `.info-panel a` has the same specificity as
    `a.device-btn` and comes later in the stylesheet.
  - The onboarding hint's dismiss button was **25×17 px**, under the 24×24
    minimum.
- Correction to the entry below: its phone-width measurements actually laid out
  at 474 px, because headless Chrome clamps a narrow window. The tool now pins
  the width exactly and warns if it cannot. Re-measured at a true 390 px:
  0 failures.

### Security

A security audit of the site, its hosting and its database (2026-09-25).
Fixed:

- **Issue reports were publicly readable.** Anyone could download every report
  sent with REPORT, including the optional email address. Reports are now
  private to the maintainer.
- **Database records could be overwritten or deleted by anyone**, the usage
  counters included, because Firebase does not validate deletes. Records are
  now create-only and the counters undeletable. Reads of the visit history are
  capped at 500 records.
- **Usage-map popups rendered database text as HTML.** Visit records can be
  written by anyone, so a crafted city name could have put links, forms or
  styles in front of every visitor. Popup text is now escaped.
- **The pdf.js worker loaded without an integrity hash**, and on every PDF load
  it came in through a pdf.js fallback that would have run a tampered CDN copy
  in the page. It is now hashed like every other CDN file, and pdf.js can no
  longer fetch it by itself.
- **Libraries.**
  - SheetJS **0.18.5 → 0.20.3**. CVE-2023-30533 and CVE-2024-22363: a crafted
    spreadsheet could pollute object prototypes or stall the tab. It now comes
    from SheetJS's own CDN, since the fix never reached npm or cdnjs.
  - mammoth **1.6.0 → 1.12.3**, for CVE-2025-11849, which was not reachable
    from the browser.
  - pdf.js now runs with `isEvalSupported: false` (CVE-2024-4367, already
    blocked by the CSP).
- **CSP.** Moved ahead of the font stylesheet, which it previously missed.
  Added `object-src 'none'`, `base-uri 'self'` and `form-action 'self'`, and
  removed `'unsafe-inline'` from `style-src`.
- **Script loading.** A failed CDN load is now retried instead of treated as
  loaded, which also removes a race between the dashboard and REPORT.
- **The map can no longer be pinned.** It shows the newest 500 visits by time.
  It used to order by record key, which a writer could choose so that a record
  stayed on the map indefinitely.
- **Visit records store less.** New records keep coordinates rounded to ~1 km
  and the hour, not the millisecond.
- **Deploy workflow.** The actions are pinned to commit SHAs and kept current by
  Dependabot. There are no workflow-level permissions, and checkout keeps no
  token.
- **Repository.**
  - Secret scanning with push protection, Dependabot alerts and private
    vulnerability reporting are on.
  - `main` can no longer be deleted or force-pushed.
  - Actions are limited to GitHub's own, and must be pinned by SHA.
- **Domain.**
  - fishnames.net is verified with GitHub, so no other account can claim it.
  - It is signed with DNSSEC.
  - CAA limits certificate issuance to Let's Encrypt plus the certificate
    authorities Cloudflare adds automatically.
  - SPF and DMARC records make mail forged "from" fishnames.net get rejected.
- **Meta-analysis lockfile.** Pillow 12.2.0 → 12.3.0, clearing 13 Dependabot
  advisories. None was reachable: Pillow is only matplotlib's image back end,
  and the pipeline never opens an outside image.

Added:

- `SECURITY.md`: how to report a vulnerability privately, and what is public by
  design.
- `test/security.test.js`: 27 tests, bringing the suite to 226. Run against the
  pre-audit code, 19 of them fail.
- `tools/csp-smoke.js` (`npm run csp`): a headless-Chrome check that fails on any
  CSP violation or integrity failure. Its tamper passes swap CDN files for
  hostile code and confirm none of it runs.

### Internal

- **`verify_chain_names.py`**, a new pipeline step between the scrape and the
  map build.
  - It looks up each name the chain check rejects on the name's own catalog
    page. It reads the current status and whether the catalog cites the 6th
    or 7th edition list (Nelson et al. 2004, Page et al. 2013) for the name.
  - It writes a verdict per name to the committed `chain_verdicts.json`, which
    the map build applies.
  - 22 verdicts were decided by hand. They record the evidence (catalog
    entries, ITIS, WoRMS) and are never overwritten.
- Tests: 11 parser and verification tests in `test_scraper_parsing.py`, and 11
  engine tests in `classify.test.js` (suite now 237).
- **`parse_pdf.py` now stops on a header it cannot read**, instead of filing the
  following species under the previous taxon. It also stops if a family header
  repeats, or if the Characiformes correction stops being needed.
- **`verify_classification.py`**, a new check of the database's orders against
  Eschmeyer's Catalog classification. It writes `classification_crosscheck.json`
  (committed) and fails on any difference without a recorded reason. Run on the
  old database, it reports 138 unexplained families.
- **The overlay's invariants cover classification:** every species has a class,
  order and family, each family has one order, and each genus has one family.
  The build refuses to write a database that breaks them.
- Tests: 12 header tests in `test_parse_pdf.py`, and 15 classification tests in
  `taxonomy.test.js` (suite now 252).

---

## 2026-09-23 — abbreviated genus names, prose demote, accessibility sweep

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
