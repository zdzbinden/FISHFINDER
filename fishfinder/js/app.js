/**
 * FISHFINDER — app.js
 * All processing is client-side. No server calls after initial JSON load.
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  let db      = null;
  let lookups = null;   // built by FishEngine.buildLookups(db)
  let lastFindings = null;  // cached from most recent scan
  let lastScanText = null;  // text that produced lastFindings

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const loadingEl      = document.getElementById('loading');
  const loadErrorEl    = document.getElementById('load-error');
  const checkBtn       = document.getElementById('check-btn');
  const clearBtn       = document.getElementById('clear-btn');
  const copyBtn        = document.getElementById('copy-btn');
  const loadBtn        = document.getElementById('load-btn');
  const infoBtn        = document.getElementById('info-btn');
  const citeBtn        = document.getElementById('cite-btn');
  const infoPanel      = document.getElementById('info-panel');
  const reportBtn      = document.getElementById('report-btn');
  const reportPanel    = document.getElementById('report-panel');
  const reportForm     = document.getElementById('report-form');
  const reportStatus   = document.getElementById('report-status');
  const hiconBtn       = document.getElementById('hicon-btn');
  const onboardingEl   = document.getElementById('onboarding-hint');
  const onboardingDismiss = document.getElementById('onboarding-dismiss');
  const screenEl       = document.querySelector('.screen');
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
  const lowConfBlock   = document.getElementById('low-confidence');
  const lowConfTbody   = document.getElementById('low-confidence-tbody');
  const lowConfCount   = document.getElementById('low-confidence-count');
  const lowConfLabel   = document.getElementById('low-confidence-label');

  // ── Eschmeyer access date ─────────────────────────────────────────────────
  // Rendered from metadata.synonym_accessed, NOT from the browser's clock. The
  // citation previously used the current year, so it claimed the catalog had been
  // accessed whenever the visitor happened to load the page. The real date is when
  // the scrape ran, and it only moves when the catalog is actually re-queried.
  function formatAccessed(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return null;
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                    'August', 'September', 'October', 'November', 'December'];
    return { year: m[1], long: `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` };
  }

  function renderEschmeyerDate() {
    const acc = formatAccessed((db && db.metadata && db.metadata.synonym_accessed) || '');
    if (!acc) return;   // leave the static fallback in the markup
    document.querySelectorAll('.ecof-year').forEach(el => { el.textContent = acc.year; });
    document.querySelectorAll('.ecof-accessed').forEach(el => { el.textContent = acc.long; });
  }

  // Provenance marker for names whose authority is the Committee's published
  // addenda rather than the printed 8th edition. Not a classification tier —
  // these names are VALID; the badge just says where the ruling came from.
  const ADDENDA_BADGE =
    '<span class="addenda-note" title="Recognized by the Committee\'s published ' +
    'addenda to Names of Fishes, 8th edition; not in the printed book">addenda</span>';

  // The genus was abbreviated in the text and expanded from a spelled-out
  // mention elsewhere. Like ADDENDA_BADGE this is a qualifier, not a tier — the
  // classification is unchanged. It exists because 173 of 602 abbreviated
  // mentions in the test corpus produced a row for a binomial that appears
  // nowhere in the manuscript as typed, so without showing the as-written form
  // the reader searches for "Pylodictis olivarus" and finds nothing.
  function abbrevBadge(f) {
    return '<span class="abbrev-note" title="Written as &ldquo;' + esc(f.text) +
      '&rdquo;; genus expanded from a spelled-out mention elsewhere in the text">' +
      esc(f.text) + '</span>';
  }

  // ── Data version (rendered from fish_names.json metadata) ─────────────────
  function renderDataVersion() {
    const md = (db && db.metadata) || {};
    const version = md.data_version;
    if (!version) return;

    for (const el of document.querySelectorAll('.data-version')) {
      el.textContent = version;
    }
    const count = document.getElementById('coverage-count');
    if (count && md.species_count) {
      count.textContent = md.species_count.toLocaleString('en-US');
    }
  }

  // ── Database coverage panel ───────────────────────────────────────────────
  // Counted from the loaded database, not hard-coded, so the panel cannot drift
  // out of step with fish_names.json the way the old species counts did.
  function renderDatabasePanel() {
    if (!db || !db.valid_names) return;
    const n = (x) => x.toLocaleString('en-US');
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    const entries = Object.values(db.valid_names);
    let en = 0, es = 0, fr = 0;
    for (const e of entries) {
      if (e.common_name_en) en++;
      if (e.common_name_es) es++;
      if (e.common_name_fr) fr++;
    }

    set('db-species',  n(entries.length));
    set('db-genera',   n((db.genera || []).length));
    set('db-synonyms', n(Object.keys(db.synonyms || {}).length));
    set('db-common-en', n(en));
    set('db-common-es', n(es));
    set('db-common-fr', n(fr));
  }

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

    // Build lookup structures (engine.js)
    lookups = FishEngine.buildLookups(db);

    // Render the data version from metadata rather than hard-coding it, so it
    // cannot drift the way the hard-coded species counts did.
    renderDataVersion();
    renderEschmeyerDate();
    renderDatabasePanel();

    loadingEl.hidden  = true;
    checkBtn.disabled = false;

    console.log(
      `Database loaded: ${lookups.validSet.size} valid names, ` +
      `${lookups.synonymMap.size} synonyms, ${lookups.generaSet.size} genera, ` +
      `${lookups.commonNameMap.size} common names`
    );
  }

  // ── HTML escaping ──────────────────────────────────────────────────────────
  // String() because database records are written by anyone: a missing or
  // non-string field must render as text, not throw halfway through a loop.
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  // ── One finding shape, built in one place ─────────────────────────────────
  // runCheck() and copyText() both used to build this literal, with different
  // fields, so every new field had to be added twice or the COPY path would
  // silently disagree with the display.
  function makeFinding(cand, result) {
    let replacement = result.suggestion;
    if (replacement && cand.abbrev) {
      const parts = result.suggestion.split(' ');
      // Keep the author's abbreviation, but ONLY when the genus is unchanged.
      // For a genus change (Stizostedion vitreum -> Sander vitreus) writing
      // "S. vitreus" would hide the change behind an initial that still reads as
      // the old genus, so there the corrected text spells the new genus out.
      if (parts[0].toLowerCase() === cand.genus.toLowerCase()) {
        // Slice rather than rebuild "P. " so the author's own spacing survives:
        // P.olivarus stays P.olivaris, which keeps index + text.length exact.
        replacement = cand.text.slice(0, cand.text.length - cand.species.length) +
                      parts.slice(1).join(' ');
      }
    }
    return {
      text:          cand.text,
      binomial:      `${cand.genus} ${cand.species}`,
      index:         cand.index,
      type:          result.type,
      suggestion:    result.suggestion,
      replacement,
      abbrev:        cand.abbrev || '',
      lowConfidence: FishEngine.isLowConfidence(cand, result),
      commonName:    result.commonName || '',
      addenda:       result.addenda || null,
      removed:       result.removed || false,
      note:          result.note || '',
    };
  }

  function scanText(text) {
    const findings = [];
    for (const cand of FishEngine.extractCandidates(text, lookups)) {
      const result = FishEngine.classifyName(lookups, cand.genus, cand.species);
      if (result) findings.push(makeFinding(cand, result));
    }
    // Second pass: common names (2+ words), skipping spans already claimed.
    const binomialSpans = findings.map(f => ({ start: f.index, end: f.index + f.text.length }));
    findings.push(...FishEngine.extractCommonNames(lookups, text, binomialSpans));
    return findings;
  }

  // ── Build corrected plain text (replace correctable names) ────────────────
  function buildCorrectedText(text, findings) {
    // Work backwards to preserve index positions
    const correctable = findings
      .filter(f => f.suggestion && (f.type === 'outdated' || f.type === 'misspelled'))
      // Never rewrite a demoted match. "Auxis may" is a verb, and splicing
      // "Auxis rochei" over it would corrupt the user's manuscript silently.
      .filter(f => !f.lowConfidence)
      .sort((a, b) => b.index - a.index);

    let out = text;
    for (const f of correctable) {
      // `replacement` preserves an abbreviated genus; common-name findings have
      // none and fall through to `suggestion`.
      out = out.slice(0, f.index) + (f.replacement || f.suggestion) +
            out.slice(f.index + f.text.length);
    }
    return out;
  }

  // ── Main check logic ───────────────────────────────────────────────────────
  let isScanning = false;

  function runCheck() {
    if (!db || isScanning) return;

    const text = textarea.value;
    if (!text.trim()) {
      alert('No text to scan — paste manuscript text first.');
      return;
    }

    isScanning           = true;
    checkBtn.disabled    = true;
    checkBtn.textContent = 'SCANNING…';

    // Yield to browser to update button state, then process
    setTimeout(() => {
      try {
        const findings = scanText(text);

        // Cache for copyText reuse
        lastFindings = findings;
        lastScanText = text;

        // Track scan session + species count (non-blocking, once per session)
        trackVisit().catch(() => {});
        trackSpecies(findings.length);

        // Play animation if fish were found, then render results
        const doRender = () => renderResults(findings);
        if (findings.length > 0 &&
            !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          playPostScanAnimation(textarea.value, findings, doRender);
        } else {
          doRender();
        }
      } catch (err) {
        console.error('Scan failed:', err);
        alert('An error occurred during scanning. Please try again.');
        isScanning           = false;
        checkBtn.disabled    = false;
        checkBtn.textContent = 'SCAN';
      }
    }, 10);
  }

  // ── Post-scan animation ──────────────────────────────────────────────────
  // Outline fish icons — forked tail, hollow body (classic depth finder style)
  const FISH_SPRITES = [
    // Large outline fish (14x7) — facing right, V-tail on left
    { w: 14, h: 7, data: [
      [0,0,0,0,0,0,0,1,1,1,0,0,0,0],
      [1,0,0,0,0,1,1,0,0,0,1,1,0,0],
      [0,1,0,0,1,0,0,0,0,0,0,0,1,0],
      [0,0,1,1,0,0,0,0,0,0,0,0,0,1],
      [0,1,0,0,1,0,0,0,0,0,0,0,1,0],
      [1,0,0,0,0,1,1,0,0,0,1,1,0,0],
      [0,0,0,0,0,0,0,1,1,1,0,0,0,0],
    ]},
    // Medium outline fish (11x5) — facing right
    { w: 11, h: 5, data: [
      [0,0,0,0,0,1,1,1,0,0,0],
      [1,0,0,1,1,0,0,0,1,1,0],
      [0,1,1,0,0,0,0,0,0,0,1],
      [1,0,0,1,1,0,0,0,1,1,0],
      [0,0,0,0,0,1,1,1,0,0,0],
    ]},
    // Small outline fish (9x5) — facing right
    { w: 9, h: 5, data: [
      [0,0,0,0,1,1,0,0,0],
      [1,0,1,1,0,0,1,0,0],
      [0,1,0,0,0,0,0,1,0],
      [1,0,1,1,0,0,1,0,0],
      [0,0,0,0,1,1,0,0,0],
    ]},
    // Tiny outline fish (7x3) — facing right
    { w: 7, h: 3, data: [
      [1,0,0,1,1,0,0],
      [0,1,1,0,0,1,0],
      [1,0,0,1,1,0,0],
    ]},
  ];

  function playPostScanAnimation(text, findings, onComplete) {
    const screenEl = document.querySelector('.screen');
    const rect     = screenEl.getBoundingClientRect();
    const dpr      = window.devicePixelRatio || 1;

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'scan-animation-canvas';
    canvas.width  = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width  = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    screenEl.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    const W = rect.width;
    const H = rect.height;

    // Colors matching LCD theme
    const LCD_BG   = '#8d9b76';
    const LCD_TEXT  = '#0e1a04';
    const LCD_MUTED = '#1c2c0c';

    // Pixel scale for sprites
    const pxScale = Math.max(2, Math.floor(W / 200));

    // Shorten on mobile
    const isMobile   = W < 500;
    const TOTAL_TIME = isMobile ? 2200 : 3500;

    // Phase timing
    const SONAR_END  = isMobile ? 1200 : 1800;  // sonar pulses
    const P3_START   = isMobile ? 1000 : 1600;   // fish appear
    const P3_END     = isMobile ? 1500 : 2400;   // fish fully visible
    const P4_START   = isMobile ? 1300 : 2200;   // swim start
    const FADE_START = TOTAL_TIME - 400;          // canvas fade out

    // Sonar beam config — cone emits from top-center, sweeps downward
    const beamOriginX = W / 2;
    const beamOriginY = 0;
    const beamSpread  = W * 0.4;        // half-width of cone at bottom
    const pingCount   = isMobile ? 3 : 4;
    const pingInterval = SONAR_END / (pingCount + 1);

    // Build fish objects (max 15)
    const fishCount = Math.min(findings.length, 50);
    const fishes = [];
    for (let i = 0; i < fishCount; i++) {
      const sprite = FISH_SPRITES[i % FISH_SPRITES.length];
      fishes.push({
        sprite,
        x: 40 + Math.random() * (W - 120),
        y: 30 + Math.random() * (H - 80),
        vx: (Math.random() > 0.5 ? 1 : -1) * (0.8 + Math.random() * 1.2),
        phase: Math.random() * Math.PI * 2,
        alpha: 0,
        active: false,
      });
    }

    // Animation state
    let startTime = null;
    let rafId     = null;
    let done      = false;

    function finish() {
      if (done) return;
      done = true;
      if (rafId) cancelAnimationFrame(rafId);
      canvas.removeEventListener('click', finish);
      document.removeEventListener('keydown', finish);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      onComplete();
    }

    // Click or keypress to skip
    canvas.addEventListener('click', finish);
    document.addEventListener('keydown', finish);

    function drawSprite(sprite, x, y, scale, alpha, flipX) {
      ctx.globalAlpha = alpha;
      for (let row = 0; row < sprite.h; row++) {
        for (let col = 0; col < sprite.w; col++) {
          if (sprite.data[row][col]) {
            const drawCol = flipX ? (sprite.w - 1 - col) : col;
            ctx.fillRect(
              x + drawCol * scale,
              y + row * scale,
              scale, scale
            );
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    function frame(timestamp) {
      if (done) return;
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;

      if (elapsed >= TOTAL_TIME) { finish(); return; }

      // Clear canvas with LCD background
      ctx.fillStyle = LCD_BG;
      ctx.fillRect(0, 0, W, H);

      // ── Phase 1: Sonar beam pings downward ──
      if (elapsed < SONAR_END) {
        // Draw static sonar cone outline (faint)
        ctx.beginPath();
        ctx.moveTo(beamOriginX, beamOriginY);
        ctx.lineTo(beamOriginX - beamSpread, H);
        ctx.lineTo(beamOriginX + beamSpread, H);
        ctx.closePath();
        ctx.strokeStyle = LCD_TEXT;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.15;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Ping lines sweep top to bottom inside the cone
        for (let i = 0; i < pingCount; i++) {
          const pingStart = i * pingInterval;
          const pingAge = elapsed - pingStart;
          if (pingAge < 0) continue;

          const progress = Math.min(pingAge / (SONAR_END - pingStart), 1);
          const y = progress * H;
          const spread = (y / H) * beamSpread;
          const alpha = (1 - progress) * 0.6;

          if (alpha <= 0) continue;

          ctx.beginPath();
          ctx.arc(beamOriginX, beamOriginY, y, Math.atan2(H, beamSpread), Math.PI - Math.atan2(H, beamSpread));
          ctx.strokeStyle = LCD_TEXT;
          ctx.lineWidth = Math.max(1, 3 - progress * 2);
          ctx.globalAlpha = alpha;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Scanning label
        const dots = '.'.repeat(Math.floor((elapsed / 400) % 4));
        ctx.fillStyle = LCD_MUTED;
        ctx.globalAlpha = 0.6;
        ctx.font = `bold ${Math.max(11, Math.floor(W / 50))}px Consolas, "Courier New", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('SCANNING' + dots, W / 2, H * 0.85);
        ctx.textAlign = 'start';
        ctx.globalAlpha = 1;
      }

      // ── Phase 3+: Fish appear (static) ──
      if (elapsed >= P3_START) {
        const transformProgress = Math.min((elapsed - P3_START) / (P3_END - P3_START), 1);
        ctx.fillStyle = LCD_TEXT;

        for (const fish of fishes) {
          let alpha = transformProgress;
          if (elapsed >= FADE_START) {
            alpha *= 1 - (elapsed - FADE_START) / (TOTAL_TIME - FADE_START);
          }
          drawSprite(fish.sprite, fish.x, fish.y, pxScale, alpha, fish.vx < 0);
        }
      }

      // ── Canvas fade out ──
      if (elapsed >= FADE_START) {
        const fadeAlpha = (elapsed - FADE_START) / (TOTAL_TIME - FADE_START);
        ctx.fillStyle = LCD_BG;
        ctx.globalAlpha = fadeAlpha;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }

      // ── Skip hint ──
      ctx.fillStyle = LCD_MUTED;
      ctx.globalAlpha = 0.4;
      ctx.font = `${Math.max(9, Math.floor(W / 80))}px Consolas, "Courier New", monospace`;
      ctx.fillText('CLICK TO SKIP', 8, H - 8);
      ctx.globalAlpha = 1;

      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
  }

  // ── Render results to DOM ─────────────────────────────────────────────────
  function renderResults(findings) {
    highlightedEl.innerHTML = buildSpeciesListHTML(findings);

    const issues = findings.filter(f => f.type !== 'valid' && f.type !== 'common');

    // Matches that look like ordinary prose ("Ranzania includes") or that we
    // resolved from an abbreviation without confidence. Split out rather than
    // suppressed: hiding them would create false negatives, and 199 real
    // epithets are also ordinary English words.
    const primary = issues.filter(f => !f.lowConfidence);
    const demoted = issues.filter(f =>  f.lowConfidence);

    const labels = {
      changed:    'Changed in 8th edition',
      outdated:   'Outdated / Synonym',
      misspelled: 'Misspelled',
      unknown:    'Unknown fish name',
    };

    // Dedup on the binomial, but prefer a spelled-out mention over an
    // abbreviated one so the table shows the name as the author first wrote it.
    function dedupe(list) {
      const seen = new Map();
      for (const f of list) {
        const prev = seen.get(f.binomial);
        if (!prev || (prev.abbrev && !f.abbrev)) seen.set(f.binomial, f);
      }
      return [...seen.values()];
    }

    function renderRows(tbody, list) {
      tbody.innerHTML = '';
      for (const f of dedupe(list)) {
        let suggestionCell;
        if (f.note) {
          // Withdrawn from the List — explain rather than showing a bare "unknown".
          suggestionCell = esc(f.note);
        } else if (f.type === 'changed') {
          suggestionCell = f.commonName
            ? `Now: <em>${esc(f.commonName)}</em> &mdash; confirm intended species`
            : 'Confirm this is the intended species';
        } else if (f.suggestion) {
          const suggInfo    = db.valid_names[f.suggestion];
          const suggCommon  = suggInfo ? (suggInfo.common_name_en || '') : '';
          suggestionCell    = `<em>${esc(f.suggestion)}</em>` +
            (suggCommon ? ` <span class="common-name">(${esc(suggCommon)})</span>` : '') +
            (suggInfo && suggInfo.addenda ? ' ' + ADDENDA_BADGE : '');
        } else {
          suggestionCell = '—';
        }

        const statusLabel = f.removed ? 'Removed from the List'
                                      : (labels[f.type] || f.type);
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td class="name-cell">${esc(f.binomial)}` +
            (f.abbrev ? ' ' + abbrevBadge(f) : '') + `</td>` +
          `<td><span class="status-${f.type}">${statusLabel}</span></td>` +
          `<td>${suggestionCell}</td>`;
        tbody.appendChild(tr);
      }
      return tbody.childElementCount;
    }

    if (primary.length === 0) {
      noIssuesEl.hidden  = false;
      summaryTable.hidden = true;
      issueBadge.textContent = '';
    } else {
      noIssuesEl.hidden   = true;
      summaryTable.hidden = false;
      // Count the rows actually shown. This used to report the pre-dedup total,
      // so the badge could claim more issues than the table listed.
      issueBadge.textContent = String(renderRows(summaryTbody, primary));
    }

    if (demoted.length === 0) {
      lowConfBlock.hidden = true;
    } else {
      lowConfBlock.hidden = false;
      lowConfBlock.open   = false;   // collapsed on every scan, never sticky
      const shown = renderRows(lowConfTbody, demoted);
      lowConfCount.textContent = String(shown);
      lowConfLabel.textContent = shown === 1 ? 'low-confidence match' : 'low-confidence matches';
    }

    resultsSection.hidden = false;
    const scrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    resultsSection.scrollIntoView({ behavior: scrollBehavior, block: 'start' });

    isScanning           = false;
    checkBtn.disabled    = false;
    checkBtn.textContent = 'SCAN';
  }

  // ── Clipboard helper ─────────────────────────────────────────────────────
  function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      const prev = btn.textContent;
      btn.textContent = 'COPIED!';
      setTimeout(() => { btn.textContent = prev; }, 2000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      const prev = btn.textContent;
      btn.textContent = 'COPIED!';
      setTimeout(() => { btn.textContent = prev; }, 2000);
    });
  }

  // ── Copy corrected text to clipboard ──────────────────────────────────────
  function copyText() {
    const text = textarea.value;
    if (!text.trim()) {
      alert('No text to copy — paste manuscript text first.');
      return;
    }
    // Reuse cached findings if text hasn't changed since last scan
    const findings = (lastFindings && lastScanText === text)
      ? lastFindings
      : scanText(text);

    copyToClipboard(buildCorrectedText(text, findings), copyBtn);
  }

  // ── Lazy script loader (CDN libraries loaded on first use) ────────────────
  // One promise per URL. The old check ("a <script> with this src exists")
  // resolved while a tag was still loading, so the dashboard and REPORT could
  // both start Firebase before it existed, and it resolved for a tag that had
  // FAILED, so a retry "succeeded" with nothing loaded. A failed tag is now
  // removed and forgotten, so the next attempt is a real one.
  const scriptLoads = new Map();

  function loadScript(src, integrity) {
    if (!scriptLoads.has(src)) {
      scriptLoads.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
        s.onload = resolve;
        s.onerror = () => {
          s.remove();
          scriptLoads.delete(src);
          reject(new Error('Failed to load ' + src.split('/').pop()));
        };
        document.head.appendChild(s);
      }));
    }
    return scriptLoads.get(src);
  }

  function loadStyle(href, integrity) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    if (integrity) { l.integrity = integrity; l.crossOrigin = 'anonymous'; }
    document.head.appendChild(l);
  }

  // Every entry needs an integrity hash, and its exact URL must also appear in
  // the CSP in index.html; test/security.test.js checks both, and
  // tools/csp-smoke.js re-hashes the live files.
  const CDN = {
    mammoth:     { src: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.12.3/mammoth.browser.min.js',
                   integrity: 'sha384-xqNXvcKbEqifokHcBnB0H32p+OQchhD/T/xJGWCMAW5fC0c0MBf9atO3weoPCT84' },
    // SheetJS stopped publishing to npm, and so to cdnjs, at 0.18.5, which has
    // two advisories (prototype pollution, ReDoS) when reading a crafted file.
    // Fixed releases come only from the vendor's own CDN.
    xlsx:        { src: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
                   integrity: 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT' },
    pdfjs:       { src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
                   integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e' },
    pdfjsW:      { src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
                   integrity: 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2' },
    firebaseApp: { src: 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
                   integrity: 'sha384-ZaR6mWzmJtrRibZ1Vm7SoHFr8OXjyAuGAXalGDKqbxFT18oi/z+oZLIRFkpeNor1' },
    firebaseDb:  { src: 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database-compat.js',
                   integrity: 'sha384-g5H2aNdtgRBYOBLsuOAuHvUXWnw4bswmU+tYjmGc1G3JfKxl79uWwV4sQarJsLwu' },
    leafletJs:   { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
                   integrity: 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH' },
    leafletCss:  { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
                   integrity: 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H' },
  };

  // ── File upload handling ────────────────────────────────────────────────────
  let isLoadingFile = false;

  async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    await processFile(file);
    fileInput.value = '';   // reset so same file can be re-selected
  }

  async function processFile(file) {
    if (isLoadingFile) return;

    isLoadingFile = true;
    const ext = file.name.split('.').pop().toLowerCase();
    fileNameEl.textContent = 'Reading\u2026';
    let text = '';

    try {
      switch (ext) {
        case 'txt': case 'csv':
          text = await file.text();
          break;
        case 'docx':
          await loadScript(CDN.mammoth.src, CDN.mammoth.integrity);
          text = await extractDocx(file);
          break;
        case 'xlsx': case 'xls':
          await loadScript(CDN.xlsx.src, CDN.xlsx.integrity);
          text = await extractXlsx(file);
          break;
        case 'pdf':
          await loadScript(CDN.pdfjs.src, CDN.pdfjs.integrity);
          // Load pdf.js's worker ourselves, hashed. pdf.js uses a worker it
          // finds already loaded; failing that it tries a blob: Worker (the CSP
          // blocks it) and then injects its OWN <script> for workerSrc, with no
          // integrity check. So never reach getDocument() without ours.
          await loadScript(CDN.pdfjsW.src, CDN.pdfjsW.integrity);
          if (!(window.pdfjsWorker && window.pdfjsWorker.WorkerMessageHandler)) {
            throw new Error('the PDF reader did not load');
          }
          pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsW.src;
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
    } finally {
      isLoadingFile = false;
    }
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
    // isEvalSupported:false is the vendor's mitigation for CVE-2024-4367
    // (script execution from a crafted PDF font) on pdf.js 3.x. The CSP's lack
    // of 'unsafe-eval' already blocks that; this says so explicitly.
    const pdf  = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
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
      // Prefer a spelled-out mention over an abbreviated one for the same
      // species, so the row reads as the author first wrote it. An abbreviated
      // mention of a name already listed folds in here for free — 429 of 602
      // abbreviated mentions in the test corpus did exactly that.
      const prev = seen.get(f.binomial);
      if (!prev || (prev.abbrev && !f.abbrev)) seen.set(f.binomial, f);
    }

    speciesCountEl.textContent = seen.size ? String(seen.size) : '';

    if (seen.size === 0) {
      return '<div class="species-empty">No species names detected</div>';
    }

    let html = '';
    for (const [, f] of seen) {
      html += '<div class="species-row">';
      const label = f.abbrev
        ? `${esc(f.binomial)}: ${f.type}, written as ${esc(f.text)}`
        : `${esc(f.binomial)}: ${f.type}`;
      html += `<span class="hl ${f.type}" aria-label="${label}"><em>${esc(f.binomial)}</em></span>`;
      if (f.abbrev) html += ' ' + abbrevBadge(f);

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

      if (f.addenda) {
        html += ' ' + ADDENDA_BADGE;
      }

      html += '</div>';
    }
    return html;
  }

  // ── Drag-and-drop on screen ────────────────────────────────────────────────
  screenEl.addEventListener('dragover', e => {
    e.preventDefault();
    screenEl.classList.add('drag-over');
  });
  screenEl.addEventListener('dragleave', e => {
    e.preventDefault();
    screenEl.classList.remove('drag-over');
  });
  screenEl.addEventListener('drop', e => {
    e.preventDefault();
    screenEl.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  });

  // ── Event listeners ────────────────────────────────────────────────────────
  loadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);
  checkBtn.addEventListener('click', runCheck);

  clearBtn.addEventListener('click', () => {
    textarea.value          = '';
    resultsSection.hidden   = true;
    fileNameEl.textContent  = '';
    closeAllPanels();
  });

  copyBtn.addEventListener('click', copyText);

  // Allow Ctrl/Cmd+Enter to trigger check
  textarea.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runCheck();
  });

  // ── Firebase config ────────────────────────────────────────────────────────
  // To enable the usage dashboard:
  //  1. Go to console.firebase.google.com → create a project
  //  2. Add a Realtime Database
  //  3. Replace the values below with your project's config
  //  4. Deploy security rules: firebase deploy --only database
  //     (see database.rules.json in project root)
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
    await loadScript(CDN.firebaseApp.src, CDN.firebaseApp.integrity);
    await loadScript(CDN.firebaseDb.src, CDN.firebaseDb.integrity);
    if (!window.firebase.apps.length) window.firebase.initializeApp(FIREBASE_CONFIG);
    _fbDb = window.firebase.database();
    return _fbDb;
  }

  // ── Consent helpers ────────────────────────────────────────────────────────
  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }

  function hasAnalyticsConsent() {
    return storageGet('ff_consent') === 'accepted';
  }

  // ── Track visit (once per session) ────────────────────────────────────────
  async function trackVisit() {
    if (!TRACKING_ENABLED) return;
    if (!hasAnalyticsConsent()) return;
    if (sessionStorage.getItem('ff_tracked')) return;
    const lastWrite = parseInt(storageGet('ff_last_write') || '0', 10);
    if (Date.now() - lastWrite < 60000) return;
    sessionStorage.setItem('ff_tracked', '1');
    try {
      const geo = await fetch('https://ipapi.co/json/').then(r => r.json());
      if (!geo || !geo.latitude) return;
      const fbDb = await initFirebase();
      // Visit records are public (they draw the usage map), so store no more
      // precision than the map needs: ~1 km, and the hour rather than the ms.
      await fbDb.ref('fishfinder/visits').push({
        lat:     Math.round(geo.latitude * 100) / 100,
        lng:     Math.round(geo.longitude * 100) / 100,
        country: geo.country_name || '',
        city:    geo.city || '',
        ts:      Math.floor(Date.now() / 3600000) * 3600000,
      });
      await fbDb.ref('fishfinder/stats/sessions').transaction(v => (v || 0) + 1);
      storageSet('ff_last_write', String(Date.now()));
    } catch (e) {
      console.warn('Analytics unavailable:', e.message);
    }
  }

  // ── Track species count on scan ────────────────────────────────────────────
  async function trackSpecies(count) {
    if (!TRACKING_ENABLED || !hasAnalyticsConsent() || count === 0) return;
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

      // Visits for map + unique location count. The newest 500 by timestamp:
      // the default order is by key, and a writer who picked a key sorting
      // last could have kept a record on the map for good. The database rules
      // refuse any read of this node without a limit of 500 or less.
      const visitsSnap = await fbDb.ref('fishfinder/visits')
        .orderByChild('ts').limitToLast(500).get();
      const visits = visitsSnap.val() ? Object.values(visitsSnap.val()) : [];
      const locations = new Set(visits.map(v => [v.city, v.country].filter(Boolean).join(', ')).filter(Boolean));
      document.getElementById('stat-locations').textContent = locations.size.toLocaleString();

      // Map
      loadStyle(CDN.leafletCss.src, CDN.leafletCss.integrity);
      await loadScript(CDN.leafletJs.src, CDN.leafletJs.integrity);

      const map = window.L.map('usage-map', {
        center: [20, 0], zoom: 1,
        // zoomSnap 0 allows the fractional zoom that fitWorld() needs to frame
        // every continent exactly; minZoom 0 lets narrow phone widths fit too.
        minZoom: 0, maxZoom: 8, zoomSnap: 0,
        zoomControl: true, attributionControl: false,
      });
      window.L.control.attribution({ prefix: false, compact: true }).addTo(map);

      // Self-hosted vector basemap — no tile service, no API key. Natural Earth
      // 110m admin-0 countries (public domain), properties stripped and
      // coordinates rounded to 2 decimals. Drawn in the LCD palette.
      const worldRes = await fetch('data/world-110m.json');
      window.L.geoJSON(await worldRes.json(), {
        attribution: 'Basemap: <a href="https://www.naturalearthdata.com/">Natural Earth</a> (public domain)',
        interactive: false,
        style: {
          // Matches the retired CARTO dark_nolabels palette: black land,
          // faint borders, dark grey ocean (.leaflet-container background).
          fillColor: '#090909', color: '#2e2e2e',
          weight: 0.6, fillOpacity: 1, opacity: 1,
        },
      }).addTo(map);

      // Frame every continent. Antarctica is deliberately left out of the
      // bounds — Mercator stretches it so badly that including it would shrink
      // the inhabited world to about half this size. Re-fit on resize so the
      // framing survives phone widths and orientation changes.
      const WORLD_BOUNDS = window.L.latLngBounds([[-57, -179], [79, 179]]);
      const mapEl = document.getElementById('usage-map');
      const fitWorld = () => {
        map.invalidateSize(false);
        map.fitBounds(WORLD_BOUNDS, { padding: [4, 4], animate: false });
      };
      fitWorld();
      if (window.ResizeObserver) new window.ResizeObserver(fitWorld).observe(mapEl);

      for (const v of visits) {
        if (v.lat && v.lng) {
          // Anyone can write a visit record, and Leaflet renders popup
          // content as HTML, so the location text is escaped.
          const where = esc([v.city, v.country].filter(Boolean).join(', '));
          window.L.circleMarker([v.lat, v.lng], {
            // Bright LCD phosphor green. At this radius a dark outline eats
            // most of the dot, so the stroke stays in the same bright family
            // and the fill is fully opaque.
            radius: 1.0, fillColor: '#c8f57a',
            color: '#8fbf4a', weight: 0.4, fillOpacity: 1,
          }).bindPopup(where).addTo(map);
        }
      }
    } catch (e) {
      console.warn('Dashboard unavailable:', e.message);
    }
  }

  // ── Screen panel helpers ─────────────────────────────────────────────────────
  function closeAllPanels() {
    infoPanel.hidden = true;
    reportPanel.hidden = true;
    screenEl.style.overflow = '';
  }

  function toggleInfo() {
    const wasHidden = infoPanel.hidden;
    closeAllPanels();
    if (wasHidden) {
      infoPanel.hidden = false;
      infoPanel.scrollTop = 0;
      screenEl.style.overflow = 'auto';
    }
  }

  function toggleReport() {
    const wasHidden = reportPanel.hidden;
    closeAllPanels();
    if (wasHidden) {
      reportPanel.hidden = false;
      reportPanel.scrollTop = 0;
      screenEl.style.overflow = 'auto';
    }
  }

  // ── Report submission ─────────────────────────────────────────────────────
  reportForm.addEventListener('submit', async e => {
    e.preventDefault();
    const submitBtn = document.getElementById('report-submit-btn');
    submitBtn.disabled = true;
    reportStatus.hidden = true;

    try {
      const fbDb = await initFirebase();
      const emailVal = document.getElementById('report-email').value.trim();
      const payload = {
        type:  document.getElementById('report-type').value,
        title: document.getElementById('report-title').value.trim(),
        body:  document.getElementById('report-body').value.trim(),
        ts:    Date.now(),
        ua:    navigator.userAgent,
      };
      if (emailVal) payload.email = emailVal;
      await fbDb.ref('fishfinder/issues').push(payload);

      reportStatus.textContent = 'Issue submitted — thank you!';
      reportStatus.className = 'report-status success';
      reportStatus.hidden = false;
      reportForm.reset();
    } catch (err) {
      console.error('Issue submission failed:', err);
      reportStatus.textContent = 'Submission failed — try GitHub Issues instead.';
      reportStatus.className = 'report-status error';
      reportStatus.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ── Copy citations ─────────────────────────────────────────────────────────
  function copyCitations() {
    // Eschmeyer's is a continuously updated online resource, so the citation year
    // and access date are the date OUR data was fetched — not today's date.
    const acc = formatAccessed((db && db.metadata && db.metadata.synonym_accessed) || '');
    const ecofYear = acc ? acc.year : '2026';
    const ecofAccessed = acc ? acc.long : '22 September 2026';
    const text = [
      'Page, L.M., Bemis, K.E., Dowling, T.E., Espinosa-Pérez, H., Findley, L.T., Gilbert, C.R., ' +
      'Hartel, K.E., Lea, R.N., Mandrak, N.E., Neighbors, M.A., Schmitter-Soto, J.J., and ' +
      'Walker, H.J., Jr. (2023). Common and Scientific Names of Fishes from the ' +
      'United States, Canada, and Mexico, 8th edition. American Fisheries Society Special ' +
      'Publication 37. American Fisheries Society, Bethesda, Maryland.',

      `Fricke, R., Eschmeyer, W.N., and Van der Laan, R. (eds.) (${ecofYear}). ` +
      'Eschmeyer\'s Catalog of Fishes: Genera, Species, References. ' +
      'California Academy of Sciences. Electronic version accessed ' + ecofAccessed + '.',

      'Schmitter-Soto, J.J., Bemis, K.E., Dowling, T.E., Findley, L.T., Girard, M.G., ' +
      'Hendrickson, D.A., Ilves, K.L., Maslenikov, K.P., Ruiz-Campos, G., Scharpf, C., and ' +
      'Walker, H.J., Jr. (2026). Addenda, corrigenda, et explanenda to Common and Scientific ' +
      'Names of Fishes, Eighth Edition. Fisheries 51(5):225-227. ' +
      'https://doi.org/10.1093/fshmag/vuaf083',

      'Zbinden, Z.D. (2026). FISHFINDER: Catching Fish Name Mistakes in Text. ' +
      'Fisheries. Advance online publication. https://doi.org/10.1093/fshmag/vuag058',
    ].join('\n\n');

    copyToClipboard(text, citeBtn);
  }

  // ── Additional event listeners ─────────────────────────────────────────────
  infoBtn.addEventListener('click', toggleInfo);
  reportBtn.addEventListener('click', toggleReport);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllPanels(); });
  citeBtn.addEventListener('click', copyCitations);

  // ── High-contrast theme toggle ─────────────────────────────────────────────
  const THEME_KEY = 'ff_theme';
  function applyTheme(theme) {
    if (theme === 'hi-contrast') {
      document.body.setAttribute('data-theme', 'hi-contrast');
      hiconBtn.setAttribute('aria-pressed', 'true');
    } else {
      document.body.removeAttribute('data-theme');
      hiconBtn.setAttribute('aria-pressed', 'false');
    }
  }
  applyTheme(storageGet(THEME_KEY));
  hiconBtn.addEventListener('click', () => {
    const next = document.body.getAttribute('data-theme') === 'hi-contrast' ? 'default' : 'hi-contrast';
    applyTheme(next);
    if (next === 'hi-contrast') storageSet(THEME_KEY, 'hi-contrast');
    else storageRemove(THEME_KEY);
  });

  // ── Onboarding hint (first session only) ──────────────────────────────────
  const ONBOARDING_KEY = 'ff_onboarded';
  function dismissOnboarding() {
    if (!onboardingEl || onboardingEl.hidden) return;
    onboardingEl.hidden = true;
    storageSet(ONBOARDING_KEY, '1');
  }
  if (onboardingEl && !storageGet(ONBOARDING_KEY)) {
    onboardingEl.hidden = false;
  }
  // Click anywhere on the banner (including the × button via bubbling) dismisses it
  if (onboardingEl) {
    onboardingEl.addEventListener('click', dismissOnboarding);
  }
  // Also dismiss as soon as the user focuses the textarea (clear intent to type)
  textarea.addEventListener('focus', dismissOnboarding);
  // Auto-dismiss on first SCAN
  checkBtn.addEventListener('click', dismissOnboarding);

  // ── Consent banner ─────────────────────────────────────────────────────────
  const consentBanner  = document.getElementById('consent-banner');
  const consentAccept  = document.getElementById('consent-accept');
  const consentDecline = document.getElementById('consent-decline');
  const consentLearn   = document.getElementById('consent-learn-more');
  const privacyLink    = document.getElementById('privacy-link');

  function showConsentBanner() {
    if (consentBanner) consentBanner.hidden = false;
  }
  function hideConsentBanner() {
    if (consentBanner) consentBanner.hidden = true;
  }

  if (consentAccept) {
    consentAccept.addEventListener('click', () => {
      storageSet('ff_consent', 'accepted');
      hideConsentBanner();
    });
  }
  if (consentDecline) {
    consentDecline.addEventListener('click', () => {
      storageSet('ff_consent', 'declined');
      hideConsentBanner();
    });
  }
  if (consentLearn) {
    consentLearn.addEventListener('click', e => {
      e.preventDefault();
      toggleInfo();
    });
  }
  if (privacyLink) {
    privacyLink.addEventListener('click', e => {
      e.preventDefault();
      storageRemove('ff_consent');
      showConsentBanner();
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  loadDatabase();
  loadDashboard();

  const consent = storageGet('ff_consent');
  if (!consent) {
    showConsentBanner();
  }
}());
