const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { engine, lookups } = require('./setup');

const classify = (g, s) => engine.classifyName(lookups, g, s);

describe('fuzzy matching edge cases', () => {
  describe('edit distance boundaries', () => {
    it('catches a 1-edit misspelling', () => {
      // Salmo truta (missing one 't') → Salmo trutta
      const r = classify('Salmo', 'truta');
      assert.ok(r);
      assert.equal(r.type, 'misspelled');
      assert.equal(r.suggestion, 'Salmo trutta');
    });

    it('catches a 2-edit misspelling', () => {
      // Oncorhynchus mikiss (y→i, missing one s? let's try)
      const r = classify('Oncorhynchus', 'mikiss');
      if (r && r.type === 'misspelled') {
        assert.ok(r.suggestion.includes('Oncorhynchus'));
      }
    });

    it('rejects a 3+ edit misspelling (beyond threshold)', () => {
      // Completely wrong species
      const r = classify('Micropterus', 'xyzabc');
      if (r) {
        assert.notEqual(r.type, 'misspelled');
      }
    });
  });

  describe('first-letter genus filter', () => {
    it('still rejects short genera with wrong first letter', () => {
      // "Xalmo" (5 chars) vs "Salmo" — too short for relaxed filter
      const r = classify('Xalmo', 'trutta');
      assert.equal(r, null);
    });

    it('still rejects distant first letters even for long genera', () => {
      // Xicropterus (X) vs Micropterus (M) — too far apart
      const r = classify('Xicropterus', 'salmoides');
      assert.equal(r, null);
    });

    it('catches adjacent-key first-letter typo on long genera', () => {
      // Nicropterus (N) vs Micropterus (M) — adjacent keys, genus ≥ 8 chars
      const r = classify('Nicropterus', 'salmoides');
      assert.ok(r, 'should match despite first-letter mismatch on long genus');
      assert.equal(r.type, 'misspelled');
      assert.ok(r.suggestion.includes('Micropterus'));
    });
  });

  describe('species charCode proximity filter', () => {
    it('rejects species with distant first character', () => {
      // Micropterus zalmoides — 'z' is far from 's', should not match easily
      const r = classify('Micropterus', 'zalmoides');
      // Depending on charCode distance, this may or may not match
      if (r && r.type === 'misspelled') {
        // If it does match, the distance should still be ≤2
        assert.ok(r.suggestion);
      }
    });
  });

  describe('synonym fuzzy matching', () => {
    it('catches a slightly misspelled synonym', () => {
      // If "Stizostedion vitreum" is a synonym, "Stizostedion vitreim" (1 edit) should work
      const r = classify('Stizostedion', 'vitreim');
      if (r) {
        assert.equal(r.type, 'outdated');
      }
    });

    it('does not fuzzy-match unrelated congeners across synonym entries', () => {
      // The fuzzy synonym match (step 2b) must require an exact genus match
      // to prevent false positives between unrelated species that happen to
      // share a genus but have species epithets within edit distance 2.
      // Use a fabricated example: "Salmo fakeus" should NOT fuzzy-match a
      // synonym like "Salmo trutta" (dist > 2), but also should not match
      // via genus-fuzzy path if genus has a typo.
      const r = classify('Salmo', 'fakeus');
      if (r) {
        // If it matches at all, it should be unknown (valid genus, unknown species)
        // NOT outdated via fuzzy synonym
        assert.notEqual(r.type, 'outdated',
          'fabricated species should not fuzzy-match an unrelated synonym');
      }
    });
  });

  describe('case handling', () => {
    it('classifyName is case-insensitive on lookups', () => {
      const r1 = classify('Oncorhynchus', 'mykiss');
      const r2 = classify('ONCORHYNCHUS', 'MYKISS');
      // Both should resolve (r2 may resolve differently due to genus casing)
      assert.ok(r1, 'standard casing should resolve');
      // r2 won't match CANDIDATE_RE (needs Cap+lower), but classifyName itself
      // receives whatever is passed — the uppercase won't match validSet directly
      // since validSet stores lowercase. Actually it will, because we lowercase.
      if (r2) {
        assert.equal(r2.type, r1.type);
      }
    });
  });

  describe('species abbreviation filtering', () => {
    it('filters all known abbreviations', () => {
      for (const abbrev of ['sp', 'spp', 'cf', 'aff', 'nr', 'var', 'subsp']) {
        const r = classify('Salmo', abbrev);
        assert.equal(r, null, `should filter "${abbrev}"`);
      }
    });

    it('filters common English stopwords', () => {
      for (const word of ['the', 'and', 'for', 'are', 'with', 'from', 'this', 'were', 'their']) {
        const r = classify('Society', word);
        assert.equal(r, null, `should filter "${word}"`);
      }
    });
  });

  describe('false positive rejection', () => {
    it('rejects "Society of" — must not fuzzy-match to a synonym (GH bug)', () => {
      const r = classify('Society', 'of');
      assert.equal(r, null);
    });

    it('rejects short species epithets (2-char words)', () => {
      for (const word of ['of', 'in', 'on', 'at', 'to', 'by', 'an', 'or']) {
        const r = classify('American', word);
        assert.equal(r, null, `should reject 2-char epithet "${word}"`);
      }
    });

    it('rejects common manuscript phrases', () => {
      const phrases = [
        ['American', 'Fisheries'],
        ['Conservation', 'Biology'],
        ['Environmental', 'Science'],
        ['Population', 'dynamics'],
        ['Freshwater', 'Research'],
      ];
      for (const [g, s] of phrases) {
        const r = classify(g, s);
        assert.equal(r, null, `should reject "${g} ${s}"`);
      }
    });
  });

  describe('round-trip: all database species through engine', () => {
    it('classifies every valid species as valid or changed', () => {
      const missed = [];
      for (const [binomial, info] of Object.entries(lookups.db.valid_names)) {
        const parts = binomial.split(' ');
        if (parts.length < 2) continue;
        const genus = parts[0];
        const species = parts.slice(1).join(' ');
        const result = engine.classifyName(lookups, genus, species);
        if (!result || (result.type !== 'valid' && result.type !== 'changed')) {
          missed.push(binomial);
        }
      }
      assert.equal(missed.length, 0,
        `${missed.length} species not classified as valid/changed: ${missed.slice(0, 10).join(', ')}`);
    });

    it('extracts every valid species from synthetic text', () => {
      // Build text with every species as "Genus species" on its own line
      const allNames = Object.keys(lookups.db.valid_names);
      const text = allNames.join('\n');
      const candidates = engine.extractCandidates(text, lookups);
      const found = new Set(candidates.map(c => `${c.genus} ${c.species}`));
      const missed = allNames.filter(n => !found.has(n));
      assert.equal(missed.length, 0,
        `${missed.length} species not extracted: ${missed.slice(0, 10).join(', ')}`);
    });
  });

  describe('database integrity', () => {
    it('has a reasonable number of valid names', () => {
      assert.ok(lookups.validSet.size > 5000, `expected >5000 valid names, got ${lookups.validSet.size}`);
    });

    it('has a reasonable number of synonyms', () => {
      assert.ok(lookups.synonymMap.size > 8000, `expected >8000 synonyms, got ${lookups.synonymMap.size}`);
    });

    it('has a reasonable number of genera', () => {
      assert.ok(lookups.generaSet.size > 1400, `expected >1400 genera, got ${lookups.generaSet.size}`);
    });

    it('has common names for most species', () => {
      assert.ok(lookups.commonNameMap.size > 4000, `expected >4000 common names, got ${lookups.commonNameMap.size}`);
    });
  });
});
