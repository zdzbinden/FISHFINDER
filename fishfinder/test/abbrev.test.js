/**
 * Abbreviated genus resolution — "P. olivaris" after "Pylodictis olivaris".
 *
 * Journals abbreviate the genus after first mention, so in a real manuscript
 * most mentions of a species are abbreviated ones. Before this pass they were
 * invisible to the engine: none of the other three regexes can match a genus
 * containing a period, so an abbreviated misspelling was never even a candidate.
 */
const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { engine, lookups } = require('./setup.js');

const abbrevHits = (text) =>
  engine.extractCandidates(text, lookups).filter(h => h.abbrev);
const classify = (g, s) => engine.classifyName(lookups, g, s);

describe('abbreviated genus — resolution', () => {
  it('resolves after a spelled-out mention', () => {
    const hits = abbrevHits('Pylodictis olivaris is common. Later P. olivaris was seen.');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].genus, 'Pylodictis');
    assert.equal(hits[0].species, 'olivaris');
    assert.equal(hits[0].abbrev, 'P.');
  });

  it('catches a misspelled epithet on an abbreviated mention', () => {
    // The whole point of the feature.
    const hits = abbrevHits('Pylodictis olivaris is common. Later P. olivarus was seen.');
    assert.equal(hits.length, 1);
    const r = classify(hits[0].genus, hits[0].species);
    assert.equal(r.type, 'misspelled');
    assert.equal(r.suggestion, 'Pylodictis olivaris');
  });

  it('resolves regardless of order — abbreviation before the spelled-out mention', () => {
    // Abstracts, tables and captions each re-spell at their own first mention,
    // and PDF extraction scrambles column order.
    const hits = abbrevHits('We caught P. olivaris. Pylodictis olivaris is a catfish.');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].genus, 'Pylodictis');
  });

  it('preserves the exact source text and index (the splice contract)', () => {
    // buildCorrectedText splices text.slice(0, index) + replacement +
    // text.slice(index + text.length). An off-by-one here corrupts manuscripts.
    const text = 'Pylodictis olivaris is common. Later P. olivarus was seen.';
    const hits = abbrevHits(text);
    assert.equal(hits[0].text, 'P. olivarus');
    assert.equal(hits[0].index, text.indexOf('P. olivarus'));
    assert.equal(text.slice(hits[0].index, hits[0].index + hits[0].text.length),
                 'P. olivarus');
  });

  it('accepts spacing variants', () => {
    for (const form of ['P. olivaris', 'P.olivaris', 'P . olivaris', 'P. olivaris']) {
      const hits = abbrevHits(`Pylodictis olivaris is common. Later ${form} was seen.`);
      assert.equal(hits.length, 1, `${JSON.stringify(form)} should resolve`);
      assert.equal(hits[0].genus, 'Pylodictis');
    }
  });

  it('handles hyphenated epithets, like HYPHEN_SP_RE does', () => {
    const hits = abbrevHits('Erimystax x-punctatus was seen. Then E. x-punctatus again.');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].species, 'x-punctatus');
  });

  it('does not resolve without a spelled-out genus in the text', () => {
    // The document-context guarantee: the genus is always something the author
    // actually wrote, so there is no new false-positive class.
    assert.equal(abbrevHits('P. olivaris was collected in the river.').length, 0);
  });

  it('does not resolve without lookups', () => {
    const text = 'Pylodictis olivaris is common. Later P. olivaris was seen.';
    const hits = engine.extractCandidates(text).filter(h => h.abbrev);
    assert.equal(hits.length, 0);
  });
});

