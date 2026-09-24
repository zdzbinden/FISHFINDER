#!/usr/bin/env node
/**
 * FISHFINDER accessibility audit — WCAG 2.2 AA text contrast (1.4.3) and
 * target size (2.5.8), measured on the real page in a real browser.
 *
 *   node tools/a11y-audit.js                         all themes, 1280 + 390 px
 *   node tools/a11y-audit.js --width 1280 --theme hi-contrast
 *   node tools/a11y-audit.js --json out.json --screenshots shots/
 *
 * Exit code: 0 all pass, 1 any failure, 2 the tool itself could not run.
 *
 * Needs Node >= 22 (global WebSocket) and Google Chrome. No npm packages: it
 * serves fishfinder/ itself and decodes the screenshots with node:zlib.
 *
 * WHY IT WORKS THE WAY IT DOES — each of these was learned the hard way:
 *
 * - Contrast is measured from SCREENSHOT PIXELS, never from computed CSS. The
 *   housing, footer and buttons are gradients, so the colour a rule names is
 *   not the colour the text sits on. A CSS-only pass once reported
 *   .privacy-link at 2.93:1 (it is fine) and missed a real failure behind the
 *   version badge. The background is the modal colour in each element's box,
 *   ignoring pixels close to the text colour so heavy text cannot outvote it.
 * - The page is driven over the DevTools protocol rather than by injecting a
 *   script, because Runtime.evaluate is exempt from the page's CSP.
 * - Chrome is launched with its own throwaway profile and a port it picks
 *   itself, and is shut down through its own handle. Never kill Chrome by
 *   image name: that closes the user's real browser windows.
 * - The tab Chrome opens at launch has a wedged renderer (Browser.* answers,
 *   Runtime.* hangs forever), so the audit always opens a fresh target, and
 *   every protocol call has a timeout so a hang is an error, not a stall.
 * - Hidden panels are real content. INFO and REPORT are measured in passes of
 *   their own, and the consent/onboarding overlays in a pass of their own —
 *   a fixed banner is painted over whatever sits beneath it in a full-page
 *   capture, which once made table rows look like 1.00:1 failures.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const SITE = path.resolve(__dirname, '..', 'fishfinder');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Text chosen to put every result style on screen: valid and abbreviated
// mentions, a changed name, an outdated name whose suggestion carries the
// addenda badge, a misspelling, a withdrawn name, a common name, and prose
// that lands in the low-confidence group.
const SAMPLE =
  'We sampled Pylodictis olivaris from the Potomac River in 2024. Later ' +
  'collections of P. olivaris showed similar size structure, although one ' +
  'record of P. olivarus appears to be a transcription error. Micropterus ' +
  'salmoides was also present, and M. salmoides dominated the catch. ' +
  'Historical surveys listed Stizostedion vitreum; S. vitreum was stocked in ' +
  '1975. Beringraja rhina was taken offshore, and Gambusia clarkhubbsi was ' +
  'reported once. Ranzania includes several species, and Bagre mainly occurs ' +
  'in estuaries. Alosa estivalis was recorded once. Largemouth Bass were abundant.';

// What each pass measures. Between them they cover the whole page once.
const PASSES = {
  overlays: { include: '#consent-banner, #onboarding-hint, .skip-link', exclude: null,
              fullPage: false },
  page:     { include: 'body',
              exclude: '#consent-banner, #onboarding-hint, #info-panel, #report-panel, .skip-link',
              fullPage: true },
  info:     { include: '#info-panel', exclude: null, fullPage: true },
  report:   { include: '#report-panel', exclude: null, fullPage: true },
};

// ── Arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    widths: [1280, 390], themes: ['default', 'hi-contrast'],
    passes: Object.keys(PASSES), json: null, screenshots: null,
    verbose: false, chrome: process.env.CHROME_PATH || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--width') opts.widths = next().split(',').map(Number);
    else if (a === '--theme') opts.themes = next().split(',');
    else if (a === '--pass') opts.passes = next().split(',');
    else if (a === '--json') opts.json = next();
    else if (a === '--screenshots') opts.screenshots = next();
    else if (a === '--chrome') opts.chrome = next();
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument: ${a}`);
  }
  if (opts.widths.some(w => !(w >= 200 && w <= 4000))) usage('--width must be 200-4000');
  for (const t of opts.themes) {
    if (t !== 'default' && t !== 'hi-contrast') usage(`unknown theme: ${t}`);
  }
  for (const p of opts.passes) if (!PASSES[p]) usage(`unknown pass: ${p}`);
  return opts;
}

function usage(err) {
  if (err) console.error(`a11y-audit: ${err}\n`);
  console.error([
    'usage: node tools/a11y-audit.js [options]',
    '',
    '  --width 1280,390          viewport widths (default 1280,390)',
    '  --theme default,hi-contrast',
    '  --pass overlays,page,info,report',
    '  --json FILE               write every measurement as JSON',
    '  --screenshots DIR         keep the screenshots that were sampled',
    '  --chrome PATH             Chrome binary (or set CHROME_PATH)',
    '  -v, --verbose             also list passes within 0.5 of the floor',
  ].join('\n'));
  process.exit(err ? 2 : 0);
}

// ── A static server for fishfinder/, so nothing else needs to be running ───
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.woff2': 'font/woff2',
};

function startServer() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400).end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(SITE, rel);
    if (!file.startsWith(SITE + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // Edits to style.css between runs must be seen immediately.
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── Chrome ───────────────────────────────────────────────────────────────────
function findChrome(explicit) {
  const env = process.env;
  const candidates = explicit ? [explicit]
    : process.platform === 'win32' ? [
        path.join(env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
         '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find(p => p && fs.existsSync(p));
  if (!found) throw new Error('Chrome not found; pass --chrome PATH or set CHROME_PATH');
  return found;
}

async function launchChrome(chromePath, width) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-a11y-'));
  const proc = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--force-color-profile=srgb',
    `--window-size=${width},1600`,
    `--user-data-dir=${profile}`,
    // Port 0: Chrome picks a free port and writes it to DevToolsActivePort, so
    // this can never collide with a Chrome the user already has open.
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--disable-background-networking', '--disable-sync',
    '--disable-component-update', '--disable-default-apps',
    // Firebase, geolocation and the Leaflet CDN fail fast instead of stalling.
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    'about:blank',
  ], { stdio: 'ignore' });

  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error(`Chrome exited during startup (code ${proc.exitCode})`);
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (port) return { proc, port, profile };
    } catch { /* not written yet */ }
    await sleep(100);
  }
  proc.kill();
  throw new Error('Chrome did not open a debugging port within 20 s');
}

