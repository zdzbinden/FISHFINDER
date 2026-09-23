/**
 * Prose false positives, and the ae- / e- epithet class.
 *
 * A genus followed by an ordinary word reads as a binomial to the regex:
 * "Ranzania includes", "Bagre mainly". Reported from a paleontology manuscript
 * (GitHub, 2026-09-22). The decision was DEMOTE, not suppress — suppression
 * would cause false negatives, because 199 real epithets are also ordinary
 * English words (Hypanus say, Haemulon album, Etheostoma obama).
 */
const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { engine, lookups } = require('./setup.js');

const classify = (g, s) => engine.classifyName(lookups, g, s);

describe('prose epithets are demoted', () => {
  // The five names the reporter actually submitted.
  for (const [genus, word] of [
    ['Ranzania',     'includes'],
    ['Lopholatilus', 'range'],
    ['Prionotus',    'species'],
    ['Opsanus',      'occur'],
    ['Bagre',        'mainly'],
  ]) {
    it(`${genus} ${word}`, () => {
      const r = classify(genus, word);
      assert.ok(r, 'should still be reported, not suppressed');
      assert.equal(r.lowConfidence, true);
    });
  }

  it('demotes in the outdated tier too, where a bad suggestion is worse', () => {
    // "Auxis may -> did you mean Auxis rochei?" is the worst form of this bug:
    // a confident correction attached to a verb. Fixing only the unknown tier
    // would leave it.
    const r = classify('Auxis', 'may');
    assert.ok(r);
    assert.equal(r.type, 'outdated');
    assert.equal(r.lowConfidence, true);
  });

  it('demotes in the misspelled tier too', () => {
    let found = null;
    for (const word of ['species', 'population', 'analysis', 'samples', 'values']) {
      for (const genus of ['Micropterus', 'Coregonus', 'Cyclothone', 'Etheostoma']) {
        const r = classify(genus, word);
        if (r && r.type === 'misspelled') { found = r; break; }
      }
      if (found) break;
    }
    if (found) assert.equal(found.lowConfidence, true);
  });
});

describe('real epithets that are ordinary English words are never demoted', () => {
  // The load-bearing half of the rule: isProseEpithet subtracts the live
  // database, so the stoplist can never demote a name the database uses.
  for (const binomial of ['Hypanus say', 'Haemulon album', 'Sphyrna media',
                          'Etheostoma obama']) {
    it(binomial, () => {
      const [g, s] = binomial.split(' ');
      const r = classify(g, s);
      assert.ok(r, `${binomial} should be recognized`);
      assert.ok(r.type === 'valid' || r.type === 'changed',
        `${binomial} should be valid/changed, got ${r.type}`);
      assert.ok(!r.lowConfidence, `${binomial} must not be demoted`);
    });
  }

  it('every database epithet is exempt from the stoplist', () => {
    const collisions = [...engine.PROSE_WORDS].filter(w => lookups.epithetSet.has(w));
    for (const w of collisions) {
      assert.equal(engine.isProseEpithet(lookups, w), false,
        `"${w}" is a real epithet and must not be treated as prose`);
    }
  });

  it('the stoplist and the hard-reject list stay separate', () => {
    // SPECIES_ABBREVS rejects before classification; PROSE_WORDS only demotes.
    // Merging them would turn demotions into false negatives.
    assert.ok(engine.PROSE_WORDS.size > 300,
      `expected a substantial stoplist, got ${engine.PROSE_WORDS.size}`);
    assert.ok(!engine.PROSE_WORDS.has('sp'));
    assert.ok(engine.SPECIES_ABBREVS.has('sp'));
  });
});

describe('classical ae- / e- epithet variants', () => {
  // All 14 ae- epithets in the database had an unreachable e- variant: 'a' and
  // 'e' are 4 charCodes apart, over the species first-letter filter's limit
  // of 2. This is how Apterichtus equatorialis classified as UNKNOWN.
  const aeNames = lookups.validList.filter(e => e.lSpecies.startsWith('ae'));

  it('the database still has ae- epithets to test', () => {
    assert.ok(aeNames.length >= 14, `expected >=14, got ${aeNames.length}`);
  });

  for (const entry of aeNames) {
    const variant = entry.lSpecies.slice(1);   // aestivalis -> estivalis
    it(`${entry.genus} ${variant} -> ${entry.binomial}`, () => {
      const r = classify(entry.genus, variant);
      assert.ok(r, `${entry.genus} ${variant} should be recognized`);
      assert.equal(r.type, 'misspelled');
      assert.equal(r.suggestion, entry.binomial);
    });
  }

  // The cost side. These within-genus pairs sit within edit distance 2 and are
  // blocked only by the first-letter filter, which is why the exemption is
  // narrow rather than a wider charCode threshold: relaxing the threshold to 4
  // would make each of these mutually confusable.
  for (const [genus, species] of [
    ['Coregonus',   'hoyi'],       ['Coregonus',   'kiyi'],
    ['Percina',     'maculata'],   ['Percina',     'bimaculata'],
    ['Sebastes',    'ciliatus'],   ['Sebastes',    'miniatus'],
    ['Careproctus', 'canus'],      ['Careproctus', 'faunus'],
  ]) {
    it(`${genus} ${species} still resolves to itself`, () => {
      const r = classify(genus, species);
      assert.ok(r);
      assert.ok(r.type === 'valid' || r.type === 'changed',
        `${genus} ${species} should stay valid/changed, got ${r.type}`);
    });
  }
});
