const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { engine } = require('./setup');

const lev = engine.levenshtein;

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(lev('abc', 'abc', 3), 0);
  });

  it('returns 1 for single substitution', () => {
    assert.equal(lev('abc', 'aXc', 3), 1);
  });

  it('returns 1 for single insertion', () => {
    assert.equal(lev('abc', 'abXc', 3), 1);
  });

  it('returns 1 for single deletion', () => {
    assert.equal(lev('abcd', 'abd', 3), 1);
  });

  it('returns 2 for two edits', () => {
    assert.equal(lev('kitten', 'kotten', 2), 1); // i→o
    assert.equal(lev('kitten', 'kotXen', 3), 2); // i→o, t→X
  });

  it('early-exits when length difference exceeds maxDist', () => {
    assert.equal(lev('a', 'abcdef', 2), 3); // > maxDist
  });

  it('prunes when row minimum exceeds maxDist', () => {
    assert.equal(lev('abcde', 'vwxyz', 2), 3); // all different
  });

  it('handles empty strings', () => {
    assert.equal(lev('', '', 0), 0);
    assert.equal(lev('abc', '', 5), 3);
    assert.equal(lev('', 'abc', 5), 3);
  });

  it('works with real taxonomic names', () => {
    // salmoides vs salmodes (missing 'i')
    assert.equal(lev('salmoides', 'salmodes', 2), 1);
    // Micropterus vs Micropteris
    assert.equal(lev('micropterus', 'micropteris', 2), 1);
  });

  it('counts adjacent transposition as 1 edit (Damerau-Levenshtein)', () => {
    // Simple transposition
    assert.equal(lev('ab', 'ba', 2), 1);
    assert.equal(lev('abc', 'bac', 2), 1);
    assert.equal(lev('abc', 'acb', 2), 1);
  });

  it('handles transpositions in real taxonomic names', () => {
    // Cyrpinus → Cyprinus (r,p transposed)
    assert.equal(lev('cyrpinus', 'cyprinus', 2), 1);
    // salmoides → salmiodes (o,i transposed)
    assert.equal(lev('salmoides', 'salmiodes', 2), 1);
    // oncorhynchus → oncorhyncuhs (u,h transposed)
    assert.equal(lev('oncorhynchus', 'oncorhyncuhs', 2), 1);
  });

  it('still counts non-adjacent swaps as 2 edits', () => {
    // 'abc' → 'cba' is NOT a single transposition
    assert.equal(lev('abc', 'cba', 3), 2);
  });
});