async function stopChrome(chrome) {
  // Graceful first, through the browser's own endpoint; then this process's
  // own handle. Never by image name.
  try {
    const v = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }), 3000, 'browser socket');
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  } catch { /* fall through to kill */ }
  for (let i = 0; i < 50 && chrome.proc.exitCode === null; i++) await sleep(100);
  if (chrome.proc.exitCode === null) chrome.proc.kill();
  // Renderer processes can hold the profile open for a moment after exit.
  for (let i = 0; i < 20; i++) {
    try { await fsp.rm(chrome.profile, { recursive: true, force: true }); return; }
    catch { await sleep(250); }
  }
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms); }),
  ]);
}

// ── Minimal DevTools protocol client ─────────────────────────────────────────
class Tab {
  static async open(port) {
    // A FRESH target: the launch tab's renderer is wedged in headless mode.
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
    const tab = new Tab(target.webSocketDebuggerUrl);
    await tab.connect();
    return tab;
  }

  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }

  async connect() {
    this.ws = new WebSocket(this.url);
    await withTimeout(new Promise((res, rej) => {
      this.ws.onopen = res; this.ws.onerror = rej;
    }), 10000, 'tab socket');
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    };
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    return withTimeout(p, timeoutMs, method);
  }

  async evaluate(fn, arg, timeoutMs = 60000) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`,
      awaitPromise: true, returnByValue: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  // Navigate through the page itself; the Page domain is unreliable here.
  async goto(url) {
    await this.send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}` });
    for (let i = 0; i < 300; i++) {
      await sleep(100);
      try {
        if (await this.evaluate(u => document.readyState === 'complete' && location.href === u,
                                url, 5000)) return;
      } catch { /* the old context is being torn down */ }
    }
    throw new Error(`navigation to ${url} did not complete`);
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

