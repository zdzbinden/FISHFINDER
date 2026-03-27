/**
 * FISHFINDER — app.js
 * All processing is client-side. No server calls after initial JSON load.
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  let db          = null;
  let validSet    = new Set();   // lowercase binomials → canonical form
  let validMap    = new Map();   // lowercase  → canonical cased binomial
  let synonymMap  = new Map();   // lowercase old name → canonical new name
  let generaSet   = new Set();   // lowercase genus strings
  let commonNameMap = new Map(); // lowercase common name → {binomial, commonName}
  let validList   = [];          // [{genus, species, binomial}] for fuzzy scan

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const loadingEl      = document.getElementById('loading');
  const loadErrorEl    = document.getElementById('load-error');
  const checkBtn       = document.getElementById('check-btn');
  const clearBtn       = document.getElementById('clear-btn');
  const copyBtn        = document.getElementById('copy-btn');
  const loadBtn        = document.getElementById('load-btn');
  const infoBtn        = document.getElementById('info-btn');
  const citeBtn        = document.getElementById('cite-btn');
  const infoModal      = document.getElementById('info-modal');
  const modalClose     = document.getElementById('modal-close');
  const fileInput      = document.getElementById('file-input');
  const fileNameEl     = document.getElementById('file-name');
  const textarea       = document.getElementById('manuscript-text');
  const resultsSection = document.getElementById('results-section');
  const highlightedEl  = document.getElementById('highlighted-text');
  const speciesCountEl = document.getElementById('species-count');
  const noIssuesEl     = document.getElementById('no-issues');
  const summaryTable   = document.getElementById('summary-table');
  const summaryTbody   = document.getElementById('summary-tbody');
  const issueBadge     = document.getElementById('issue-count');

  // ── Database loading ──────────────────────────────────────────────────────
  async function loadDatabase() {
    loadingEl.hidden   = false;
    loadErrorEl.hidden = true;
    checkBtn.disabled  = true;

    try {
      const resp = await fetch('data/fish_names.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      db = await resp.json();
    } catch (err) {
      loadingEl.hidden   = true;
      loadErrorEl.hidden = false;
      console.error('Failed to load fish_names.json:', err);
      return;
    }

    // Build lookup structures
    for (const [canonical] of Object.entries(db.valid_names)) {
      const lower = canonical.toLowerCase();
      validSet.add(lower);
      validMap.set(lower, canonical);

      const parts = canonical.split(' ');
      validList.push({
        genus:    parts[0],
        species:  parts.slice(1).join(' '),
        binomial: canonical,
        lGenus:   parts[0].toLowerCase(),
        lSpecies: parts.slice(1).join(' ').toLowerCase(),
      });
    }

    // Build common name lookup
    for (const [canonical, info] of Object.entries(db.valid_names)) {
      const cn = info.common_name_en;
      if (cn) commonNameMap.set(cn.toLowerCase(), { binomial: canonical, commonName: cn });
    }

    for (const [oldName, newName] of Object.entries(db.synonyms)) {
      synonymMap.set(oldName.toLowerCase(), newName);
    }

    for (const genus of db.genera) {
      generaSet.add(genus.toLowerCase());
    }

    loadingEl.hidden  = true;
    checkBtn.disabled = false;

    console.log(
      `Database loaded: ${validSet.size} valid names, ` +
      `${synonymMap.size} synonyms, ${generaSet.size} genera, ` +
      `${commonNameMap.size} common names`
    );
  }

  // ── Levenshtein distance (Wagner-Fischer, with early-exit) ────────────────
  function levenshtein(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
    const m = a.length, n = b.length;
    // Use two rows
    let prev = new Uint16Array(n + 1);
    let curr = new Uint16Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > maxDist) return maxDist + 1; // prune
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  // ── Find closest valid binomial ────────────────────────────────────────────
  function findClosestMatch(genus, species, maxDist) {
    const lg = genus.toLowerCase();
    const ls = species.toLowerCase();
    let bestDist   = maxDist + 1;
    let bestName   = null;

    for (const entry of validList) {
      // First-letter filter on genus (fast rejection)
      if (entry.lGenus[0] !== lg[0]) continue;
      // Length filter
      if (Math.abs(entry.lGenus.length  - lg.length) > maxDist) continue;

      const gd = levenshtein(lg, entry.lGenus, maxDist);
      if (gd > maxDist) continue;

      // First-letter filter on species
      if (entry.lSpecies[0] !== ls[0] &&
          Math.abs(entry.lSpecies.charCodeAt(0) - ls.charCodeAt(0)) > 2) continue;

      const sd = levenshtein(ls, entry.lSpecies, maxDist);
      const total = gd + sd;

      if (total < bestDist) {
        bestDist = total;
        bestName = entry.binomial;
        if (total === 0) break; // exact (shouldn't happen here but be safe)
      }
    }
    return bestName ? { name: bestName, dist: bestDist } : null;
  }

  // Species abbreviations that should never be treated as epithets
  const SPECIES_ABBREVS = new Set(['sp', 'spp', 'cf', 'aff', 'nr', 'var', 'subsp']);

  // ── Classify a candidate binomial ──────────────────────────────────────────
  // Returns null if the name doesn't look like a fish name at all.
  function classifyName(genus, species) {
    if (SPECIES_ABBREVS.has(species.toLowerCase())) return null;

    const binomial = `${genus} ${species}`;
    const lower    = binomial.toLowerCase();

    // 1. Exact valid match
    if (validSet.has(lower)) {
      const canonical  = validMap.get(lower);
      const info       = db.valid_names[canonical];
      const commonName = info ? (info.common_name_en || '') : '';
      const changed    = info && info.flags && info.flags.includes('*');
      return { type: changed ? 'changed' : 'valid', canonical, suggestion: null, commonName };
    }

    // 2. Known synonym / outdated name
    if (synonymMap.has(lower)) {
      return { type: 'outdated', canonical: binomial, suggestion: synonymMap.get(lower) };
    }

    // 3. Common name match
    const commonMatch = commonNameMap.get(lower);
    if (commonMatch) {
      return {
        type: 'common', canonical: binomial,
        suggestion: commonMatch.binomial, commonName: commonMatch.commonName,
      };
    }

    // 4. Exact genus → fuzzy species match or unknown species
    if (generaSet.has(genus.toLowerCase())) {
      const closest = findClosestMatch(genus, species, 2);
      if (closest && closest.dist <= 2) {
        return { type: 'misspelled', canonical: binomial, suggestion: closest.name };
      }
      return { type: 'unknown', canonical: binomial, suggestion: null };
    }

    // 5. Fuzzy full binomial (catches misspelled genera like Micropteris → Micropterus)
    const closest = findClosestMatch(genus, species, 2);
    if (closest && closest.dist <= 2) {
      return { type: 'misspelled', canonical: binomial, suggestion: closest.name };
    }

    // 6. Not a fish name
    return null;
  }

  // ── Extract candidate names from text ─────────────────────────────────────
  // Matches: Capitalized word (≥3 chars) followed by lowercase word (≥3 chars)
  // Optionally a second lowercase word (subspecies) is captured but the binomial
  // checked is always genus + species (first two words).
  const CANDIDATE_RE = /\b([A-Z][a-z]{2,})\s+([a-z]{2,})\b/g;

  function extractCandidates(text) {
    const hits = [];
    let m;
    CANDIDATE_RE.lastIndex = 0;
    while ((m = CANDIDATE_RE.exec(text)) !== null) {
      hits.push({
        genus:   m[1],
        species: m[2],
        text:    m[0],
        index:   m.index,
      });
    }
    return hits;
  }

  // ── HTML escaping ──────────────────────────────────────────────────────────
  function esc(str) {
    return str
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  // ── Build corrected plain text (replace correctable names) ────────────────
  function buildCorrectedText(text, findings) {
    // Work backwards to preserve index positions
    const correctable = findings
      .filter(f => f.suggestion && (f.type === 'outdated' || f.type === 'misspelled'))
      .sort((a, b) => b.index - a.index);

    let out = text;
    for (const f of correctable) {
      out = out.slice(0, f.index) + f.suggestion + out.slice(f.index + f.text.length);
    }
    return out;
  }

  // ── Main check logic ───────────────────────────────────────────────────────
  function runCheck() {
    if (!db) return;

    const text = textarea.value;
    if (!text.trim()) {
      alert('No text to scan — paste manuscript text first.');
      return;
    }

    checkBtn.disabled    = true;
    checkBtn.textContent = 'SCANNING…';

    // Yield to browser to update button state, then process
    setTimeout(() => {
      const candidates = extractCandidates(text);
      const findings   = [];

      for (const cand of candidates) {
        const result = classifyName(cand.genus, cand.species);
        if (!result) continue;
        findings.push({
          text:       cand.text,
          binomial:   `${cand.genus} ${cand.species}`,
          index:      cand.index,
          type:       result.type,
          suggestion: result.suggestion,
          commonName: result.commonName || '',
        });
      }

      // Track species count (non-blocking)
      trackSpecies(findings.length);

      // ── Render species list
      highlightedEl.innerHTML = buildSpeciesListHTML(findings);

      // ── Render summary table
      const issues = findings.filter(f => f.type !== 'valid' && f.type !== 'common');

      if (issues.length === 0) {
        noIssuesEl.hidden  = false;
        summaryTable.hidden = true;
        issueBadge.textContent = '';
      } else {
        noIssuesEl.hidden   = true;
        summaryTable.hidden = false;
        issueBadge.textContent = String(issues.length);

        // Deduplicate by binomial (keep first occurrence)
        const seen    = new Set();
        const deduped = [];
        for (const f of issues) {
          if (!seen.has(f.binomial)) {
            seen.add(f.binomial);
            deduped.push(f);
          }
        }

        const labels = {
          changed:    'Changed in 8th edition',
          outdated:   'Outdated / Synonym',
          misspelled: 'Misspelled',
          unknown:    'Unknown fish name',
        };

        summaryTbody.innerHTML = '';
        for (const f of deduped) {
          let suggestionCell;
          if (f.type === 'changed') {
            suggestionCell = f.commonName
              ? `Now: <em>${esc(f.commonName)}</em> &mdash; confirm intended species`
              : 'Confirm this is the intended species';
          } else if (f.suggestion) {
            const suggInfo    = db.valid_names[f.suggestion];
            const suggCommon  = suggInfo ? (suggInfo.common_name_en || '') : '';
            suggestionCell    = `<em>${esc(f.suggestion)}</em>` +
              (suggCommon ? ` <span class="common-name">(${esc(suggCommon)})</span>` : '');
          } else {
            suggestionCell = '—';
          }

          const tr = document.createElement('tr');
          tr.innerHTML =
            `<td class="name-cell">${esc(f.binomial)}</td>` +
            `<td><span class="status-${f.type}">${labels[f.type] || f.type}</span></td>` +
            `<td>${suggestionCell}</td>`;
          summaryTbody.appendChild(tr);
        }
      }

      resultsSection.hidden = false;
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

      checkBtn.disabled    = false;
      checkBtn.textContent = 'SCAN';
    }, 10);
  }

  // ── Copy corrected text to clipboard ──────────────────────────────────────
  function copyText() {
    const text     = textarea.value;
    const findings = [];
    const cands    = extractCandidates(text);

    for (const cand of cands) {
      const result = classifyName(cand.genus, cand.species);
      if (!result) continue;
      findings.push({
        text:       cand.text,
        index:      cand.index,
        type:       result.type,
        suggestion: result.suggestion,
      });
    }

    const corrected = buildCorrectedText(text, findings);
    navigator.clipboard.writeText(corrected).then(() => {
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = prev; }, 2000);
    }).catch(() => {
      // Fallback for browsers without clipboard API
      const ta = document.createElement('textarea');
      ta.value = corrected;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = 'COPY'; }, 2000);
    });
  }

  // ── Lazy script loader (CDN libraries loaded on first use) ────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + src.split('/').pop()));
      document.head.appendChild(s);
    });
  }

  const CDN = {
    mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    xlsx:    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    pdfjs:   'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfjsW:  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  };

  // ── File upload handling ────────────────────────────────────────────────────
  async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    fileNameEl.textContent = 'Reading\u2026';
    let text = '';

    try {
      switch (ext) {
        case 'txt': case 'csv':
          text = await file.text();
          break;
        case 'docx':
          await loadScript(CDN.mammoth);
          text = await extractDocx(file);
          break;
        case 'xlsx': case 'xls':
          await loadScript(CDN.xlsx);
          text = await extractXlsx(file);
          break;
        case 'pdf':
          await loadScript(CDN.pdfjs);
          pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsW;
          text = await extractPdf(file);
          break;
        default:
          throw new Error('Unsupported file type: .' + ext);
      }
      textarea.value = text;
      fileNameEl.textContent = file.name;
    } catch (err) {
      fileNameEl.textContent = '';
      alert('Error reading file: ' + err.message);
    }

    fileInput.value = '';   // reset so same file can be re-selected
  }

  async function extractDocx(file) {
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value;
  }

  async function extractXlsx(file) {
    const buf = await file.arrayBuffer();
    const wb  = XLSX.read(buf);
    return wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  }

  async function extractPdf(file) {
    const buf  = await file.arrayBuffer();
    const pdf  = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' '));
    }
    return pages.join('\n');
  }

  // ── Build species list HTML (replaces full-text highlight) ──────────────────
  function buildSpeciesListHTML(findings) {
    const seen = new Map();
    for (const f of findings) {
      if (!seen.has(f.binomial)) seen.set(f.binomial, f);
    }

    speciesCountEl.textContent = seen.size ? String(seen.size) : '';

    if (seen.size === 0) {
      return '<div class="species-empty">No species names detected</div>';
    }

    let html = '';
    for (const [, f] of seen) {
      html += '<div class="species-row">';
      html += `<span class="hl ${f.type}"><em>${esc(f.binomial)}</em></span>`;

      if (f.commonName) {
        html += ` <span class="common-name">${esc(f.commonName)}</span>`;
      }

      if (f.type === 'common' && f.suggestion) {
        html += ` &rarr; <em>${esc(f.suggestion)}</em>`;
      } else if (f.suggestion && (f.type === 'outdated' || f.type === 'misspelled')) {
        const suggInfo   = db.valid_names[f.suggestion];
        const suggCommon = suggInfo ? (suggInfo.common_name_en || '') : '';
        html += ` &rarr; <em>${esc(f.suggestion)}</em>`;
        if (suggCommon) html += ` <span class="common-name">(${esc(suggCommon)})</span>`;
      }

      if (f.type === 'changed' && f.commonName) {
        html += ' <span class="confirm-hint">confirm species</span>';
      }

      html += '</div>';
    }
    return html;
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  loadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);
  checkBtn.addEventListener('click', runCheck);

  clearBtn.addEventListener('click', () => {
    textarea.value          = '';
    resultsSection.hidden   = true;
    fileNameEl.textContent  = '';
  });

  copyBtn.addEventListener('click', copyText);

  // Allow Ctrl/Cmd+Enter to trigger check
  textarea.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runCheck();
  });

  // ── Firebase config ────────────────────────────────────────────────────────
  // To enable the usage dashboard:
  //  1. Go to console.firebase.google.com → create a project
  //  2. Add a Realtime Database (start in test mode for now)
  //  3. Replace the values below with your project's config
  //  4. In Firebase Console → Realtime Database → Rules, use:
  //     { "rules": { "fishfinder": { ".read": true, ".write": true } } }
  const FIREBASE_CONFIG = {
    apiKey:            'AIzaSyBi-nz0TTX502uIqyXx5MsohvwHf0H8KAU',
    authDomain:        'fishfinder-e914a.firebaseapp.com',
    databaseURL:       'https://fishfinder-e914a-default-rtdb.firebaseio.com',
    projectId:         'fishfinder-e914a',
    storageBucket:     'fishfinder-e914a.firebasestorage.app',
    messagingSenderId: '971130529851',
    appId:             '1:971130529851:web:2aec86db0aaabcd8df541e',
  };
  const TRACKING_ENABLED = FIREBASE_CONFIG.databaseURL !== 'https://YOUR_PROJECT-default-rtdb.firebaseio.com';

  let _fbDb = null;

  async function initFirebase() {
    if (_fbDb) return _fbDb;
    await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js');
    if (!window.firebase.apps.length) window.firebase.initializeApp(FIREBASE_CONFIG);
    _fbDb = window.firebase.database();
    return _fbDb;
  }

  function loadStyle(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }

  // ── Track visit (once per session) ────────────────────────────────────────
  async function trackVisit() {
    if (!TRACKING_ENABLED) return;
    if (sessionStorage.getItem('ff_tracked')) return;
    try {
      const geo = await fetch('https://ipapi.co/json/').then(r => r.json());
      if (!geo || !geo.latitude) return;
      const fbDb = await initFirebase();
      await fbDb.ref('fishfinder/visits').push({
        lat:     geo.latitude,
        lng:     geo.longitude,
        country: geo.country_name || '',
        city:    geo.city || '',
        ts:      Date.now(),
      });
      await fbDb.ref('fishfinder/stats/sessions').transaction(v => (v || 0) + 1);
      sessionStorage.setItem('ff_tracked', '1');
    } catch (e) {
      console.warn('Analytics unavailable:', e.message);
    }
  }

  // ── Track species count on scan ────────────────────────────────────────────
  async function trackSpecies(count) {
    if (!TRACKING_ENABLED || count === 0) return;
    try {
      const fbDb = await initFirebase();
      await fbDb.ref('fishfinder/stats/species_total').transaction(v => (v || 0) + count);
    } catch { /* non-critical */ }
  }

  // ── Load dashboard stats + map ─────────────────────────────────────────────
  async function loadDashboard() {
    if (!TRACKING_ENABLED) {
      document.getElementById('usage-map').innerHTML =
        '<div class="dashboard-setup-msg">Configure Firebase to enable live statistics.<br>' +
        'See comments in js/app.js for setup instructions.</div>';
      return;
    }
    try {
      const fbDb = await initFirebase();

      // Stats
      const statsSnap = await fbDb.ref('fishfinder/stats').get();
      const stats = statsSnap.val() || {};
      document.getElementById('stat-sessions').textContent =
        (stats.sessions     || 0).toLocaleString();
      document.getElementById('stat-species').textContent =
        (stats.species_total || 0).toLocaleString();

      // Visits for map + country count
      const visitsSnap = await fbDb.ref('fishfinder/visits').limitToLast(500).get();
      const visits = visitsSnap.val() ? Object.values(visitsSnap.val()) : [];
      const countries = new Set(visits.map(v => v.country).filter(Boolean));
      document.getElementById('stat-countries').textContent = countries.size.toLocaleString();

      // Map
      loadStyle('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
      await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');

      const map = window.L.map('usage-map', {
        center: [20, 0], zoom: 2,
        zoomControl: true, attributionControl: true,
      });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 10,
      }).addTo(map);

      for (const v of visits) {
        if (v.lat && v.lng) {
          window.L.circleMarker([v.lat, v.lng], {
            radius: 5, fillColor: '#a8c080',
            color: '#4a6030', weight: 1, fillOpacity: 0.75,
          }).bindPopup(`${v.city ? v.city + ', ' : ''}${v.country}`).addTo(map);
        }
      }
    } catch (e) {
      console.warn('Dashboard unavailable:', e.message);
    }
  }

  // ── Info modal ─────────────────────────────────────────────────────────────
  function openModal() {
    infoModal.hidden = false;
    document.body.style.overflow = 'hidden';
    modalClose.focus();
  }
  function closeModal() {
    infoModal.hidden = true;
    document.body.style.overflow = '';
  }

  // ── Copy citations ─────────────────────────────────────────────────────────
  function copyCitations() {
    const year = new Date().getFullYear();
    const text = [
      'Page, L.M., Espinosa-Pérez, H., Findley, L.T., Gilbert, C.R., Lea, R.N., Mandrak, N.E., ' +
      'Mayden, R.L., and Nelson, J.S. (2023). Common and Scientific Names of Fishes from the ' +
      'United States, Canada, and Mexico, 8th edition. American Fisheries Society Special ' +
      'Publication 36. American Fisheries Society, Bethesda, Maryland.',

      `Fricke, R., Eschmeyer, W.N., and Van der Laan, R. (eds.) (${year}). ` +
      'Eschmeyer\'s Catalog of Fishes: Genera, Species, References. ' +
      'California Academy of Sciences. Electronic version accessed ' + year + '.',

      '[Author(s)] ([Year]). FISHFINDER: A web-based validator for scientific fish names in ' +
      'manuscript text. [Journal / Technical Note]. [DOI]. ' +
      'Available at: https://zdzbinden.github.io/FISHFINDER/',
    ].join('\n\n');

    navigator.clipboard.writeText(text).then(() => {
      const prev = citeBtn.textContent;
      citeBtn.textContent = 'COPIED!';
      setTimeout(() => { citeBtn.textContent = prev; }, 2000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      const prev = citeBtn.textContent;
      citeBtn.textContent = 'COPIED!';
      setTimeout(() => { citeBtn.textContent = prev; }, 2000);
    });
  }

  // ── Additional event listeners ─────────────────────────────────────────────
  infoBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  infoModal.addEventListener('click', e => { if (e.target === infoModal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !infoModal.hidden) closeModal(); });
  citeBtn.addEventListener('click', copyCitations);

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  loadDatabase();
  trackVisit();
  loadDashboard();
}());