describe('abbreviated genus — ambiguity', () => {
  it('an exact epithet match wins over another genus with the same initial', () => {
    const hits = abbrevHits(
      'Percina caprodes and Pylodictis olivaris co-occur. Then P. olivaris again.');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].genus, 'Pylodictis');
  });

  it('a valid name beats a synonym at equal distance', () => {
    // Salvelinus namaycush (valid) vs Salmo namaycush (synonym). Both match at
    // distance 0, so distance alone cannot break the tie.
    const hits = abbrevHits(
      'Salvelinus namaycush and Salmo trutta were stocked. Then S. namaycush again.');
    const namaycush = hits.filter(h => h.species === 'namaycush');
    assert.equal(namaycush.length, 1);
    assert.equal(namaycush[0].genus, 'Salvelinus');
  });

  it('resolves against a synonym genus, so outdated names still surface', () => {
    // Without synonym genera in the index this goes silent, and the
    // outdated-name check — the point of the tool — never fires on
    // abbreviated mentions.
    const hits = abbrevHits('Stizostedion vitreum was stocked. Then S. vitreum again.');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].genus, 'Stizostedion');
    const r = classify(hits[0].genus, hits[0].species);
    assert.equal(r.type, 'outdated');
    assert.equal(r.suggestion, 'Sander vitreus');
  });
});

describe('abbreviated genus — false-positive guards', () => {
  // Each case embeds a spelled-out genus sharing the initial, so the guard is
  // the only thing that can reject it.
  for (const [label, text] of [
    ['author initials after a period', 'Pylodictis olivaris was studied. U.S. based waters were sampled.'],
    ['a reference list',              'Pylodictis olivaris. Page, L. M., and Burr, B. M. 2011. Fishes.'],
    ['a degree',                      'Pylodictis olivaris was found. A Ph.D. student helped.'],
    ['a title',                       'Pylodictis olivaris was found. Dr. smith helped.'],
    ['a figure callout',              'Pylodictis olivaris was found. Fig. 3 shows the data.'],
    ['e.g.',                          'Pylodictis olivaris was found, e.g. some fish were large.'],
    ['an all-caps word',              'Pylodictis olivaris was found. DNA. results were clear.'],
  ]) {
    it(`ignores ${label}`, () => {
      assert.equal(abbrevHits(text).length, 0);
    });
  }

  it('ignores an epithet that is a hard-rejected abbreviation', () => {
    assert.equal(
      abbrevHits('Micropterus salmoides was found. Smith, M. and Jones sampled.').length, 0);
  });

  it('declines an epithet unlike anything the genus uses (the epithet gate)', () => {
    // Deliberate suppression. Accepting this would let the pass FABRICATE a
    // binomial: "C. catla" with Cyprinus in scope would become "Cyprinus catla"
    // when the author meant Catla.
    assert.equal(abbrevHits('Pylodictis olivaris was seen. Then P. xyzabc was seen.').length, 0);
  });

  it('does not pair across a line break', () => {
    assert.equal(abbrevHits('Pylodictis olivaris weighed 5 g.\n\nolivaris was common.').length, 0);
  });
});

describe('abbreviated genus — index', () => {
  it('is built lazily and cached on the lookups object', () => {
    const fresh = engine.buildLookups(lookups.db);
    assert.equal(fresh.generaEpithetIndex, null);
    engine.extractCandidates('Pylodictis olivaris and P. olivaris.', fresh);
    assert.ok(fresh.generaEpithetIndex instanceof Map);
    assert.ok(fresh.generaEpithetIndex.size > 1500,
      `expected >1500 genera indexed, got ${fresh.generaEpithetIndex.size}`);
  });

  it('indexes valid entries before synonyms, which the tie-break relies on', () => {
    const idx = engine.buildGeneraEpithetIndex(lookups);
    const list = idx.get('salvelinus');
    const firstSynonym = list.findIndex(e => !e.binomial);
    if (firstSynonym !== -1) {
      const lastValid = list.reduce((acc, e, i) => (e.binomial ? i : acc), -1);
      assert.ok(firstSynonym > lastValid,
        'all valid entries must precede all synonym entries');
    }
  });
});

describe('abbreviated genus — never reports a bare unknown', () => {
  it('flags an abbreviated unknown as low-confidence', () => {
    // The epithet gate should make an abbreviated UNKNOWN unreachable, so this
    // exercises isLowConfidence directly as the safety net it is.
    assert.equal(
      engine.isLowConfidence({ abbrev: 'P.' }, { type: 'unknown' }), true);
    assert.equal(
      engine.isLowConfidence({ abbrev: '' }, { type: 'unknown' }), false);
    assert.equal(
      engine.isLowConfidence({ abbrev: 'P.' }, { type: 'valid' }), false);
    assert.equal(engine.isLowConfidence(null, null), false);
  });
});