// ── Runs inside the page ─────────────────────────────────────────────────────
async function probe(cfg) {
  const out = { errors: [], items: [], targets: [],
                viewport: { w: innerWidth, h: innerHeight } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const click = sel => { const el = document.querySelector(sel); if (el) el.click(); return !!el; };

  try {
    // An alert() blocks a headless renderer with no dialog handler, which
    // looks exactly like a hang. Collect the message instead.
    window.alert = m => out.errors.push('alert: ' + m);
    // The post-scan animation runs on requestAnimationFrame; app.js skips it
    // under reduced motion, so results render synchronously.
    const realMM = window.matchMedia.bind(window);
    window.matchMedia = q => /prefers-reduced-motion/.test(String(q))
      ? { matches: true, media: q, onchange: null, addEventListener() {},
          removeEventListener() {}, addListener() {}, removeListener() {} }
      : realMM(q);
    if (cfg.theme === 'hi-contrast') document.body.dataset.theme = 'hi-contrast';

    const btn = document.getElementById('check-btn');
    for (let i = 0; i < 300 && btn.disabled; i++) await sleep(50);
    if (btn.disabled) out.errors.push('database never loaded; SCAN stayed disabled');

    const dismissOverlays = async () => {
      click('#onboarding-dismiss');
      click('#consent-decline');
      await sleep(250);
    };

    if (cfg.pass === 'overlays') {
      // The skip link is only visible when focused, so measure it that way.
      const skip = document.querySelector('.skip-link');
      if (skip) skip.focus();
      await sleep(150);
    } else if (cfg.pass === 'page') {
      await dismissOverlays();
      const ta = document.getElementById('manuscript-text');
      ta.value = cfg.sample;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      for (let i = 0; i < 200; i++) {
        await sleep(50);
        const rs = document.getElementById('results-section');
        if (rs && !rs.hidden) break;
      }
      if (document.getElementById('results-section').hidden) {
        out.errors.push('scan results never rendered');
      }
      // Collapsed content is still content.
      document.querySelectorAll('details').forEach(d => { d.open = true; });
    } else {
      await dismissOverlays();
      click(`#${cfg.pass}-btn`);
      await sleep(200);
      const panel = document.getElementById(`${cfg.pass}-panel`);
      if (!panel || panel.hidden) {
        out.errors.push(`${cfg.pass} panel did not open`);
      } else {
        // The panel is an overlay that scrolls inside the LCD, so most of its
        // text is out of view at any one time. Lay it out at full height for
        // the measurement. Its own opaque background still sits above the
        // scanlines, so what the text sits on is unchanged.
        Object.assign(panel.style, { position: 'relative', inset: 'auto',
          overflow: 'visible', maxHeight: 'none', height: 'auto' });
        for (let n = panel.parentElement; n && n !== document.body; n = n.parentElement) {
          n.style.overflow = 'visible';
        }
        panel.querySelectorAll('details').forEach(d => { d.open = true; });
      }
    }
    window.scrollTo(0, 0);
    await sleep(300);

    const inScope = el => el.closest(cfg.include) && !(cfg.exclude && el.closest(cfg.exclude));
    const describe = el => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (typeof el.className === 'string' && el.className.trim()) {
        s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
      }
      return s;
    };
    const opacityOf = el => {
      let o = 1;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const v = Number(getComputedStyle(n).opacity);
        if (!Number.isNaN(v)) o *= v;
      }
      return o;
    };
    const hidden = el => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return true;
        if (/rect\(0px,? 0px,? 0px,? 0px\)/.test(cs.clip)) return true;
        const r = n.getBoundingClientRect();
        if (r.width <= 2 || r.height <= 2) return true;
      }
      return false;
    };
    // Intersect the box with every clipping ancestor, so a table cell scrolled
    // out of an overflow container is not "measured" against the page behind.
    const visibleBox = el => {
      const r = el.getBoundingClientRect();
      let l = r.left, t = r.top, rr = r.right, b = r.bottom;
      for (let n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const nr = n.getBoundingClientRect();
        l = Math.max(l, nr.left); t = Math.max(t, nr.top);
        rr = Math.min(rr, nr.right); b = Math.min(b, nr.bottom);
      }
      if (!cfg.fullPage) {                    // viewport-only capture
        l = Math.max(l, 0); t = Math.max(t, 0);
        rr = Math.min(rr, innerWidth); b = Math.min(b, innerHeight);
      }
      return { x: l + scrollX, y: t + scrollY, w: rr - l, h: b - t };
    };

    for (const el of document.querySelectorAll('body *')) {
      if (!inScope(el)) continue;
      if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
      if (el.closest('.sr-only') || hidden(el)) continue;
      const box = visibleBox(el);
      if (box.w < 3 || box.h < 3) continue;
      const cs = getComputedStyle(el);
      const px = parseFloat(cs.fontSize);
      const weight = Number(cs.fontWeight) || 400;
      out.items.push({
        sel: describe(el),
        text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 48),
        color: cs.color, px: Math.round(px * 10) / 10, weight,
        opacity: Math.round(opacityOf(el) * 1000) / 1000,
        box: { x: Math.round(box.x), y: Math.round(box.y),
               w: Math.round(box.w), h: Math.round(box.h) },
        // WCAG large text: 18pt (24px), or 14pt (18.66px) bold.
        need: (px >= 24 || (px >= 18.66 && weight >= 700)) ? 3 : 4.5,
      });
    }

    for (const el of document.querySelectorAll(
      'a, button, summary, input:not([type=hidden]), select, textarea, [role=button]')) {
      if (!inScope(el) || hidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 24 && r.height >= 24) continue;
      const cs = getComputedStyle(el);
      out.targets.push({
        sel: describe(el),
        text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40),
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
        // WCAG 2.5.8 exempts links inline in a sentence or block of text.
        exempt: cs.display.startsWith('inline') && !!el.closest('p, li, .citation-entry'),
      });
    }
  } catch (e) {
    out.errors.push('probe: ' + (e && e.message ? e.message : String(e)));
  }
  return out;
}

