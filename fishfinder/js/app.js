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

    // Build lookup structures (engine.js)
    lookups = FishEngine.buildLookups(db);

    loadingEl.hidden  = true;
    checkBtn.disabled = false;

    console.log(
      `Database loaded: ${lookups.validSet.size} valid names, ` +
      `${lookups.synonymMap.size} synonyms, ${lookups.generaSet.size} genera, ` +
      `${lookups.commonNameMap.size} common names`
    );
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
      const candidates = FishEngine.extractCandidates(text, lookups);
      const findings   = [];

      for (const cand of candidates) {
        const result = FishEngine.classifyName(lookups, cand.genus, cand.species);
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

      // Second pass: scan for common names (2+ words, case-insensitive)
      const binomialSpans = findings.map(f => ({ start: f.index, end: f.index + f.text.length }));
      const commonHits = FishEngine.extractCommonNames(lookups, text, binomialSpans);
      findings.push(...commonHits);

      // Cache for copyText reuse
      lastFindings = findings;
      lastScanText = text;

      // Track species count (non-blocking)
      trackSpecies(findings.length);

      // Play animation if fish were found, then render results
      const doRender = () => renderResults(findings);
      if (findings.length > 0 &&
          !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        playPostScanAnimation(textarea.value, findings, doRender);
      } else {
        doRender();
      }
    }, 10);
  }

  // ── Post-scan animation ──────────────────────────────────────────────────
  const FISH_SPRITES = [
    // Side-view fish (16x8)
    { w: 16, h: 8, data: [
      [0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0],
      [1,1,0,0,1,1,1,1,1,1,1,1,1,0,0,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [1,1,1,1,1,1,1,0,1,1,1,1,1,1,1,0],
      [1,1,0,0,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0],
    ]},
    // Small minnow (10x5)
    { w: 10, h: 5, data: [
      [0,0,0,0,1,1,1,0,0,0],
      [1,0,0,1,1,1,1,1,1,0],
      [1,1,1,1,1,0,1,1,1,1],
      [1,0,0,1,1,1,1,1,1,0],
      [0,0,0,0,1,1,1,0,0,0],
    ]},
    // Bass-like fish (20x10)
    { w: 20, h: 10, data: [
      [0,0,0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,0,0,0,0],
      [1,1,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [1,1,1,1,1,1,1,1,1,0,1,1,1,1,1,1,1,1,1,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [1,1,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0,0,0],
    ]},
    // Tiny fish (8x4)
    { w: 8, h: 4, data: [
      [0,0,0,1,1,0,0,0],
      [1,0,1,1,0,1,1,0],
      [1,1,1,1,1,1,1,1],
      [0,0,0,1,1,0,0,0],
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

    // Sonar config
    const sonarCenterX = W / 2;
    const sonarCenterY = H * 0.35;
    const maxRadius    = Math.max(W, H) * 0.8;
    const pulseCount   = isMobile ? 3 : 4;
    const pulseInterval = SONAR_END / (pulseCount + 1);

    // Build fish objects (max 15)
    const fishCount = Math.min(findings.length, 15);
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
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      onComplete();
    }

    // Click to skip
    canvas.addEventListener('click', finish);

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

      // ── Phase 1: Sonar pulses ──
      if (elapsed < SONAR_END) {
        for (let i = 0; i < pulseCount; i++) {
          const pulseStart = i * pulseInterval;
          const pulseAge = elapsed - pulseStart;
          if (pulseAge < 0) continue;

          const progress = Math.min(pulseAge / (SONAR_END - pulseStart), 1);
          const radius = progress * maxRadius;
          const alpha = (1 - progress) * 0.5;

          if (alpha <= 0) continue;

          ctx.beginPath();
          ctx.arc(sonarCenterX, sonarCenterY, radius, 0, Math.PI * 2);
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
        ctx.fillText('SCANNING' + dots, W / 2, H * 0.7);
        ctx.textAlign = 'start';
        ctx.globalAlpha = 1;
      }

      // ── Phase 3: Fish appear ──
      if (elapsed >= P3_START) {
        const transformProgress = Math.min((elapsed - P3_START) / (P3_END - P3_START), 1);
        for (const fish of fishes) {
          fish.alpha = transformProgress;
          fish.active = true;
        }
      }

      // ── Phase 4: Fish swim ──
      if (elapsed >= P4_START) {
        const swimElapsed = elapsed - P4_START;
        ctx.fillStyle = LCD_TEXT;

        for (const fish of fishes) {
          if (!fish.active) continue;

          // Sinusoidal swimming
          fish.x += fish.vx;
          fish.y += Math.sin(swimElapsed / 300 + fish.phase) * 0.5;

          // Wrap around screen edges
          if (fish.vx > 0 && fish.x > W + 20) fish.x = -fish.sprite.w * pxScale;
          if (fish.vx < 0 && fish.x < -fish.sprite.w * pxScale - 20) fish.x = W;
          if (fish.y < 10) fish.y = 10;
          if (fish.y > H - 30) fish.y = H - 30;

          // Fade out near end
          let alpha = fish.alpha;
          if (elapsed >= FADE_START) {
            alpha *= 1 - (elapsed - FADE_START) / (TOTAL_TIME - FADE_START);
          }

          drawSprite(fish.sprite, fish.x, fish.y, pxScale, alpha, fish.vx < 0);
        }
      } else if (elapsed >= P3_START) {
        // Phase 3: fish appear but don't swim yet
        ctx.fillStyle = LCD_TEXT;
        for (const fish of fishes) {
          if (!fish.active) continue;
          drawSprite(fish.sprite, fish.x, fish.y, pxScale, fish.alpha, fish.vx < 0);
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

    if (issues.length === 0) {
      noIssuesEl.hidden  = false;
      summaryTable.hidden = true;
      issueBadge.textContent = '';
    } else {
      noIssuesEl.hidden   = true;
      summaryTable.hidden = false;
      issueBadge.textContent = String(issues.length);

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
    // Reuse cached findings if text hasn't changed since last scan
    const findings = (lastFindings && lastScanText === text)
      ? lastFindings
      : (() => {
          const cands = FishEngine.extractCandidates(text, lookups);
          const results = [];
          for (const cand of cands) {
            const result = FishEngine.classifyName(lookups, cand.genus, cand.species);
            if (!result) continue;
            results.push({ text: cand.text, index: cand.index, type: result.type, suggestion: result.suggestion });
          }
          const binomialSpans = results.map(r => ({ start: r.index, end: r.index + r.text.length }));
          results.push(...FishEngine.extractCommonNames(lookups, text, binomialSpans));
          return results;
        })();

    copyToClipboard(buildCorrectedText(text, findings), copyBtn);
  }

  // ── Lazy script loader (CDN libraries loaded on first use) ────────────────
  function loadScript(src, integrity) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + src.split('/').pop()));
      document.head.appendChild(s);
    });
  }

  function loadStyle(href, integrity) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    if (integrity) { l.integrity = integrity; l.crossOrigin = 'anonymous'; }
    document.head.appendChild(l);
  }

  const CDN = {
    mammoth:     { src: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
                   integrity: 'sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz' },
    xlsx:        { src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
                   integrity: 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw' },
    pdfjs:       { src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
                   integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e' },
    pdfjsW:      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',  // no SRI (worker)
    firebaseApp: { src: 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
                   integrity: 'sha384-ajMUFBUFMCyjh8uxJg6bkGcKe9RTolyjwbxB3yES0QQMenP3Oztj/W9vA2SJPcIh' },
    firebaseDb:  { src: 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
                   integrity: 'sha384-f6/UpzjTjIXASlp20cArQsaRh1EvHVJd5kegy/gYR9W2D0a32TnEqUEiW4Zm/5O0' },
    leafletJs:   { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
                   integrity: 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH' },
    leafletCss:  { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
                   integrity: 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H' },
  };

  // ── File upload handling ────────────────────────────────────────────────────
  let isLoadingFile = false;

  async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file || isLoadingFile) return;

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
    } finally {
      isLoadingFile = false;
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
      html += `<span class="hl ${f.type}" aria-label="${esc(f.binomial)}: ${f.type}"><em>${esc(f.binomial)}</em></span>`;

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

      // Visits for map + country count
      const visitsSnap = await fbDb.ref('fishfinder/visits').limitToLast(500).get();
      const visits = visitsSnap.val() ? Object.values(visitsSnap.val()) : [];
      const countries = new Set(visits.map(v => v.country).filter(Boolean));
      document.getElementById('stat-countries').textContent = countries.size.toLocaleString();

      // Map
      loadStyle(CDN.leafletCss.src, CDN.leafletCss.integrity);
      await loadScript(CDN.leafletJs.src, CDN.leafletJs.integrity);

      const map = window.L.map('usage-map', {
        center: [39, -98], zoom: 3,
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
    infoModal.removeEventListener('keydown', trapModalFocus);
    infoModal.addEventListener('keydown', trapModalFocus);
  }
  function closeModal() {
    infoModal.hidden = true;
    document.body.style.overflow = '';
    infoModal.removeEventListener('keydown', trapModalFocus);
    infoBtn.focus();
  }
  function trapModalFocus(e) {
    if (e.key !== 'Tab') return;
    const focusable = infoModal.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
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

      'Zbinden, Z.D. (2026). FISHFINDER: A web-based validator for scientific fish names in ' +
      'manuscript text. In review. ' +
      'Available at: https://zdzbinden.github.io/FISHFINDER/',
    ].join('\n\n');

    copyToClipboard(text, citeBtn);
  }

  // ── Additional event listeners ─────────────────────────────────────────────
  infoBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  infoModal.addEventListener('click', e => { if (e.target === infoModal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !infoModal.hidden) closeModal(); });
  citeBtn.addEventListener('click', copyCitations);

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
      trackVisit().catch(() => {});
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
      openModal();
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
  if (consent === 'accepted') {
    trackVisit().catch(() => {});
  } else if (!consent) {
    showConsentBanner();
  }
}());
