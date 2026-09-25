#!/usr/bin/env node
/**
 * FISHFINDER CSP & integrity smoke check. Loads the page in headless Chrome
 * WITH network access, exercises everything that pulls in third-party code,
 * and fails on any Content-Security-Policy violation, integrity (SRI) failure,
 * uncaught error, console error, failed load or alert dialog.
 *
 *   node tools/csp-smoke.js                               serve fishfinder/ locally
 *   node tools/csp-smoke.js --url https://fishnames.net/  check the live site
 *   node tools/csp-smoke.js --pass normal,tamper          run a subset of passes
 *
 * Exit code: 0 pass, 1 any failure, 2 the tool itself could not run (no
 * Chrome, or no CDN reachable).
 *
 * IT NEVER WRITES TO THE LIVE DATABASE. Every pass declines analytics consent
 * before scanning, so SCAN records nothing, and REPORT is opened but never
 * submitted. The dashboard's reads are real; that data is public anyway.
 *
 * Passes:
 *   normal         the page as a visitor gets it.
 *   longpoll       Firebase is told WebSockets failed last time, so it starts
 *                  on long-polling: JSONP <script> tags, which are the only
 *                  reason https://*.firebaseio.com is in script-src at all.
 *   tamper         every hashed third-party script and stylesheet is replaced
 *                  with code that sets window.__tampered. The integrity hashes
 *                  must refuse all of it, including on a retry. Load errors
 *                  and alerts are expected here; only tampered code running
 *                  is a failure.
 *   tamper-worker  only the pdf.js worker is replaced: the one file that used
 *                  to load without a hash, and which pdf.js would fetch itself
 *                  if the hashed copy was missing.
 *
 * Before any browser work, every file in the CDN list in js/app.js is fetched
 * and re-hashed here. Each must match its integrity attribute and send
 * Access-Control-Allow-Origin: *, without which the browser cannot check it.
 *
 * Google Fonts CSS is deliberately NOT tampered: Google varies it per browser,
 * so it cannot carry a hash. The worst a tampered copy could do is restyle the
 * page; style-src still forbids it from running script.
 *
 * Shares its Chrome/DevTools plumbing with tools/a11y-audit.js.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SITE, SAMPLE, sleep, startServer, findChrome, launchChrome, stopChrome, Tab } =
  require('./a11y-audit.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const PASSES = ['normal', 'longpoll', 'tamper', 'tamper-worker'];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.sheetjs.com', 'unpkg.com', 'www.gstatic.com'];

// Every LOAD format, each through the reader that handles it. Most arrive by
// a synthetic drop on the LCD screen; one goes through the real file picker.
const FILES = [
  { name: 'sample.txt', via: 'drop', type: 'text/plain',
    expect: ['FIXTURE-TXT Micropterus nigricans'] },
  { name: 'sample.docx', via: 'picker', lib: true,
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    expect: ['FIXTURE-DOCX Micropterus nigricans'] },
  { name: 'sample.xlsx', via: 'drop', lib: true,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    expect: ['FIXTURE-XLSX-SHEET1 Micropterus nigricans',
             'FIXTURE-XLSX-SHEET2 Lepomis macrochirus'] },
  { name: 'sample.pdf', via: 'drop', lib: true, type: 'application/pdf',
    expect: ['FIXTURE-PDF Micropterus nigricans'] },
];

// ── Arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { url: null, passes: PASSES.slice(), chrome: process.env.CHROME_PATH || null,
                 verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--url') opts.url = next();
    else if (a === '--pass') opts.passes = next().split(',');
    else if (a === '--chrome') opts.chrome = next();
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument: ${a}`);
  }
  for (const p of opts.passes) if (!PASSES.includes(p)) usage(`unknown pass: ${p}`);
  if (opts.url && !/^https?:\/\//.test(opts.url)) usage('--url must start with http(s)://');
  return opts;
}

function usage(err) {
  if (err) console.error(`csp-smoke: ${err}\n`);
  console.error([
    'usage: node tools/csp-smoke.js [options]',
    '',
    '  --url URL            check a deployed site instead of serving fishfinder/',
    `  --pass LIST          any of ${PASSES.join(',')} (default: all)`,
    '  --chrome PATH        Chrome binary (or set CHROME_PATH)',
    '  -v, --verbose        also list warnings and informational events',
  ].join('\n'));
  process.exit(err ? 2 : 0);
}

// ── The CDN list, read from the source the page actually runs ────────────────
function readCdn() {
  const src = fs.readFileSync(path.join(SITE, 'js', 'app.js'), 'utf8');
  const m = /const CDN = (\{[\s\S]*?\n  \});/.exec(src);
  if (!m) throw new Error('could not find the CDN object in fishfinder/js/app.js');
  return vm.runInNewContext(`(${m[1]})`);
}

async function checkCdn(cdn) {
  const failures = [];
  let reached = 0;
  for (const [key, entry] of Object.entries(cdn)) {
    const src = typeof entry === 'string' ? entry : entry.src;
    const integrity = typeof entry === 'string' ? null : entry.integrity;
    let res;
    try {
      res = await fetch(src);
    } catch (e) {
      failures.push(`${key}: could not fetch ${src} (${e.cause?.code || e.message})`);
      continue;
    }
    reached++;
    if (!res.ok) { failures.push(`${key}: HTTP ${res.status} for ${src}`); continue; }
    const body = Buffer.from(await res.arrayBuffer());
    const actual = 'sha384-' + crypto.createHash('sha384').update(body).digest('base64');
    if (!integrity) failures.push(`${key}: no integrity hash for ${src}`);
    else if (integrity !== actual) {
      failures.push(`${key}: integrity mismatch for ${src}\n      app.js has ${integrity}\n      CDN serves ${actual}`);
    }
    if (res.headers.get('access-control-allow-origin') !== '*') {
      failures.push(`${key}: ${src} does not send Access-Control-Allow-Origin: *, so the browser cannot verify its hash`);
    }
  }
  return { failures, reached, total: Object.keys(cdn).length };
}

// ── Runs inside the page ─────────────────────────────────────────────────────
function installCollectors() {
  // An alert() blocks a headless renderer; collect the messages instead.
  window.__alerts = [];
  window.alert = m => { window.__alerts.push(String(m)); };
  window.__csp = window.__csp || [];
  document.addEventListener('securitypolicyviolation', e => {
    window.__csp.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'}`);
  });
  // Skip the post-scan animation; app.js honours reduced motion.
  const realMM = window.matchMedia.bind(window);
  window.matchMedia = q => /prefers-reduced-motion/.test(String(q))
    ? { matches: true, media: q, onchange: null, addEventListener() {},
        removeEventListener() {}, addListener() {}, removeListener() {} }
    : realMM(q);
  return true;
}

async function scanAndPanels(sample) {
  const out = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => document.querySelector(s);
  const btn = $('#check-btn');
  for (let i = 0; i < 300 && btn.disabled; i++) await sleep(50);
  out.databaseLoaded = !btn.disabled;
  // Consent stays declined, so this scan records nothing.
  out.consent = localStorage.getItem('ff_consent');
  if (out.databaseLoaded && out.consent === 'declined') {
    $('#manuscript-text').value = sample;
    btn.click();
    for (let i = 0; i < 200 && $('#results-section').hidden; i++) await sleep(50);
  }
  out.scanRendered = !$('#results-section').hidden;
  $('#info-btn').click();
  await sleep(100);
  out.infoOpened = !$('#info-panel').hidden;
  $('#info-btn').click();
  // REPORT is opened and closed, never filled in or submitted.
  $('#report-btn').click();
  await sleep(100);
  out.reportOpened = !$('#report-panel').hidden;
  $('#report-btn').click();
  return out;
}

async function dashboard() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (let i = 0; i < 300; i++) {
    const s = document.getElementById('stat-sessions').textContent.trim();
    if (s && s !== '—') break;
    await sleep(100);
  }
  out.stats = document.getElementById('stat-sessions').textContent.trim();
  let dots = [];
  for (let i = 0; i < 150; i++) {
    dots = document.querySelectorAll('#usage-map path.leaflet-interactive');
    if (dots.length) break;
    await sleep(100);
  }
  out.dots = dots.length;
  if (dots.length) {
    const el = dots[dots.length - 1];
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window,
                 clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, at));
    for (let i = 0; i < 30 && !document.querySelector('.leaflet-popup-content'); i++) await sleep(100);
    const c = document.querySelector('#usage-map .leaflet-popup-content');
    // Location text from the database must arrive as text, never as markup.
    out.popup = c ? { children: c.children.length, text: c.textContent.trim() } : null;
  }
  return out;
}

function dropFile({ name, b64, type }) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type }));
  document.querySelector('.screen').dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
}

function fileState(alertsBefore) {
  return {
    shown: document.getElementById('file-name').textContent,
    text: document.getElementById('manuscript-text').value,
    alerts: window.__alerts.slice(alertsBefore),
  };
}

function tamperState() {
  return {
    script: window.__tampered || 0,
    style: getComputedStyle(document.body).getPropertyValue('--tampered').trim(),
  };
}

// ── One pass ─────────────────────────────────────────────────────────────────
async function runPass(chromePath, base, pass) {
  const r = { pass, failures: [], warnings: [], info: [], cspIssues: [], errors: [],
              failedLoads: [], longPollRequests: 0, dialogs: [] };
  const tamper = pass === 'tamper' || pass === 'tamper-worker';
  const chrome = await launchChrome(chromePath, 1280, { network: true });
  let tab;
  try {
    tab = await Tab.open(chrome.port);
    await tab.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false }, 5000).catch(() => {});

    const urls = new Map();
    tab.on('Network.requestWillBeSent', p => {
      urls.set(p.requestId, p.request.url);
      if (/\.firebaseio\.com\/\.lp\?/.test(p.request.url)) r.longPollRequests++;
    });
    tab.on('Network.loadingFailed', p => {
      if (p.canceled || p.errorText === 'net::ERR_ABORTED') return;
      r.failedLoads.push(`${p.errorText}${p.blockedReason ? ` [${p.blockedReason}]` : ''} ` +
                         `${urls.get(p.requestId) || p.requestId}`);
    });
    tab.on('Audits.issueAdded', p => {
      const i = p.issue;
      if (i.code !== 'ContentSecurityPolicyIssue') return;
      const d = i.details.contentSecurityPolicyIssueDetails || {};
      r.cspIssues.push(`${d.contentSecurityPolicyViolationType || 'violation'}: ` +
                       `${d.violatedDirective || '?'} blocked ${d.blockedURL || '(inline/eval)'}`);
    });
    tab.on('Log.entryAdded', p => {
      const e = p.entry;
      if (e.level === 'error') r.errors.push(`${e.source}: ${e.text}${e.url ? ` (${e.url})` : ''}`);
      else if (e.level === 'warning') r.warnings.push(`${e.source}: ${e.text}`);
    });
    tab.on('Runtime.exceptionThrown', p => {
      const d = p.exceptionDetails;
      r.errors.push(`uncaught: ${d.exception?.description?.split('\n')[0] || d.text}`);
    });
    tab.on('Runtime.consoleAPICalled', p => {
      const msg = p.args.map(a => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error') r.errors.push(`console.error: ${msg}`);
      else if (p.type === 'warning') r.warnings.push(`console.warn: ${msg}`);
    });
    tab.on('Page.javascriptDialogOpening', p => {
      r.dialogs.push(p.message);
      tab.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    for (const d of ['Runtime', 'Log', 'Audits', 'Network', 'Page', 'DOM']) {
      await tab.send(`${d}.enable`, {}, 10000).catch(() => {});
    }
    await tab.send('Network.setCacheDisabled', { cacheDisabled: true }, 5000).catch(() => {});

    if (tamper) {
      const patterns = pass === 'tamper'
        ? CDN_HOSTS.map(h => ({ urlPattern: `https://${h}/*` }))
        : [{ urlPattern: '*pdf.worker.min.js*' }];
      tab.on('Fetch.requestPaused', p => {
        const css = /\.css(\?|$)/.test(p.request.url);
        const body = css ? 'body{--tampered:1}' : 'window.__tampered=(window.__tampered||0)+1;';
        tab.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: css ? 'text/css' : 'text/javascript' },
            // Pass CORS, so the integrity check is what has to catch it.
            { name: 'Access-Control-Allow-Origin', value: '*' },
          ],
          body: Buffer.from(body).toString('base64'),
        }).catch(() => {});
      });
      await tab.send('Fetch.enable', { patterns }, 10000);
    }

    // First visit, then the stored state this pass needs, then a clean reload.
    const sep = base.includes('?') ? '&' : '?';
    await tab.goto(`${base}${sep}smoke=1`);
    await tab.evaluate(longpoll => {
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('ff_consent', 'declined');
      localStorage.setItem('ff_onboarded', '1');
      if (longpoll) localStorage.setItem('firebase:previous_websocket_failure', 'true');
      return true;
    }, pass === 'longpoll');
    await tab.goto(`${base}${sep}smoke=2`);
    await tab.evaluate(installCollectors);

    const page = await tab.evaluate(scanAndPanels, SAMPLE, 60000);
    // With Firebase tampered the dashboard cannot load, by design.
    const dash = tamper ? null : await tab.evaluate(dashboard, null, 60000);

    // Files. In the tamper passes each library-backed file goes through twice,
    // because a failed load followed by a "successful" retry is exactly how an
    // unhashed copy could slip in.
    const fileResults = [];
    const rounds = tamper ? 2 : 1;
    for (let round = 0; round < rounds; round++) {
      for (const f of FILES) {
        if (round > 0 && !f.lib) continue;
        if (pass === 'tamper-worker' && f.name !== 'sample.pdf') continue;
        const abs = path.join(FIXTURES, f.name);
        const alertsBefore = await tab.evaluate(() => window.__alerts.length);
        if (f.via === 'picker') {
          const { root } = await tab.send('DOM.getDocument', { depth: 1 });
          const { nodeId } = await tab.send('DOM.querySelector',
            { nodeId: root.nodeId, selector: '#file-input' });
          await tab.send('DOM.setFileInputFiles', { nodeId, files: [abs] });
        } else {
          await tab.evaluate(dropFile, { name: f.name, type: f.type,
                                         b64: fs.readFileSync(abs).toString('base64') });
        }
        let st;
        for (let i = 0; i < 450; i++) {
          st = await tab.evaluate(fileState, alertsBefore);
          if (st.shown === f.name || st.alerts.length) break;
          await sleep(100);
        }
        fileResults.push({ file: f, round, ...st,
                           missing: f.expect.filter(s => !st.text.includes(s)) });
      }
    }
    await sleep(500);
    const inPageCsp = await tab.evaluate(() => window.__csp.slice());
    const tampered = await tab.evaluate(tamperState);
    const alerts = await tab.evaluate(() => window.__alerts.slice());

    // ── Judge ────────────────────────────────────────────────────────────────
    for (const v of inPageCsp) {
      if (!r.cspIssues.some(i => i.includes(v.split(' blocked ')[1]))) r.cspIssues.push(`page: ${v}`);
    }
    if (tamper) {
      if (tampered.script) r.failures.push(`tampered script RAN ${tampered.script} time(s): an integrity check was bypassed`);
      if (tampered.style) r.failures.push('tampered stylesheet APPLIED: an integrity check was bypassed');
      const refused = r.errors.filter(e => /integrity/i.test(e)).length;
      r.info.push(`integrity refused ${refused} tampered load(s); ${alerts.length} expected error alert(s)`);
      if (!refused) r.failures.push('no integrity refusal was observed, so nothing was actually tested');
      return r;
    }

    for (const i of r.cspIssues) r.failures.push(`CSP ${i}`);
    for (const e of r.errors) r.failures.push(e);
    for (const l of r.failedLoads) r.failures.push(`load failed: ${l}`);
    for (const a of alerts) r.failures.push(`alert: ${a}`);
    for (const d of r.dialogs) r.failures.push(`dialog: ${d}`);
    for (const w of r.warnings) {
      // The app logs these when the dashboard or analytics could not load.
      if (/unavailable/i.test(w)) r.failures.push(w);
    }
    if (!page.databaseLoaded) r.failures.push('fish_names.json never loaded (SCAN stayed disabled)');
    if (page.consent !== 'declined') r.failures.push(`consent was "${page.consent}", not declined: scan skipped to avoid writing live data`);
    if (!page.scanRendered) r.failures.push('scan results never rendered');
    if (!page.infoOpened) r.failures.push('INFO panel did not open');
    if (!page.reportOpened) r.failures.push('REPORT panel did not open');
    if (!dash.stats || dash.stats === '—') r.failures.push('usage statistics never loaded from Firebase');
    if (!dash.dots) r.warnings.push('no visit dots on the map, so the popup check was skipped');
    else if (!dash.popup) r.failures.push('clicking a map dot did not open its popup');
    else if (dash.popup.children) r.failures.push(`map popup contains ${dash.popup.children} HTML element(s); it must be plain text`);
    else r.info.push(`popup text: "${dash.popup.text}"; stats: ${dash.stats}; dots: ${dash.dots}`);
    for (const fr of fileResults) {
      if (fr.alerts.length) r.failures.push(`${fr.file.name}: ${fr.alerts.join(' | ')}`);
      else if (fr.shown !== fr.file.name) r.failures.push(`${fr.file.name}: never finished loading`);
      else if (fr.missing.length) r.failures.push(`${fr.file.name}: extracted text is missing "${fr.missing.join('", "')}"`);
      else r.info.push(`${fr.file.name} (${fr.file.via}): text extracted`);
    }
    if (pass === 'longpoll') {
      if (!r.longPollRequests) r.failures.push('Firebase never long-polled, so this pass tested nothing');
      else r.info.push(`${r.longPollRequests} long-poll request(s) to *.firebaseio.com`);
    }
    return r;
  } finally {
    if (tab) tab.close();
    await stopChrome(chrome);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const lines = [];
  let failures = 0;

  const cdn = readCdn();
  const pre = await checkCdn(cdn);
  lines.push('FISHFINDER CSP & integrity smoke check');
  lines.push('');
  lines.push(`CDN files: ${pre.total} listed in js/app.js, ${pre.reached} reachable, ` +
             `${pre.failures.length} problem(s)`);
  for (const f of pre.failures) lines.push(`  FAIL ${f}`);
  failures += pre.failures.length;
  if (pre.reached === 0) {
    console.log(lines.join('\n'));
    console.error('csp-smoke: no CDN host was reachable; is this machine offline?');
    process.exit(2);
  }

  let chromePath, server = null;
  try {
    chromePath = findChrome(opts.chrome);
  } catch (e) {
    console.error(`csp-smoke: ${e.message}`);
    process.exit(2);
  }
  let base = opts.url;
  if (!base) {
    server = await startServer();
    base = `http://127.0.0.1:${server.address().port}/index.html`;
  }
  lines.push(`Target: ${base}`);

  try {
    for (const pass of opts.passes) {
      process.stderr.write(`  running ${pass}...\n`);
      const r = await runPass(chromePath, base, pass);
      failures += r.failures.length;
      lines.push('');
      lines.push(`${r.failures.length ? 'FAIL' : 'pass'}  ${pass}`);
      for (const f of r.failures) lines.push(`  FAIL ${f}`);
      if (opts.verbose || r.failures.length) {
        for (const i of r.info) lines.push(`  info ${i}`);
      }
      if (opts.verbose) {
        for (const w of r.warnings) lines.push(`  warn ${w}`);
      }
    }
  } finally {
    if (server) server.close();
  }

  lines.push('');
  lines.push(`${failures ? 'FAIL' : 'PASS'} — ${failures} failure(s), ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(lines.join('\n'));
  process.exit(failures ? 1 : 0);
}

main().catch(e => {
  console.error(`csp-smoke: ${e.stack || e.message}`);
  process.exit(2);
});