// ── PNG decoding (8-bit RGB/RGBA, non-interlaced — what Chrome produces) ─────
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width, height, depth, type, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (type !== 2 && type !== 6)) {
    throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  }
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return { width, height, bpp, px };
}

// ── Colour maths ─────────────────────────────────────────────────────────────
function parseColor(s) {
  const m = /^rgba?\(([^)]+)\)$/.exec(String(s).trim());
  if (!m) return null;
  const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (v.length < 3 || v.some(Number.isNaN)) return null;
  return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
}
const channel = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = c => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const over = (fg, alpha, bg) => [0, 1, 2].map(i => fg[i] * alpha + bg[i] * (1 - alpha));

// The modal colour in the box, ignoring pixels close to the text colour.
function sampleBackground(img, box, fg) {
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y);
  const x1 = Math.min(img.width, box.x + box.w), y1 = Math.min(img.height, box.y + box.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 40000)));
  const counts = new Map();
  let total = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * img.bpp;
      const r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
      total++;
      if (Math.abs(r - fg[0]) + Math.abs(g - fg[1]) + Math.abs(b - fg[2]) < 40) continue;
      const k = (r << 16) | (g << 8) | b;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  let best = -1, n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  if (best < 0) return null;
  return { rgb: [(best >> 16) & 255, (best >> 8) & 255, best & 255], share: n / total };
}

