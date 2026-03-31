"""Shared configuration for the FISHFINDER meta-analysis pipeline."""

from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
HERE = Path(__file__).parent
CACHE_DIR = HERE / 'cache'
PAPERS_CACHE = CACHE_DIR / 'papers.json'
PDF_DIR = CACHE_DIR / 'pdfs'
TEXT_DIR = CACHE_DIR / 'texts'
RESULTS_DIR = CACHE_DIR / 'results'
SUMMARY_FILE = CACHE_DIR / 'summary.json'
SUMMARY_MD = CACHE_DIR / 'summary.md'
FIGURES_DIR = CACHE_DIR / 'figures'

ENGINE_SCRIPT = HERE / '04_analyze_names.js'
FISH_NAMES_JSON = HERE.parent / 'fishfinder' / 'data' / 'fish_names.json'

# ── API Configuration ────────────────────────────────────────────────────────
# OpenAlex: free, no auth required. Providing email gets you into the
# "polite pool" with faster rate limits.
OPENALEX_API = 'https://api.openalex.org/works'
OPENALEX_EMAIL = 'zach.zbinden@umces.edu'

# Unpaywall: free, just needs email for identification.
UNPAYWALL_API = 'https://api.unpaywall.org/v2'
UNPAYWALL_EMAIL = OPENALEX_EMAIL  # Same email for both

# ── Rate Limiting ────────────────────────────────────────────────────────────
OPENALEX_DELAY = 0.2    # 200ms between requests (limit is 10 req/s)
UNPAYWALL_DELAY = 1.0   # 1s between Unpaywall requests
PDF_DOWNLOAD_DELAY = 2.0 # 2s between PDF downloads (courtesy to publishers)

# ── Search Configuration ─────────────────────────────────────────────────────
# OpenAlex concept ID for Fish (Actinopterygii) — ensures results are
# actually about fishes, not general biodiversity/ecology papers.
FISH_CONCEPT_ID = 'C2909208804'

# Restrict to papers with at least one author at a US, Canadian, or
# Mexican institution.  This biases toward North American study systems
# (OpenAlex has no "study area" filter, so institution country is the
# best available proxy).
INSTITUTION_COUNTRIES = 'US|CA|MX'

# OpenAlex filters (applied to all queries)
MIN_YEAR = 2024        # Post-AFS 8th edition (published Aug 2023)
LANGUAGE = 'en'
MAX_PAPERS = 500       # Discovery target (cast wide; download rate ~25%)
PER_PAGE = 200         # Max results per API page (fewer round-trips)
MAX_PAGES = 50         # Safety cap on total pages fetched

# Stop downloading once this many usable PDFs are on disk.
MIN_USABLE_PDFS = 115

# Title keywords — a paper must contain at least one of these (case-
# insensitive) to be accepted.  The goal is multi-species field studies
# that would benefit from FISHFINDER-style nomenclature checking.
TITLE_INCLUDE = [
    'fish assemblage', 'fish community', 'fish species',
    'fish diversity', 'fish composition', 'fish fauna',
    'fish survey', 'fish richness', 'fish population',
    'ichthyofauna', 'freshwater fish', 'reef fish',
    'stream fish', 'river fish', 'marine fish',
    'fish checklist', 'fish inventory',
    'larval fish', 'juvenile fish', 'demersal fish',
    'fish abundance', 'fish distribution', 'fish sampling',
    'fish conservation', 'fish habitat', 'fish monitoring',
    'native fish', 'invasive fish', 'nonnative fish',
    'non-native fish', 'threatened fish', 'endangered fish',
]

# Papers whose titles match any of these patterns are excluded even if
# they match TITLE_INCLUDE — they rarely contain species checklists.
TITLE_EXCLUDE = [
    'aquaculture', 'fish oil', 'fish meal', 'fish feed',
    'fish consumption', 'fish product', 'fish market',
    'fish protein', 'fish fillet', 'fish flesh',
    'microbiome', 'microbiota', 'gut bacteria',
    'zebrafish', 'danio rerio',
    'review', 'meta-analysis', 'systematic review',
    'erratum', 'corrigendum', 'correction', 'retraction',
    'book review',
]

# ── Analysis Configuration ───────────────────────────────────────────────────
# Papers where fewer than this fraction of classified species are in the
# AFS database (valid/changed/outdated/misspelled vs total) are flagged
# as non-North-American studies and excluded from the main statistics.
NA_SPECIES_RATIO_THRESHOLD = 0.3

# ── User-Agent ───────────────────────────────────────────────────────────────
USER_AGENT = (
    'FISHFINDER-MetaAnalysis/1.0 '
    f'(mailto:{OPENALEX_EMAIL}; '
    'https://github.com/zdzbinden/FISHFINDER)'
)
