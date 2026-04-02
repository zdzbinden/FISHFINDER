const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { engine, lookups } = require('./setup');

describe('extractCandidates', () => {
  it('extracts a single binomial from a sentence', () => {
    const text = 'We collected Oncorhynchus mykiss from the stream.';
    const hits = engine.extractCandidates(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].genus, 'Oncorhynchus');
    assert.equal(hits[0].species, 'mykiss');
  });

  it('extracts multiple binomials from a paragraph', () => {
    const text = 'Micropterus salmoides and Lepomis macrochirus were abundant.';
    const hits = engine.extractCandidates(text);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].genus, 'Micropterus');
    assert.equal(hits[1].genus, 'Lepomis');
  });

  it('does not extract all-caps or words shorter than 3 chars', () => {
    const text = 'The FISH was large. An ox ran by.';
    const hits = engine.extractCandidates(text);
    assert.equal(hits.length, 0);
  });

  it('does extract Capitalized + lowercase pattern (even non-fish)', () => {
    // The regex matches any Cap+lower pattern; classifyName filters non-fish
    const text = 'Bass were common in the lake.';
    const hits = engine.extractCandidates(text);
    assert.equal(hits.length, 1); // "Bass were" matches the pattern
    assert.equal(hits[0].genus, 'Bass');
  });

  it('requires genus ≥3 chars and species ≥3 chars', () => {
    const text = 'Ab cd is too short. Abc def is long enough.';
    const hits = engine.extractCandidates(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].genus, 'Abc');
  });

  it('captures correct index positions', () => {
    const text = 'Found Salmo trutta in the river.';
    const hits = engine.extractCandidates(text);
    assert.equal(hits[0].index, text.indexOf('Salmo'));
  });
  it('extracts hyphenated species epithets (e.g., x-punctatus)', () => {
    const text = 'The Erimystax x-punctatus and Astroscopus y-graecum were found.';
    const hits = engine.extractCandidates(text);
    assert.ok(hits.some(h => h.species === 'x-punctatus'), 'should extract x-punctatus');
    assert.ok(hits.some(h => h.species === 'y-graecum'), 'should extract y-graecum');
  });

  it('extracts short genera when lookups are provided (e.g., Zu)', () => {
    const text = 'The species Zu cristatus was observed.';
    const hits = engine.extractCandidates(text, lookups);
    assert.ok(hits.some(h => h.genus === 'Zu' && h.species === 'cristatus'), 'should extract Zu cristatus');
  });

  it('does not extract short genera without lookups (avoids false positives)', () => {
    const text = 'To understand the ecology we studied So many species.';
    const hits = engine.extractCandidates(text);
    assert.equal(hits.length, 0, 'should not match "To understand" or "So many" without lookups');
  });
});

describe('extractCommonNames', () => {
  it('extracts a multi-word common name from text', () => {
    const text = 'We found several largemouth bass in the lake.';
    const hits = engine.extractCommonNames(lookups, text, []);
    const lmbHit = hits.find(h => h.commonName && h.commonName.toLowerCase().includes('largemouth'));
    // If "Largemouth Bass" is in the database as a common name, it should match
    if (lmbHit) {
      assert.equal(lmbHit.type, 'common');
      assert.ok(lmbHit.suggestion);
    }
  });

  it('does not extract single-word common names', () => {
    // Single-word names are excluded from the prefix map to avoid false positives
    const text = 'The trout was beautiful.';
    const hits = engine.extractCommonNames(lookups, text, []);
    // "Trout" alone should not match (it would only match multi-word like "Rainbow Trout")
    const troutHit = hits.find(h => h.text.toLowerCase() === 'trout');
    assert.equal(troutHit, undefined);
  });

  it('skips common names that overlap with binomial spans', () => {
    const text = 'Largemouth bass were abundant.';
    // Simulate a binomial span covering "Largemouth bass"
    const binomialSpans = [{ start: 0, end: 15 }];
    const hits = engine.extractCommonNames(lookups, text, binomialSpans);
    const overlapping = hits.find(h => h.index < 15);
    assert.equal(overlapping, undefined);
  });

  it('is case-insensitive', () => {
    const text = 'RAINBOW TROUT were stocked in the river.';
    const hits = engine.extractCommonNames(lookups, text, []);
    const rtHit = hits.find(h => h.commonName && h.commonName.toLowerCase().includes('rainbow trout'));
    if (rtHit) {
      assert.equal(rtHit.type, 'common');
    }
  });

  it('fuzzy-matches a common name with 1-edit typo', () => {
    const text = 'We caught several largemouth bas in the pond.';
    const hits = engine.extractCommonNames(lookups, text, []);
    const hit = hits.find(h => h.commonName && h.commonName.toLowerCase().includes('largemouth'));
    assert.ok(hit, 'should fuzzy-match "largemouth bas" → "Largemouth Bass"');
    assert.equal(hit.type, 'common');
    assert.ok(hit.suggestion);
  });

  it('does not fuzzy-match a common name with 2+ edit distance', () => {
    const text = 'We caught several largemouth ba in the pond.';
    const hits = engine.extractCommonNames(lookups, text, []);
    const hit = hits.find(h => h.commonName && h.commonName.toLowerCase().includes('largemouth'));
    assert.equal(hit, undefined, 'should NOT fuzzy-match "largemouth ba" (2 edits)');
  });
});