function measure(img, probeOut) {
  const text = [], unmeasured = [];
  for (const it of probeOut.items) {
    const fg = parseColor(it.color);
    const bg = fg && sampleBackground(img, it.box, fg);
    if (!fg || !bg) { unmeasured.push({ ...it, why: fg ? 'no background pixels' : `colour ${it.color}` }); continue; }
    // Text colour, then any element opacity, composited over what is really there.
    let eff = fg[3] < 1 ? over(fg, fg[3], bg.rgb) : fg.slice(0, 3);
    if (it.opacity < 1) eff = over(eff, it.opacity, bg.rgb);
    const ratio = contrast(eff, bg.rgb);
    text.push({ ...it, bg: `rgb(${bg.rgb.join(',')})`, bgShare: Math.round(bg.share * 100) / 100,
                ratio: Math.round(ratio * 100) / 100, pass: ratio >= it.need });
  }
  return { text, unmeasured };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run(opts) {
  const started = Date.now();
  const chromePath = findChrome(opts.chrome);
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  if (opts.screenshots) await fsp.mkdir(opts.screenshots, { recursive: true });

  const results = [];
  let loadCount = 0;
  let chrome = null;
  const cleanup = async () => { if (chrome) { await stopChrome(chrome); chrome = null; } };
  process.once('SIGINT', () => { cleanup().finally(() => process.exit(130)); });

  try {
    for (const width of opts.widths) {
      chrome = await launchChrome(chromePath, width);
      const tab = await Tab.open(chrome.port);
      try {
        // Pin the layout width exactly. Headless Chrome can clamp a small
        // --window-size, so the window flag alone is not trusted.
        try {
          await tab.send('Emulation.setDeviceMetricsOverride',
            { width, height: 1600, deviceScaleFactor: 1, mobile: width < 600 }, 5000);
        } catch { /* fall back to the window size; the report shows the real width */ }
        try {
          await tab.send('Network.enable', {}, 5000);
          await tab.send('Network.setCacheDisabled', { cacheDisabled: true }, 5000);
        } catch { /* the server sends no-store anyway */ }

        for (const theme of opts.themes) {
          for (const pass of opts.passes) {
            // Every pass starts from a first visit: stored consent, theme and
            // onboarding state would otherwise leak from one pass to the next.
            await tab.goto(`${base}?a11y=${++loadCount}`);
            await tab.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* none */ } });
            await tab.goto(`${base}?a11y=${++loadCount}`);

            const spec = PASSES[pass];
            const out = await tab.evaluate(probe, {
              theme, pass, sample: SAMPLE, include: spec.include,
              exclude: spec.exclude, fullPage: spec.fullPage,
            }, 120000);
            const shot = await tab.send('Page.captureScreenshot',
              { format: 'png', captureBeyondViewport: spec.fullPage }, 90000);
            const png = Buffer.from(shot.data, 'base64');
            if (opts.screenshots) {
              await fsp.writeFile(path.join(opts.screenshots, `${width}-${theme}-${pass}.png`), png);
            }
            const { text, unmeasured } = measure(decodePng(png), out);
            results.push({ width, theme, pass, viewport: out.viewport, errors: out.errors,
                           text, unmeasured, targets: out.targets });
            process.stderr.write(`  measured ${width}px ${theme} ${pass}: ${text.length} text, ` +
              `${out.targets.length} small targets\n`);
          }
        }
      } finally {
        tab.close();
        await cleanup();
      }
    }
  } finally {
    await cleanup();
    server.close();
  }
  return { results, seconds: Math.round((Date.now() - started) / 1000) };
}

