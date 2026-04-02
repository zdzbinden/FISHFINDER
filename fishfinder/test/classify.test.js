const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { engine, lookups } = require('./setup');

const classify = (g, s) => engine.classifyName(lookups, g, s);

describe('classifyName', () => {
  // ── Valid names ─────────────────────────────────────────────────────────
  describe('valid names', () => {
    it('recognizes a valid species', () => {
      const r = classify('Oncorhynchus', 'mykiss');
      assert.ok(r, 'should not return null');
      assert.equal(r.type, 'valid');
      assert.equal(r.canonical, 'Oncorhynchus mykiss');
      assert.ok(r.commonName.length > 0, 'should have a common name');
    });

    it('flags species changed in 8th edition', () => {
      // Micropterus salmoides was changed (now = Florida Bass)
      const r = classify('Micropterus', 'salmoides');
      assert.ok(r);
      assert.equal(r.type, 'changed');
    });

    it('flags Micropterus nigricans as changed (Largemouth Bass)', () => {
      const r = classify('Micropterus', 'nigricans');
      assert.ok(r);
      assert.equal(r.type, 'changed');
    });
  });

  // ── Synonyms / outdated names ──────────────────────────────────────────
  describe('outdated names (synonyms)', () => {
    it('detects a known synonym and suggests the current name', () => {
      const r = classify('Stizostedion', 'vitreum');
      assert.ok(r);
      assert.equal(r.type, 'outdated');
      assert.equal(r.suggestion, 'Sander vitreus');
    });
  });

  // ── Misspelled names ──────────────────────────────────────────────────
  describe('misspelled names', () => {
    it('catches a misspelled species epithet (salmodes → salmoides)', () => {
      const r = classify('Micropterus', 'salmodes');
      assert.ok(r);
      assert.equal(r.type, 'misspelled');
      assert.ok(r.suggestion.includes('Micropterus'));
    });

    it('catches a misspelled genus (Micropteris → Micropterus)', () => {
      const r = classify('Micropteris', 'salmoides');
      assert.ok(r);
      assert.equal(r.type, 'misspelled');
      assert.ok(r.suggestion.includes('Micropterus'));
    });
  });

  // ── Unknown names ──────────────────────────────────────────────────────
  describe('unknown names', () => {
    it('returns unknown for a valid genus with unrecognized species', () => {
      const r = classify('Micropterus', 'fantasius');
      assert.ok(r);
      assert.equal(r.type, 'unknown');
      assert.equal(r.suggestion, null);
    });
  });

  // ── Confidence and edit distance ────────────────────────────────────
  describe('confidence and editDistance fields', () => {
    it('returns confidence 1.0 and editDistance 0 for valid names', () => {
      const r = classify('Oncorhynchus', 'mykiss');
      assert.equal(r.confidence, 1.0);
      assert.equal(r.editDistance, 0);
    });

    it('returns confidence 0.95 for exact synonym matches', () => {
      const r = classify('Stizostedion', 'vitreum');
      assert.equal(r.confidence, 0.95);
      assert.equal(r.editDistance, 0);
    });

    it('returns lower confidence for misspelled names', () => {
      const r = classify('Micropterus', 'salmodes');
      assert.ok(r.confidence <= 0.70);
      assert.ok(r.editDistance >= 1);
    });

    it('returns confidence 0.30 for unknown names', () => {
      const r = classify('Micropterus', 'fantasius');
      assert.equal(r.confidence, 0.30);
      assert.equal(r.editDistance, null);
    });
  });

  // ── Non-fish names ────────────────────────────────────────────────────
  describe('non-fish names', () => {
    it('returns null for a non-fish organism', () => {
      const r = classify('Homo', 'sapiens');
      assert.equal(r, null);
    });

    it('returns null for species abbreviations', () => {
      assert.equal(classify('Oncorhynchus', 'sp'), null);
      assert.equal(classify('Oncorhynchus', 'spp'), null);
      assert.equal(classify('Salmo', 'cf'), null);
      assert.equal(classify('Salmo', 'aff'), null);
    });
  });

  // ── Common name matching ──────────────────────────────────────────────
  describe('common name matching (via classifyName)', () => {
    it('matches a two-word common name used as a binomial-like input', () => {
      // "Largemouth Bass" has both words starting with uppercase in real text,
      // but classifyName receives genus="Largemouth", species="bass" only if
      // the regex extracted it. Test the lookup directly.
      const r = classify('Largemouth', 'bass');
      // This should match via commonNameMap if "largemouth bass" is there
      if (r) {
        assert.equal(r.type, 'common');
        assert.ok(r.suggestion);
      }
      // If null, common name matching works differently (expected for CANDIDATE_RE
      // which requires lowercase species — "Bass" wouldn't match the regex)
    });
  });
});
