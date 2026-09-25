/**
 * Security regression tests: they pin down the fixes from the 2026-09-25
 * security audit so none of them can quietly come back.
 *
 * - the Content-Security-Policy in index.html;
 * - the CDN list in app.js: every file hashed, every URL in the CSP;
 * - the places app.js writes HTML, and the escaping of what goes into them;
 * - the Firebase rules, the site's only server-side code;
 * - the deploy workflow's action pins;
 * - the shape of every name in fish_names.json, since scraped text reaches
 *   the page.
 *
 * Offline and zero-dependency like the rest of the suite. The browser-level
 * counterpart, which loads the real files, is tools/csp-smoke.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { db } = require('./setup');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const html = read('fishfinder/index.html');
const app = read('fishfinder/js/app.js');

function parseCsp() {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(m, 'no Content-Security-Policy <meta> tag in index.html');
  const directives = new Map();
  for (const part of m[1].split(';').map(s => s.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    // A browser silently ignores a repeated directive.
    assert.ok(!directives.has(name), `CSP directive ${name} appears twice`);
    directives.set(name, sources);
  }
  return { at: m.index, directives };
}

function readCdn() {
  const m = /const CDN = (\{[\s\S]*?\n  \});/.exec(app);
  assert.ok(m, 'no CDN object in app.js');
  return vm.runInNewContext(`(${m[1]})`);
}

// The real esc() from app.js, run in a sandbox rather than copied.
function loadEsc() {
  const m = /function esc\(str\) \{[\s\S]*?\n  \}/.exec(app);
  assert.ok(m, 'no esc() in app.js');
  return vm.runInNewContext(`(${m[0]})`);
}

const lineOf = index => app.slice(0, index).split('\n').length;

describe('security', () => {
  describe('Content-Security-Policy (index.html)', () => {
    const { at, directives } = parseCsp();
    const src = name => directives.get(name) || [];

    it('comes before every stylesheet and script it has to govern', () => {
      // A <meta> CSP applies only to what follows it.
      for (const re of [/rel="stylesheet"/, /<script src=/]) {
        const m = re.exec(html);
        assert.ok(m && m.index > at, `${re} appears before the CSP tag`);
      }
    });

    it('allows scripts only from itself, exact CDN files and Firebase', () => {
      const s = src('script-src');
      assert.ok(s.includes("'self'"));
      for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'",
                         'data:', 'blob:', '*', 'https:', 'http:']) {
        assert.ok(!s.includes(bad), `script-src must not allow ${bad}`);
      }
      for (const x of s.filter(x => x !== "'self'")) {
        assert.ok(x === 'https://*.firebaseio.com' || /^https:\/\/[^*\s]+\.js$/.test(x),
          `script-src entry ${x} is neither an exact .js URL nor the Firebase fallback`);
      }
    });

    it('allows styles only from itself, exact CDN files and Google Fonts', () => {
      const s = src('style-src');
      assert.ok(!s.includes("'unsafe-inline'"), "style-src must not allow 'unsafe-inline'");
      for (const x of s.filter(x => x !== "'self'")) {
        assert.ok(x === 'https://fonts.googleapis.com' || /^https:\/\/[^*\s]+\.css$/.test(x),
          `style-src entry ${x} is neither an exact .css URL nor Google Fonts`);
      }
    });

    it('sets the directives default-src does not cover', () => {
      assert.deepEqual(src('default-src'), ["'self'"]);
      assert.deepEqual(src('object-src'), ["'none'"]);
      assert.deepEqual(src('base-uri'), ["'self'"]);
      assert.deepEqual(src('form-action'), ["'self'"]);
    });

    it('connects only to itself, geolocation and Firebase', () => {
      assert.deepEqual([...src('connect-src')].sort(),
        ["'self'", 'https://*.firebaseio.com', 'https://ipapi.co', 'wss://*.firebaseio.com']);
    });

    it('holds nothing a <meta> CSP ignores', () => {
      // These only work as HTTP headers, which GitHub Pages cannot send; in a
      // meta tag they are dropped with a console error and protect nothing.
      for (const d of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) {
        assert.ok(!directives.has(d), `${d} has no effect in a <meta> CSP`);
      }
    });
  });

  describe('CDN list (app.js) and the CSP agree', () => {
    const cdn = readCdn();
    const { directives } = parseCsp();
    const allowed = [...(directives.get('script-src') || []), ...(directives.get('style-src') || [])];

    it('gives every CDN file a versioned URL and an sha384 integrity hash', () => {
      for (const [key, entry] of Object.entries(cdn)) {
        assert.equal(typeof entry, 'object', `CDN.${key} must be { src, integrity }`);
        assert.match(entry.src, /^https:\/\//, `CDN.${key} must load over https`);
        assert.match(entry.src, /\d+\.\d+\.\d+/, `CDN.${key} must name an exact version`);
        assert.match(entry.integrity, /^sha384-[A-Za-z0-9+/]{64}$/, `CDN.${key} needs an sha384 hash`);
      }
    });

    it('allows every CDN file by its exact URL', () => {
      for (const [key, { src }] of Object.entries(cdn)) {
        const directive = src.endsWith('.css') ? 'style-src' : 'script-src';
        assert.ok((directives.get(directive) || []).includes(src),
          `CDN.${key} (${src}) is missing from ${directive}; the browser will block it`);
      }
    });

    it('names no file in the CSP that the CDN list has dropped', () => {
      const srcs = new Set(Object.values(cdn).map(e => e.src));
      for (const x of allowed.filter(x => /\.(js|css)$/.test(x))) {
        assert.ok(srcs.has(x), `${x} is allowed by the CSP but no longer in the CDN list`);
      }
    });

    it('passes the integrity hash at every lazy load', () => {
      const calls = [...app.matchAll(/\bload(Script|Style)\(([^)]*)\)/g)]
        .filter(m => !/^src, integrity$|^href, integrity$/.test(m[2]));
      assert.ok(calls.length >= 8, `expected at least 8 lazy loads, found ${calls.length}`);
      for (const m of calls) {
        assert.match(m[2], /^CDN\.(\w+)\.src, CDN\.\1\.integrity$/,
          `app.js:${lineOf(m.index)} loads without CDN.x.src, CDN.x.integrity`);
      }
    });

    it('retries a failed script load instead of trusting its dead tag', () => {
      // Resolving on a failed tag is how the unhashed pdf.js worker got in.
      assert.match(app, /s\.onerror = \(\) => \{[\s\S]*?s\.remove\(\);[\s\S]*?scriptLoads\.delete\(src\);/);
    });

    it('never lets pdf.js fall back to an unhashed worker', () => {
      const pdfCase = /case 'pdf':[\s\S]*?break;/.exec(app);
      assert.ok(pdfCase, "no case 'pdf' in processFile");
      assert.match(pdfCase[0],
        /loadScript\(CDN\.pdfjsW\.src, CDN\.pdfjsW\.integrity\)[\s\S]*?WorkerMessageHandler[\s\S]*?throw[\s\S]*?extractPdf\(file\)/,
        'the hashed worker must be loaded and checked before extractPdf()');
      assert.match(app, /getDocument\(\{[^}]*isEvalSupported: false[^}]*\}\)/,
        'getDocument() must pass isEvalSupported: false (CVE-2024-4367)');
    });
  });

  describe('HTML written by app.js', () => {
    it('esc() encodes every HTML metacharacter and tolerates non-strings', () => {
      const esc = loadEsc();
      assert.equal(esc(`<a href="x" title='y'>&`),
        '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
      assert.equal(esc(undefined), '');
      assert.equal(esc(null), '');
      assert.equal(esc(42), '42');
    });

    // Every place app.js hands a string to the HTML parser. A new one fails
    // here with its line number: escape everything interpolated into it, then
    // add its signature below.
    const KNOWN_SINKS = [
      'highlightedEl.innerHTML = buildSpeciesListHTML(findings)',
      "tbody.innerHTML = ''",
      'tr.innerHTML =',
      "document.getElementById('usage-map').innerHTML =",
      '}).bindPopup(where)',
    ];
    const SINK = /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\.bind(Popup|Tooltip)\(|\.setContent\(/;

    it('writes HTML only in the places known to be safe', () => {
      const lines = app.split('\n');
      const seen = new Set();
      lines.forEach((line, i) => {
        if (!SINK.test(line) || /^\s*\/\//.test(line)) return;
        const sig = KNOWN_SINKS.find(k => line.includes(k));
        assert.ok(sig, `new HTML sink at app.js:${i + 1}: ${line.trim()}`);
        seen.add(sig);
      });
      for (const k of KNOWN_SINKS) assert.ok(seen.has(k), `known sink no longer found: ${k}`);
    });

    it('escapes the usage-map popup text, which anyone can write', () => {
      const m = /\.bindPopup\((\w+)\)/.exec(app);
      assert.ok(m, 'bindPopup() must take a variable holding escaped text');
      assert.match(app, new RegExp(`const ${m[1]} = esc\\(`),
        `the popup text (${m[1]}) must come from esc()`);
    });

    it('escapes every value interpolated into an HTML template', () => {
      // Safe without esc(), and why:
      //   f.type         set by the engine from a fixed list of tier names
      //   statusLabel    a fixed label, or f.type
      //   suggestionCell built just above from esc()'d parts and fixed text
      //   label          built just above from esc()'d parts and f.type
      const SAFE = new Set(['f.type', 'statusLabel', 'suggestionCell', 'label']);
      app.split('\n').forEach((line, i) => {
        if (!line.includes('`') || !/<[a-z/]/i.test(line) || /^\s*\/\//.test(line)) return;
        for (let at = line.indexOf('${'); at !== -1; at = line.indexOf('${', at + 2)) {
          let depth = 0, end = at + 2;
          for (; end < line.length; end++) {
            if (line[end] === '{') depth++;
            else if (line[end] === '}' && depth-- === 0) break;
          }
          const expr = line.slice(at + 2, end).trim();
          assert.ok(expr.startsWith('esc(') || SAFE.has(expr),
            `app.js:${i + 1} interpolates \${${expr}} into HTML without esc()`);
        }
      });
    });
  });

  describe('Firebase rules (database.rules.json)', () => {
    const rules = JSON.parse(read('database.rules.json')).rules;
    const app_ = rules.fishfinder;

    // Every .read/.write in the tree, with its path.
    const grants = [];
    (function walk(node, at) {
      for (const [k, v] of Object.entries(node)) {
        if (k === '.read' || k === '.write') grants.push({ at: `${at}/${k}`, k, v });
        else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${at}/${k}`);
      }
    })(rules, '');

    it('grants nothing on the root or on the app as a whole', () => {
      for (const node of [rules, app_]) {
        assert.ok(!('.read' in node) && !('.write' in node), 'no blanket read/write');
      }
    });

    it('never allows deletes', () => {
      // Firebase does not run .validate on a delete, so a write rule is the
      // only thing that can stop one.
      for (const g of grants.filter(g => g.k === '.write')) {
        assert.notEqual(g.v, true, `${g.at} is an unconditional write`);
        assert.match(String(g.v), /newData\.exists\(\)/, `${g.at} allows deletes`);
      }
    });

    it('keeps issue reports private', () => {
      assert.ok(!grants.some(g => g.k === '.read' && g.at.startsWith('/fishfinder/issues')),
        'issue reports hold emails; no public read');
    });

    it('makes visits and reports create-only', () => {
      for (const node of ['visits', 'issues']) {
        const w = app_[node].$pushId['.write'];
        assert.match(w, /!data\.exists\(\)/, `${node} records can be overwritten`);
      }
    });

    it('caps reads of the visit history at 500', () => {
      assert.match(String(app_.visits['.read']), /query\.limitToLast <= 500/);
    });

    it('validates every field and rejects unknown ones', () => {
      for (const node of [app_.visits.$pushId, app_.issues.$pushId]) {
        assert.equal(node.$other['.validate'], false);
        for (const [k, v] of Object.entries(node)) {
          if (k.startsWith('.') || k === '$other') continue;
          assert.match(v['.validate'], /isNumber\(\)|isString\(\)/, `field ${k} is not type-checked`);
          if (/isString\(\)/.test(v['.validate'])) {
            assert.match(v['.validate'], /length <=/, `string field ${k} has no length limit`);
          }
        }
      }
      assert.equal(app_.stats.$other['.validate'], false);
    });
  });

  describe('deploy workflow (.github/workflows/deploy.yml)', () => {
    const yml = read('.github/workflows/deploy.yml');

    it('pins every action to a full commit SHA', () => {
      const uses = yml.split('\n').filter(l => /^\s*-?\s*uses:/.test(l));
      assert.ok(uses.length >= 4, 'expected the four Pages actions');
      for (const l of uses) {
        assert.match(l, /uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*\s*$/,
          `not pinned to a SHA with a version comment: ${l.trim()}`);
      }
    });

    it('grants no permissions at the workflow level and keeps no token', () => {
      assert.match(yml, /^permissions: \{\}\s*$/m);
      assert.match(yml, /persist-credentials: false/);
      assert.ok(!/pull_request_target/.test(yml), 'pull_request_target runs with write access');
    });

    it('has Dependabot keep the pins current', () => {
      assert.match(read('.github/dependabot.yml'), /package-ecosystem: "github-actions"/);
    });
  });

  describe('database text that reaches the page', () => {
    it('holds only plain binomials as names', () => {
      const B = /^[A-Z][a-z]+ [a-z][a-z-]+$/;
      const names = [...Object.keys(db.valid_names), ...Object.keys(db.synonyms),
                     ...Object.values(db.synonyms), ...Object.keys(db.removed_names || {})];
      const bad = names.filter(n => !B.test(n));
      assert.deepEqual(bad.slice(0, 5), [], `${bad.length} name(s) are not plain binomials`);
      assert.ok(db.genera.every(g => /^[A-Z][a-z]+$/.test(g)), 'a genus is not a plain word');
    });

    it('has no markup or control characters in any string', () => {
      // Names and common names are scraped or parsed from outside sources and
      // rendered into the page. They are escaped there too; this catches a bad
      // build before it ships.
      const bad = [];
      // Control characters and U+2028/U+2029 are built from code points rather
      // than written as escapes, which editing tools have turned into raw ones.
      const MARKUP = new RegExp('[<>' + String.fromCharCode(0) + '-' +
        String.fromCharCode(0x1f, 0x7f, 0x2028, 0x2029) + ']');
      (function walk(v) {
        if (typeof v === 'string') { if (MARKUP.test(v)) bad.push(v); }
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) { walk(k); walk(x); }
        }
      })(db);
      assert.deepEqual(bad.slice(0, 5), [], `${bad.length} string(s) contain markup or control characters`);
    });
  });
});
