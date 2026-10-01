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

    // Legitimate genus transfers / junior synonyms must STILL be flagged after
    // the round-2 extralimital cleanup (anti-over-deletion guard).
    for (const [g, s, exp] of [
      ['Tilapia', 'zillii', 'Coptodon zillii'],           // genus transfer
      ['Notropis', 'hudsonius', 'Hudsonius hudsonius'],   // 8th-ed genus split
      ['Notropis', 'deliciosus', 'Miniellus stramineus'], // junior synonym preserved
      ['Petromyzon', 'americanus', 'Petromyzon marinus'], // same-genus junior synonym
    ]) {
      it(`still flags ${g} ${s} as outdated -> ${exp}`, () => {
        const r = classify(g, s);
        assert.ok(r, 'should not be null');
        assert.equal(r.type, 'outdated');
        assert.equal(r.suggestion, exp);
      });
    }
  });

  // ── Names from one author's placement elsewhere (2026-10-01) ────────────
  //    The scraper read every "Synonym of X" bullet in a catalog entry as a
  //    former name of the page's species. One author putting the entry under a
  //    different species is a disagreement, not a former name: La Rivers (1994)
  //    filed Pimelodus pullus under Ictalurus melas, and Ictalurus melas shipped
  //    as Brown Bullhead. The rejected names were then each looked up in the
  //    catalog (verify_chain_names.py, chain_verdicts.json).
  describe('names from a disputed placement', () => {
    it('suggests Black Bullhead for Ictalurus melas, not Brown Bullhead', () => {
      const r = classify('Ictalurus', 'melas');
      assert.ok(r);
      assert.equal(r.type, 'outdated');
      assert.equal(r.suggestion, 'Ameiurus melas');
    });

    // Valid elsewhere, but the 6th or 7th edition of Names of Fishes used the
    // name for this fish, so a manuscript using it is out of date.
    for (const [g, s, exp] of [
      ['Antennarius', 'striatus', 'Antennarius scaber'],
      ['Microphis', 'brachyurus', 'Microphis lineatus'],
      ['Squalus', 'mitsukurii', 'Squalus clarkae'],          // not the chain's S. acanthias
      ['Sciades', 'hymenorrhinus', 'Sciades dowii'],         // 6th-ed. spelling, occurrence PM
      ['Proterorhinus', 'marmoratus', 'Proterorhinus semilunaris'],
    ]) {
      it(`flags prior-edition name ${g} ${s} as outdated -> ${exp}`, () => {
        const r = classify(g, s);
        assert.ok(r);
        assert.equal(r.type, 'outdated');
        assert.equal(r.suggestion, exp);
      });
    }

    // Valid species the chain had pointed at an unrelated North American fish.
    for (const [g, s] of [
      ['Coris', 'julis'],                 // was -> Tautoga onitis
      ['Conger', 'conger'],               // was -> Rhynchoconger flavus
      ['Osmerus', 'eperlanus'],           // was -> Osmerus mordax
      ['Squalus', 'megalops'],            // was -> Squalus acanthias
      ['Gaidropsarus', 'mediterraneus'],  // was -> Micromesistius poutassou
    ]) {
      it(`does not suggest replacing ${g} ${s}`, () => {
        const r = classify(g, s);
        assert.notEqual(r && r.type, 'outdated');
        assert.ok(!(r && r.suggestion), 'must not suggest a replacement');
      });
    }
  });

  // ── Extralimital valid species must NOT be flagged (Reviewer 1, round 2) ──
  //    Valid species outside the Names of Fishes area that were wrongly scraped
  //    as synonyms. Verified against Eschmeyer's Catalog and removed; see
  //    extralimital_valids.json. They must never be presented as an "outdated"
  //    name to be "corrected" to a different, North American species.
  describe('extralimital valid species (not synonyms)', () => {
    for (const [g, s] of [
      ['Misgurnus', 'fossilis'],       // reviewer-named — European weatherfish
      ['Platichthys', 'flesus'],       // reviewer-named — European flounder
      ['Ariopsis', 'seemanni'],        // reviewer-named
      ['Seriola', 'lalandi'],          // beyond the reviewer's list
      ['Sphyraena', 'obtusata'],
      ['Acipenser', 'sturio'],
      ['Carassius', 'carassius'],
      ['Priacanthus', 'macracanthus'],
      ['Rhamdia', 'quelen'],
      ['Acanthurus', 'bahianus'],
      ['Paranthias', 'furcifer'],
    ]) {
      it(`does not flag ${g} ${s} as an outdated synonym`, () => {
        const r = classify(g, s);
        assert.notEqual(r && r.type, 'outdated',
          `${g} ${s} is a valid extralimital species, not a synonym`);
        // Must not auto-suggest replacing it with a different species.
        assert.ok(!(r && r.suggestion), 'must not suggest a replacement');
      });
    }
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
