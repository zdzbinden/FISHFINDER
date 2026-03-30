/**
 * FISHFINDER — engine.js
 * Pure classification logic, shared between browser (global) and Node.js (require).
 * No DOM dependencies. No side effects on load.
 */
(function (exports) {
  'use strict';

  // ── Levenshtein distance (Wagner-Fischer, with early-exit) ────────────────
  function levenshtein(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
    const m = a.length, n = b.length;
    let prev = new Uint16Array(n + 1);
    let curr = new Uint16Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > maxDist) return maxDist + 1; // prune
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  // ── Find closest entry in a genus/species list ────────────────────────────
  // Shared fuzzy-search used by both valid-name and synonym lookups.
  function findClosestInList(list, genus, species, maxDist) {
    const lg = genus.toLowerCase();
    const ls = species.toLowerCase();
    let bestDist  = maxDist + 1;
    let bestEntry = null;
    let bestGd    = 0;

    for (const entry of list) {
      // First-letter filter: relaxed for long genera (≥8 chars) to catch adjacent-key typos
      if (entry.lGenus[0] !== lg[0]) {
        if (lg.length < 8 || Math.abs(entry.lGenus.charCodeAt(0) - lg.charCodeAt(0)) > 2) continue;
      }
      if (Math.abs(entry.lGenus.length - lg.length) > maxDist) continue;

      const gd = levenshtein(lg, entry.lGenus, maxDist);
      if (gd > maxDist) continue;

      if (entry.lSpecies[0] !== ls[0] &&
          Math.abs(entry.lSpecies.charCodeAt(0) - ls.charCodeAt(0)) > 2) continue;

      const sd = levenshtein(ls, entry.lSpecies, maxDist);
      const total = gd + sd;

      if (total < bestDist) {
        bestDist = total;
        bestEntry = entry;
        bestGd = gd;
        if (total === 0) break;
      }
    }
    return bestEntry ? { entry: bestEntry, dist: bestDist, genusDist: bestGd } : null;
  }

  function findClosestMatch(lookups, genus, species, maxDist) {
    const result = findClosestInList(lookups.validList, genus, species, maxDist);
    return result ? { name: result.entry.binomial, dist: result.dist } : null;
  }

  function findClosestSynonym(lookups, genus, species, maxDist) {
    const result = findClosestInList(lookups.synonymList, genus, species, maxDist);
    return result ? { oldName: result.entry.oldName, newName: result.entry.newName, dist: result.dist, genusDist: result.genusDist } : null;
  }

  // Species abbreviations that should never be treated as epithets
  const SPECIES_ABBREVS = new Set([
    'sp', 'spp', 'cf', 'aff', 'nr', 'var', 'subsp',
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
    'can', 'has', 'her', 'was', 'one', 'our', 'out', 'its',
    'with', 'that', 'have', 'from', 'this', 'will', 'been',
    'than', 'them', 'into', 'also', 'each', 'which', 'their',
    'were', 'other', 'about', 'these', 'would', 'there',
    'after', 'between', 'found', 'used', 'where', 'most',
    'using', 'during', 'including', 'however',
  ]);

  // ── Classify a candidate binomial ──────────────────────────────────────────
  // Returns null if the name doesn't look like a fish name at all.
  function classifyName(lookups, genus, species) {
    if (species.length < 3 || SPECIES_ABBREVS.has(species.toLowerCase())) return null;

    const binomial = `${genus} ${species}`;
    const lower    = binomial.toLowerCase();

    // 1. Exact valid match
    if (lookups.validSet.has(lower)) {
      const canonical  = lookups.validMap.get(lower);
      const info       = lookups.db.valid_names[canonical];
      const commonName = info ? (info.common_name_en || '') : '';
      const changed    = info && info.flags && info.flags.includes('*');
      return { type: changed ? 'changed' : 'valid', canonical, suggestion: null, commonName };
    }

    // 2. Known synonym / outdated name
    if (lookups.synonymMap.has(lower)) {
      return { type: 'outdated', canonical: binomial, suggestion: lookups.synonymMap.get(lower) };
    }

    // 2b. Fuzzy synonym match (catches misspelled synonyms like Leucisus → Leuciscus)
    //     Require exact genus to prevent false positives across congeners
    //     (e.g., Platichthys flesus should NOT fuzzy-match Platichthys stellatus)
    const closestSyn = findClosestSynonym(lookups, genus, species, 2);
    if (closestSyn && closestSyn.genusDist === 0 && closestSyn.dist > 0 && closestSyn.dist <= 2) {
      return { type: 'outdated', canonical: binomial, suggestion: closestSyn.newName };
    }

    // 3. Common name match
    const commonMatch = lookups.commonNameMap.get(lower);
    if (commonMatch) {
      return {
        type: 'common', canonical: binomial,
        suggestion: commonMatch.binomial, commonName: commonMatch.commonName,
      };
    }

    // 4. Exact genus → fuzzy species match or unknown species
    if (lookups.generaSet.has(genus.toLowerCase())) {
      const closest = findClosestMatch(lookups, genus, species, 2);
      if (closest && closest.dist <= 2) {
        return { type: 'misspelled', canonical: binomial, suggestion: closest.name };
      }
      return { type: 'unknown', canonical: binomial, suggestion: null };
    }

    // 5. Fuzzy full binomial (catches misspelled genera like Micropteris → Micropterus)
    const closest = findClosestMatch(lookups, genus, species, 2);
    if (closest && closest.dist <= 2) {
      return { type: 'misspelled', canonical: binomial, suggestion: closest.name };
    }

    // 6. Not a fish name
    return null;
  }

  // ── Extract candidate names from text ─────────────────────────────────────
  const CANDIDATE_RE = /\b([A-Z][a-z]{2,})\s+([a-z]{3,})\b/g;

  function extractCandidates(text) {
    const hits = [];
    let m;
    CANDIDATE_RE.lastIndex = 0;
    while ((m = CANDIDATE_RE.exec(text)) !== null) {
      hits.push({
        genus:   m[1],
        species: m[2],
        text:    m[0],
        index:   m.index,
      });
    }
    return hits;
  }

  // ── Extract common-name matches from text ──────────────────────────────────
  function buildCommonNamePrefixMap(commonNameMap) {
    const prefixMap = new Map();
    for (const [lowerName, info] of commonNameMap) {
      const words = lowerName.split(/\s+/);
      if (words.length < 2) continue;
      const first = words[0];
      if (!prefixMap.has(first)) prefixMap.set(first, []);
      prefixMap.get(first).push({ lower: lowerName, info, wordCount: words.length });
    }
    return prefixMap;
  }

  function extractCommonNames(lookups, text, binomialSpans) {
    if (!lookups.commonNamePrefixMap) {
      lookups.commonNamePrefixMap = buildCommonNamePrefixMap(lookups.commonNameMap);
    }
    const hits = [];
    const WORD_RE = /[a-zA-Z][-a-zA-Z]*/g;
    const lowerText = text.toLowerCase();
    let wm;
    WORD_RE.lastIndex = 0;
    while ((wm = WORD_RE.exec(text)) !== null) {
      const firstWord = wm[0].toLowerCase();
      const candidates = lookups.commonNamePrefixMap.get(firstWord);
      if (!candidates) continue;

      for (const cand of candidates) {
        const end = wm.index + cand.lower.length;
        let matched = false;
        let matchEnd = end;

        // Exact match
        if (end <= text.length) {
          const slice = lowerText.slice(wm.index, end);
          if (slice === cand.lower &&
              (end >= text.length || !/[a-zA-Z-]/.test(text[end]))) {
            matched = true;
          }
        }

        // Fuzzy fallback (Levenshtein ≤ 1) — try ±1 char window around expected length
        if (!matched && cand.lower.length >= 6) {
          for (let delta = -1; delta <= 1; delta++) {
            const tryEnd = end + delta;
            if (tryEnd <= wm.index || tryEnd > text.length) continue;
            // Must end at a word boundary
            if (tryEnd < text.length && /[a-zA-Z-]/.test(text[tryEnd])) continue;
            const slice = lowerText.slice(wm.index, tryEnd);
            if (levenshtein(slice, cand.lower, 1) <= 1) {
              matched = true;
              matchEnd = tryEnd;
              break;
            }
          }
        }

        if (!matched) continue;
        const overlaps = binomialSpans.some(
          s => wm.index < s.end && matchEnd > s.start
        );
        if (overlaps) continue;
        hits.push({
          text:       text.slice(wm.index, matchEnd),
          binomial:   text.slice(wm.index, matchEnd),
          index:      wm.index,
          type:       'common',
          suggestion: cand.info.binomial,
          commonName: cand.info.commonName,
        });
      }
    }
    return hits;
  }

  // ── Build lookup structures from raw JSON ──────────────────────────────────
  function buildLookups(db) {
    const validSet    = new Set();
    const validMap    = new Map();
    const synonymMap  = new Map();
    const generaSet   = new Set();
    const commonNameMap = new Map();
    const validList   = [];
    const synonymList = [];

    for (const [canonical, info] of Object.entries(db.valid_names)) {
      const lower = canonical.toLowerCase();
      validSet.add(lower);
      validMap.set(lower, canonical);

      const parts = canonical.split(' ');
      const sp = parts.slice(1).join(' ');
      validList.push({
        genus:    parts[0],
        species:  sp,
        binomial: canonical,
        lGenus:   parts[0].toLowerCase(),
        lSpecies: sp.toLowerCase(),
      });

      const cn = info.common_name_en;
      if (cn) commonNameMap.set(cn.toLowerCase(), { binomial: canonical, commonName: cn });
    }

    for (const [oldName, newName] of Object.entries(db.synonyms)) {
      synonymMap.set(oldName.toLowerCase(), newName);
      const parts = oldName.split(' ');
      if (parts.length >= 2) {
        synonymList.push({
          lGenus:   parts[0].toLowerCase(),
          lSpecies: parts.slice(1).join(' ').toLowerCase(),
          oldName,
          newName,
        });
      }
    }

    for (const genus of db.genera) {
      generaSet.add(genus.toLowerCase());
    }

    return {
      db, validSet, validMap, synonymMap, generaSet,
      commonNameMap, validList, synonymList,
      commonNamePrefixMap: null,  // built lazily
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  exports.levenshtein          = levenshtein;
  exports.findClosestMatch     = findClosestMatch;
  exports.findClosestSynonym   = findClosestSynonym;
  exports.classifyName         = classifyName;
  exports.extractCandidates    = extractCandidates;
  exports.extractCommonNames   = extractCommonNames;
  exports.buildCommonNamePrefixMap = buildCommonNamePrefixMap;
  exports.buildLookups         = buildLookups;
  exports.SPECIES_ABBREVS      = SPECIES_ABBREVS;
  exports.CANDIDATE_RE         = CANDIDATE_RE;

})(typeof module !== 'undefined' && module.exports ? module.exports
   : (this.FishEngine = this.FishEngine || {}));
