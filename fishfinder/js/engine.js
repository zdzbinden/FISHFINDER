/**
 * FISHFINDER — engine.js
 * Pure classification logic, shared between browser (global) and Node.js (require).
 * No DOM dependencies. No side effects on load.
 */
(function (exports) {
  'use strict';

  // ── Damerau-Levenshtein distance (Optimal String Alignment, with early-exit)
  // Handles transpositions (ab→ba) as a single edit, which standard Levenshtein
  // counts as 2. Important for common taxonomic typos like "Cyrpinus" → "Cyprinus".
  function levenshtein(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
    const m = a.length, n = b.length;
    let prevprev = new Uint16Array(n + 1);
    let prev = new Uint16Array(n + 1);
    let curr = new Uint16Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        // Transposition: adjacent characters swapped
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          curr[j] = Math.min(curr[j], prevprev[j - 2] + 1);
        }
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > maxDist) return maxDist + 1; // prune
      [prevprev, prev, curr] = [prev, curr, prevprev];
    }
    return prev[n];
  }

  // ── Classical ae- / e- epithet variants ───────────────────────────────────
  // "aestivalis" and "estivalis", "aeglefinus" and "eglefinus" are both current
  // in the literature, but the species first-letter filter below rejects the
  // pair outright: 'a' and 'e' are 4 charCodes apart, over its limit of 2. All
  // 14 ae- epithets in the database have an unreachable e- variant, which is how
  // Apterichtus equatorialis came to classify as UNKNOWN (found 2026-09-21).
  //
  // This exemption is deliberately narrow rather than a wider charCode
  // threshold. Measured: 16 within-genus epithet pairs (8 unique) sit within
  // edit distance 2 but are blocked by the first-letter filter — c/n, h/k, i/o,
  // l/r, c/m, c/f, c/s, b/m. Not one is an a/e pair, so this rule recovers all
  // 14 names at zero measured false-positive cost, while relaxing the threshold
  // to 4 would make Coregonus hoyi/kiyi and Percina maculata/bimaculata
  // mutually confusable.
  function aeVariant(a, b) {
    return (a.startsWith('ae') && b[0] === 'e') ||
           (b.startsWith('ae') && a[0] === 'e');
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
          Math.abs(entry.lSpecies.charCodeAt(0) - ls.charCodeAt(0)) > 2 &&
          !aeVariant(entry.lSpecies, ls)) continue;

      const sd = levenshtein(ls, entry.lSpecies, maxDist - gd);
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

  // ── Ordinary English words in the epithet slot ─────────────────────────────
  // A genus name followed by an ordinary word reads as a binomial to the regex:
  // "Ranzania includes", "Lopholatilus range", "Bagre mainly". Reported from a
  // paleontology manuscript (GitHub, 2026-09-22), where prose mentions a genus
  // without a species far more often than fisheries papers do.
  //
  // This is a DEMOTE list, deliberately separate from SPECIES_ABBREVS above,
  // which is a hard REJECT applied before classification and is mirrored in
  // addenda_overlay.py. Do not merge them and do not let that mirror drift:
  // suppressing these outright would cause false negatives, because 199 real
  // epithets are also ordinary English words (Hypanus say, Haemulon album,
  // Etheostoma obama). isProseEpithet() subtracts the live database, so a word
  // here can never demote a name the database actually uses.
  //
  // Curated rather than a top-5k frequency list (~17 KB gzipped for a problem
  // this narrow). Corpus-checked against 95 fisheries papers: only 24 distinct
  // prose words ever followed a real genus there, and all 24 are included. The
  // rest of that corpus's non-epithet words were extralimital species and
  // PDF-extraction damage ("afnis" for affinis) — neither belongs on this list.
  const PROSE_WORDS = new Set((
    // Short words. SPECIES_ABBREVS already hard-rejects many three-letter
    // words, but not these, and "Auxis may -> did you mean Auxis rochei?" is
    // the worst form of this bug: a confident suggestion attached to a verb.
    'may did few new old two six ten per via due yet saw see get got put ' +
    'low top end add set run eat non sub pre let far big own via off ' +
    // verbs
    'includes include included occurs occur occurred occurring ranges ranged ' +
    'showed shows show shown appears appear appeared exhibits exhibit exhibited ' +
    'represents represent represented remains remain remained seems seem seemed ' +
    'tends tend tended lives live lived feeds feed spawns spawn spawned grows ' +
    'grow grew migrates migrate migrated inhabits inhabit inhabited reaches ' +
    'reach reached attains attain attained consists consist comprises comprise ' +
    'belongs belong differs differ differed varies vary varied displays ' +
    'display displayed provides provide required requires require reported ' +
    'reports recorded records observed observes collected collects sampled ' +
    'samples measured measures captured captures caught studied studies ' +
    'analyzed analysed examined examines identified identifies described ' +
    'describes named listed lists noted notes finds considered considers ' +
    'suggested suggests indicated indicates confirmed confirms compared ' +
    'compares uses known given gives taken takes makes became becomes ' +
    'possess possesses possessed lacks lack lacked shares share shared ' +
    // auxiliaries and modals
    'being having will would could might must shall does doing done ' +
    // nouns
    'species specimens specimen samples sample populations population ' +
    'individuals individual juveniles juvenile adults adult larvae larva eggs ' +
    'fry stocks stock fisheries fishery catches catch data results result ' +
    'values value numbers number groups group types type taxa genus genera ' +
    'family families order orders class classes distribution distributions ' +
    'abundance density densities biomass growth length lengths weight weights ' +
    'size sizes ages diet diets habitat habitats range area areas region ' +
    'regions site sites season seasons year years month months days time ' +
    'times rate rates level levels percent percentage fish fishes water ' +
    'waters river rivers lake lakes stream streams reservoir reservoirs ' +
    'ocean coast estuary basin drainage watershed depth depths temperature ' +
    'temperatures salinity oxygen study surveys survey analysis analyses ' +
    'method methods table figure figures appendix section sections page ' +
    'pages reference references literature report paper papers article ' +
    'articles journal volume issue museum collection collections university ' +
    'department institute laboratory complexes crossovers progenitors ' +
    'linkage coral demographic ' +
    // adverbs, adjectives, connectives
    'mainly primarily largely mostly generally typically commonly rarely ' +
    'often usually frequently occasionally probably likely apparently ' +
    'relatively significantly furthermore additionally moreover therefore ' +
    'although because since while whereas whether within without across ' +
    'along among around above below before throughout over under near ' +
    'less many much several both either neither every some least greater ' +
    'lower higher smaller larger longer shorter older younger similar ' +
    'different another various numerous abundant endemic native introduced ' +
    'invasive exotic marine freshwater brackish coastal benthic pelagic ' +
    'demersal anadromous mature immature large annual seasonal spatial ' +
    'temporal potential possible important significant present absent ' +
    'previous current recent first second third final initial overall ' +
    'respectively approximately'
  ).split(' '));

  // True when an epithet is an ordinary English word that the database never
  // uses as an epithet. The second clause is load-bearing — without it this
  // would demote Hypanus say and Haemulon album — and because it reads the live
  // lookups, the rule self-corrects whenever the database changes.
  function isProseEpithet(lookups, species) {
    const ls = species.toLowerCase();
    return PROSE_WORDS.has(ls) &&
           !(lookups.epithetSet && lookups.epithetSet.has(ls));
  }

  // ── Classify a candidate binomial ──────────────────────────────────────────
  // Returns null if the name doesn't look like a fish name at all.
  function classifyName(lookups, genus, species) {
    if (species.length < 3 || SPECIES_ABBREVS.has(species.toLowerCase())) return null;

    const binomial = `${genus} ${species}`;
    const lower    = binomial.toLowerCase();

    // Demote, never suppress. Only the inexact tiers can be prose — a valid,
    // changed or exact-synonym hit has an epithet the database uses, so
    // isProseEpithet is false there by construction.
    const prose = isProseEpithet(lookups, species);

    // 1. Exact valid match
    if (lookups.validSet.has(lower)) {
      const canonical  = lookups.validMap.get(lower);
      const info       = lookups.db.valid_names[canonical];
      const commonName = info ? (info.common_name_en || '') : '';
      const changed    = info && info.flags && info.flags.includes('*');
      // Names whose authority is a published addendum rather than the printed
      // 8th edition. Kept as valid/changed (no new tier) — the marker is a
      // provenance note, not a different classification.
      const addenda    = (info && info.addenda) || null;
      return { type: changed ? 'changed' : 'valid', canonical, suggestion: null, commonName,
               addenda, confidence: 1.0, editDistance: 0 };
    }

    // 2. Known synonym / outdated name
    if (lookups.synonymMap.has(lower)) {
      return { type: 'outdated', canonical: binomial, suggestion: lookups.synonymMap.get(lower),
               confidence: 0.95, editDistance: 0 };
    }

    // 2b. Fuzzy synonym match (catches misspelled synonyms like Leucisus → Leuciscus)
    //     Require exact genus to prevent false positives across congeners
    //     (e.g., Platichthys flesus should NOT fuzzy-match Platichthys stellatus)
    const closestSyn = findClosestSynonym(lookups, genus, species, 2);
    if (closestSyn && closestSyn.genusDist === 0 && closestSyn.dist > 0 && closestSyn.dist <= 2) {
      return { type: 'outdated', canonical: binomial, suggestion: closestSyn.newName,
               lowConfidence: prose,
               confidence: closestSyn.dist === 1 ? 0.80 : 0.60, editDistance: closestSyn.dist };
    }

    // 2c. Withdrawn from the List by a published addendum.
    //     Must precede step 4: the genus usually survives the removal, so step 4
    //     would otherwise return a bare "unknown" with no explanation.
    if (lookups.removedMap.has(lower)) {
      const rec = lookups.removedMap.get(lower);
      return { type: 'unknown', canonical: binomial, suggestion: null,
               removed: true, note: rec.reason || '',
               confidence: 0.30, editDistance: null };
    }

    // 3. Common name match
    const commonMatch = lookups.commonNameMap.get(lower);
    if (commonMatch) {
      return {
        type: 'common', canonical: binomial,
        suggestion: commonMatch.binomial, commonName: commonMatch.commonName,
        confidence: 1.0, editDistance: 0,
      };
    }

    // 4. Exact genus → fuzzy species match or unknown species
    if (lookups.generaSet.has(genus.toLowerCase())) {
      const closest = findClosestMatch(lookups, genus, species, 2);
      if (closest && closest.dist <= 2) {
        return { type: 'misspelled', canonical: binomial, suggestion: closest.name,
                 lowConfidence: prose,
                 confidence: closest.dist === 1 ? 0.70 : 0.50, editDistance: closest.dist };
      }
      return { type: 'unknown', canonical: binomial, suggestion: null,
               lowConfidence: prose,
               confidence: 0.30, editDistance: null };
    }

    // 5. Fuzzy full binomial (catches misspelled genera like Micropteris → Micropterus)
    const closest = findClosestMatch(lookups, genus, species, 2);
    if (closest && closest.dist <= 2) {
      return { type: 'misspelled', canonical: binomial, suggestion: closest.name,
               lowConfidence: prose,
               confidence: closest.dist === 1 ? 0.60 : 0.40, editDistance: closest.dist };
    }

    // 6. Not a fish name
    return null;
  }

  // ── Extract candidate names from text ─────────────────────────────────────
  const CANDIDATE_RE = /\b([A-Z][a-z]{2,})\s+([a-z]{3,})\b/g;
  const HYPHEN_SP_RE = /\b([A-Z][a-z]{2,})\s+([a-z]-[a-z]{2,})\b/g;
  const SHORT_GENUS_RE = /\b([A-Z][a-z])\s+([a-z]{3,})\b/g;

  // "P. olivaris" — the genus abbreviated after its first spelled-out mention,
  // which is how journals write every mention after the first. Group 1 is a
  // GUARD, not part of the name, and it is captured and skipped rather than
  // written as the obvious lookbehind `(?<![A-Za-z.])` on purpose: lookbehind is
  // a parse-time SyntaxError in Safari before 16.4, which would take this whole
  // file down at load rather than merely disabling this feature.
  //
  // A letter or a period before the initial means author initials, never a
  // genus: "R.H. did", "U.S. state", "Ph.D. student". That guard removed 61 of
  // 1,489 raw matches across the 95-paper corpus and every one was an initial.
  //
  // Deliberate non-goals, so nobody "fixes" them later: no line break between
  // the abbreviation and the epithet (`[ \t ]*`, not `\s*`), so nothing
  // pairs across paragraphs or sentence ends; and abbreviated trinomials
  // ("P. o. olivaris") do not match, since "o." is not `[a-z]{3,}`.
  const ABBREV_GENUS_RE =
    /(^|[^A-Za-z.])([A-Z])[  ]?\.[ \t ]*((?:[a-z]-)?[a-z]{3,})(?![a-zA-Z-])/g;

  // ── Genus → entries index, for resolving abbreviations ────────────────────
  function buildGeneraEpithetIndex(lookups) {
    const idx = new Map();
    const add = (entry) => {
      let list = idx.get(entry.lGenus);
      if (!list) { list = []; idx.set(entry.lGenus, list); }
      list.push(entry);
    };
    // Valid entries go in FIRST and the ordering is load-bearing:
    // findClosestInList keeps only a strictly-better match, so at equal distance
    // a valid name outranks a synonym. That is what makes "S. namaycush" resolve
    // to Salvelinus rather than Salmo when both are spelled out in the text.
    lookups.validList.forEach(add);
    // Synonym genera belong here too, or "S. vitreum" never resolves to
    // Stizostedion and the outdated-name check — the whole point of the tool —
    // goes silent on every abbreviated mention.
    lookups.synonymList.forEach(add);
    return idx;
  }

  // Pick which spelled-out genus an abbreviation refers to, or null to decline.
  // `context` maps lowercase genus → { genus, indices } for genera spelled out
  // somewhere in this text; `at` is the offset of the abbreviation.
  function resolveAbbreviatedGenus(idx, context, initial, species, at) {
    const scored = [];
    for (const [lg, ctx] of context) {
      if (lg[0] !== initial) continue;
      // Searching a genus-scoped sub-list means the genus distance is always 0,
      // so `dist` IS the epithet distance and the first-letter/charCode guards
      // inside findClosestInList apply exactly as they do everywhere else.
      const r = findClosestInList(idx.get(lg), lg, species, 2);
      if (!r) continue;
      scored.push({ ctx, dist: r.dist, isValid: !!r.entry.binomial });
    }
    // The epithet gate. Requiring the epithet to be within edit distance 2 of
    // one this genus actually uses is what keeps the pass from FABRICATING a
    // binomial: without it, "C. catla" with Cyprinus in scope becomes "Cyprinus
    // catla" (the author meant Catla) and "R. kanagurta" becomes "Rhomboplites
    // kanagurta" (they meant Rastrelliger). Demoting a name the author wrote is
    // fine; inventing one they never wrote is not. A misspelling is within 2 by
    // definition, so this costs the feature nothing.
    if (!scored.length) return null;

    let best = Infinity;
    for (const s of scored) if (s.dist < best) best = s.dist;
    let top = scored.filter(s => s.dist === best);

    // A valid name beats a synonym at equal distance. Every measured tie was a
    // 0-distance match on both candidates, so distance alone cannot break them.
    if (top.length > 1 && top.some(s => s.isValid)) top = top.filter(s => s.isValid);

    // Still tied → the nearest spelled-out mention wins, preferring one that
    // precedes the abbreviation.
    if (top.length > 1) {
      const proximity = (s) => {
        let before = -1, after = Infinity;
        for (const i of s.ctx.indices) {
          if (i < at) { if (i > before) before = i; }
          else if (i < after) after = i;
        }
        return before >= 0 ? at - before : 1e9 + (after - at);
      };
      const ranked = top.map(s => ({ s, p: proximity(s) })).sort((a, b) => a.p - b.p);
      if (ranked.length < 2 || ranked[0].p !== ranked[1].p) top = [ranked[0].s];
    }

    return top.length === 1 ? top[0].ctx.genus : null;
  }

  function extractCandidates(text, lookups) {
    const hits = [];
    const seen = new Set();
    let m;

    // Primary pass: standard binomials (Genus species)
    CANDIDATE_RE.lastIndex = 0;
    while ((m = CANDIDATE_RE.exec(text)) !== null) {
      seen.add(m.index);
      hits.push({ genus: m[1], species: m[2], text: m[0], index: m.index });
    }

    // Secondary pass: hyphenated species (e.g., Erimystax x-punctatus)
    HYPHEN_SP_RE.lastIndex = 0;
    while ((m = HYPHEN_SP_RE.exec(text)) !== null) {
      if (!seen.has(m.index)) {
        seen.add(m.index);
        hits.push({ genus: m[1], species: m[2], text: m[0], index: m.index });
      }
    }

    // Secondary pass: short genera (2 chars, e.g., Zu cristatus)
    // Only match if the genus exists in the database to avoid false positives
    if (lookups) {
      SHORT_GENUS_RE.lastIndex = 0;
      while ((m = SHORT_GENUS_RE.exec(text)) !== null) {
        if (!seen.has(m.index) && lookups.generaSet.has(m[1].toLowerCase())) {
          seen.add(m.index);
          hits.push({ genus: m[1], species: m[2], text: m[0], index: m.index });
        }
      }
    }

    // Final pass: genus abbreviated after first mention (e.g. P. olivaris).
    // Gated on `lookups` like the short-genus pass above — which also keeps
    // meta_analysis/04_analyze_names.js, the only caller that passes no lookups,
    // producing bit-for-bit the numbers the published FF-8.0 analysis reported.
    if (lookups) {
      if (!lookups.generaEpithetIndex) {
        lookups.generaEpithetIndex = buildGeneraEpithetIndex(lookups);
      }
      const gidx = lookups.generaEpithetIndex;

      // Context is every genus spelled out anywhere in this text, taken from the
      // passes above. Document-global, NOT restricted to mentions that precede
      // the abbreviation: abstracts, tables and captions each re-spell at their
      // own first mention, PDF extraction scrambles column order, and users
      // paste fragments such as a Methods section on its own. Document order is
      // used only as the last tie-break rung in resolveAbbreviatedGenus.
      const context = new Map();
      for (const h of hits) {
        const lg = h.genus.toLowerCase();
        if (!gidx.has(lg)) continue;
        let c = context.get(lg);
        if (!c) { c = { genus: h.genus, indices: [] }; context.set(lg, c); }
        c.indices.push(h.index);
      }

      if (context.size) {
        ABBREV_GENUS_RE.lastIndex = 0;
        while ((m = ABBREV_GENUS_RE.exec(text)) !== null) {
          // Group 1 is the consumed guard character, so the name starts after
          // it. Getting this wrong shifts every corrected-text splice by one.
          const at = m.index + m[1].length;
          if (seen.has(at)) continue;
          const species = m[3];
          if (SPECIES_ABBREVS.has(species.toLowerCase())) continue;
          const genus = resolveAbbreviatedGenus(
            gidx, context, m[2].toLowerCase(), species.toLowerCase(), at);
          if (!genus) continue;
          seen.add(at);
          hits.push({
            genus,
            species,
            text:   m[0].slice(m[1].length),   // "P. olivarus", exactly as written
            index:  at,
            abbrev: m[2] + '.',
          });
        }
      }
    }

    hits.sort((a, b) => a.index - b.index);
    return hits;
  }

  // An abbreviated mention that resolves to UNKNOWN is demoted, not reported:
  // we inferred the genus ourselves, so "unknown" means our inference failed
  // rather than that the author erred, and the spelled-out first mention is
  // still checked independently on its own merits. The epithet gate in
  // resolveAbbreviatedGenus should make this unreachable — it admits nothing
  // further than edit distance 2 from a real name — so this is a safety net that
  // keeps the guarantee if the database or that gate ever changes.
  function isLowConfidence(candidate, result) {
    if (!result) return false;
    if (result.lowConfidence) return true;
    return !!(candidate && candidate.abbrev) && result.type === 'unknown';
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
    // Every epithet the database uses, valid or synonym. Read by isProseEpithet
    // so the prose stoplist can never demote a real name.
    const epithetSet  = new Set();

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
      epithetSet.add(sp.toLowerCase());

      const cn = info.common_name_en;
      if (cn) commonNameMap.set(cn.toLowerCase(), { binomial: canonical, commonName: cn });
    }

    for (const [oldName, newName] of Object.entries(db.synonyms)) {
      synonymMap.set(oldName.toLowerCase(), newName);
      const parts = oldName.split(' ');
      if (parts.length >= 2) {
        const lSpecies = parts.slice(1).join(' ').toLowerCase();
        synonymList.push({
          lGenus:   parts[0].toLowerCase(),
          lSpecies,
          oldName,
          newName,
        });
        epithetSet.add(lSpecies);
      }
    }

    for (const genus of db.genera) {
      generaSet.add(genus.toLowerCase());
    }

    // Names withdrawn from the List by a published addendum. The `|| {}` matters:
    // engine.js also runs against archived database snapshots that predate this key.
    const removedMap = new Map();
    for (const [name, rec] of Object.entries(db.removed_names || {})) {
      removedMap.set(name.toLowerCase(), rec);
    }

    return {
      db, validSet, validMap, synonymMap, generaSet, removedMap,
      commonNameMap, validList, synonymList, epithetSet,
      commonNamePrefixMap: null,  // built lazily
      generaEpithetIndex:  null,  // built lazily, on first abbreviated mention
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
  exports.buildGeneraEpithetIndex  = buildGeneraEpithetIndex;
  exports.buildLookups         = buildLookups;
  exports.isProseEpithet       = isProseEpithet;
  exports.isLowConfidence      = isLowConfidence;
  exports.SPECIES_ABBREVS      = SPECIES_ABBREVS;
  exports.PROSE_WORDS          = PROSE_WORDS;
  exports.CANDIDATE_RE         = CANDIDATE_RE;
  exports.ABBREV_GENUS_RE      = ABBREV_GENUS_RE;

})(typeof module !== 'undefined' && module.exports ? module.exports
   : (this.FishEngine = this.FishEngine || {}));