function report(opts, { results, seconds }) {
  let failures = 0, errors = 0;
  const lines = [];
  const row = (...c) => lines.push(c.join('  '));

  lines.push('FISHFINDER accessibility audit — WCAG 2.2 AA (1.4.3 contrast, 2.5.8 target size)');
  lines.push('');
  row('width'.padEnd(9), 'theme'.padEnd(12), 'pass'.padEnd(9), 'text', 'fail', 'targets<24', 'fail');
  for (const r of results) {
    const tf = r.text.filter(t => !t.pass).length;
    const gf = r.targets.filter(t => !t.exempt).length;
    const w = r.viewport.w === r.width ? `${r.width}px` : `${r.width}->${r.viewport.w}`;
    row(w.padEnd(9), r.theme.padEnd(12), r.pass.padEnd(9), String(r.text.length).padStart(4),
        String(tf).padStart(4), String(r.targets.length).padStart(10), String(gf).padStart(4));
    failures += tf + gf;
    errors += r.errors.length;
  }

  for (const r of results) {
    const label = `${r.width}px / ${r.theme} / ${r.pass}`;
    if (r.viewport.w !== r.width) {
      lines.push('', `WARNING ${label}: requested ${r.width}px but the page laid out at ${r.viewport.w}px`);
    }
    for (const e of r.errors) lines.push('', `ERROR ${label}: ${e}`);

    // Group identical failures so nine common names are one line.
    const groups = new Map();
    for (const t of r.text.filter(t => !t.pass)) {
      const k = `${t.sel}|${t.color}|${t.bg}|${t.ratio}`;
      if (!groups.has(k)) groups.set(k, { ...t, count: 0 });
      groups.get(k).count++;
    }
    if (groups.size) lines.push('', `CONTRAST FAILURES — ${label}`);
    for (const g of [...groups.values()].sort((a, b) => a.ratio - b.ratio)) {
      lines.push(`  ${g.ratio.toFixed(2)}:1 (need ${g.need}:1)  ${g.sel}${g.count > 1 ? `  ×${g.count}` : ''}`);
      lines.push(`      ${g.color} on ${g.bg}, ${g.px}px/${g.weight}` +
                 `${g.opacity < 1 ? `, opacity ${g.opacity}` : ''}  "${g.text}"`);
    }
    const small = r.targets.filter(t => !t.exempt);
    if (small.length) lines.push('', `TARGETS UNDER 24×24 — ${label}`);
    for (const t of small) lines.push(`  ${t.w}×${t.h}  ${t.sel}  "${t.text}"`);

    if (opts.verbose) {
      const near = r.text.filter(t => t.pass && t.ratio < t.need + 0.5);
      if (near.length) lines.push('', `within 0.5 of the floor — ${label}`);
      for (const t of near.sort((a, b) => a.ratio - b.ratio)) {
        lines.push(`  ${t.ratio.toFixed(2)}:1  ${t.sel}  "${t.text}"`);
      }
      for (const u of r.unmeasured) lines.push(`  unmeasured: ${u.sel} (${u.why})`);
    }
  }

  const unmeasured = results.reduce((n, r) => n + r.unmeasured.length, 0);
  lines.push('');
  lines.push(`${failures === 0 && errors === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s), ` +
             `${errors} error(s), ${unmeasured} element(s) unmeasured, ${seconds}s`);
  console.log(lines.join('\n'));
  return errors ? 2 : failures ? 1 : 0;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  let outcome;
  try {
    outcome = await run(opts);
  } catch (e) {
    console.error(`a11y-audit: ${e.message}`);
    process.exit(2);
  }
  if (opts.json) {
    await fsp.writeFile(opts.json, JSON.stringify({ generated: new Date().toISOString(),
      ...outcome }, null, 1));
  }
  process.exit(report(opts, outcome));
})();
