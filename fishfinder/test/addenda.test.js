/**
 * 2025 Addenda overlay — behavioural lock-in.
 *
 * Covers the merge of Schmitter-Soto et al., "Addenda, corrigenda, et explanenda
 * to Common and Scientific Names of Fishes, Eighth Edition" (Fisheries
 * 51(5):225-227, doi:10.1093/fshmag/vuaf083) into fish_names.json.
 *
 * These tests exist because most of the failure modes here are SILENT: a name
 * that classifies as valid and as a synonym simply loses its synonym entry; a
 * common-name collision drops a species from lookup with no error; a stale
 * synonym target produces a suggestion the user cannot act on.
 */
const { test, describe, it } = require('node:test');
const assert = require('node:assert');
const { engine, lookups, db } = require('./setup');

const classify = (g, s) => engine.classifyName(lookups, g, s);
const split = (binomial) => binomial.split(' ');

describe('2025 Addenda', () => {

  describe('additions', () => {
    // Spot-checks across the different ways a name enters the List.
    for (const [name, why] of [
      ['Moxostoma ugidatli',      'new species described since the 8th edition'],
      ['Caliraja cortezensis',    'new genus — previously invisible to the engine'],
      ['Radiicephalus elongatus', 'new genus AND new family'],
      ['Congriscus megastoma',    'new genus'],
      ['Bollmannia gomezi',       'new species; the table misspells the genus'],
      ['Elacatinus horsti',       'reinstated in the List'],
    ]) {
      it(`recognizes ${name} (${why})`, () => {
        const r = classify(...split(name));
        assert.ok(r, `${name} should not be null — it was invisible before the merge`);
        assert.ok(r.type === 'valid' || r.type === 'changed',
          `${name} should be valid/changed, got ${r.type}`);
      });
    }

    it('marks addenda-sourced names with their provenance', () => {
      const r = classify('Caliraja', 'cortezensis');
      assert.equal(r.addenda, '2025',
        'addenda species must carry a provenance marker so users can tell them ' +
        'apart from the printed 8th edition');
    });

    it('does not mark printed-8th-edition names as addenda', () => {
      const r = classify('Oncorhynchus', 'mykiss');
      assert.equal(r.addenda, null);
    });

    it('never stores the table\'s editorial prose as a common name', () => {
      // Some cells hold only a FAMILY-level name, e.g. Galeocerdo cuvieri's
      // "For the family: tiger sharks, tintoreras, requins tigre". Taking that as
      // the species' common name overwrote "Tiger Shark" in an early build.
      assert.equal(db.valid_names['Galeocerdo cuvieri'].common_name_en, 'Tiger Shark');
      assert.equal(db.valid_names['Galeocerdo cuvieri'].family, 'Galeocerdonidae');

      const prose = Object.entries(db.valid_names)
        .filter(([, v]) => /for the family|corrected throughout|spelling of/i
          .test(v.common_name_en || ''))
        .map(([k]) => k);
      assert.deepEqual(prose, [], 'editorial prose leaked into common_name_en');
    });
  });

  describe('renames — old name becomes outdated, new name becomes valid', () => {
    for (const [from, to] of [
      ['Beringraja rhina',        'Caliraja rhina'],           // genus transfer
      ['Beringraja stellulata',   'Caliraja stellulata'],
      ['Galeocerdo cuvier',       'Galeocerdo cuvieri'],       // spelling correction
      ['Sparus auratus',          'Sparus aurata'],            // gender correction
      ['Astronesthes niger',      'Astronesthes nigra'],
      ['Sargocentron coruscum',   'Neoniphon coruscus'],       // genus transfer + gender
      ['Hemichromis guttatus',    'Rubricatochromis guttatus'],
      ['Thoburnia atripinnis',    'Vexillichthys atripinnis'],
      ['Careproctus attenuatus',  'Allinectes attenuatus'],
      ['Temnocora candida',       'Careproctus candidus'],
      ['Etmopterus benchleyi',    'Etmopterus litvinovi'],     // replacement
      ['Urotrygon chilensis',     'Urotrygon asterias'],
    ]) {
      it(`${from} -> ${to}`, () => {
        const oldR = classify(...split(from));
        assert.ok(oldR, `${from} should still be recognized`);
        assert.equal(oldR.type, 'outdated', `${from} should now be outdated`);
        assert.equal(oldR.suggestion, to);

        const newR = classify(...split(to));
        assert.ok(newR, `${to} should be recognized`);
        assert.ok(newR.type === 'valid' || newR.type === 'changed',
          `${to} should be valid/changed, got ${newR.type}`);
      });
    }
  });

  describe('synonym retargeting', () => {
    // Pre-existing synonyms pointed at names the addenda demoted. Each had to be
    // re-pointed at the new name, or it would suggest a name that is no longer valid.
    for (const [old, expected] of [
      ['Raja rhina',            'Caliraja rhina'],
      ['Raia rhina',            'Caliraja rhina'],
      ['Raja cortezensis',      'Caliraja cortezensis'],
      ['Raia stellulata',       'Caliraja stellulata'],
      ['Galeus maculatus',      'Galeocerdo cuvieri'],        // 1 of 7 inbound
      ['Liparis candida',       'Careproctus candidus'],
      ['Moxostoma atripinnis',  'Vexillichthys atripinnis'],
      ['Holocentrum coruscum',  'Neoniphon coruscus'],
      ['Notropis garmani',      'Cyprinella rubripinna'],
      ['Etheostoma rubrus',     'Nothonotus ruber'],
    ]) {
      it(`${old} now resolves to ${expected}`, () => {
        const r = classify(...split(old));
        assert.ok(r, `${old} should still be recognized`);
        assert.equal(r.type, 'outdated');
        assert.equal(r.suggestion, expected);
      });
    }
  });

  describe('Urotrygon asterias promotion', () => {
    // It was a SYNONYM of Urotrygon munda; the addenda makes it valid. If the
    // stale synonym entry survived, classifyName would still return valid (step 1
    // beats step 2) but the synonym map would be quietly self-contradictory.
    it('classifies as valid, not outdated', () => {
      const r = classify('Urotrygon', 'asterias');
      assert.ok(r);
      assert.ok(r.type === 'valid' || r.type === 'changed');
      assert.equal(r.suggestion, null);
    });

    it('is no longer present in the synonym map', () => {
      assert.ok(!lookups.synonymMap.has('urotrygon asterias'),
        'a name cannot be both valid and a synonym');
    });
  });

  describe('Dionda coordinated common-name swap', () => {
    // The addenda renames two species AND gives their old common names to two new
    // species. commonNameMap is last-writer-wins, so applying the additions before
    // the renames would silently drop a species from common-name lookup.
    for (const [commonName, binomial] of [
      ['guadalupe roundnose minnow', 'Dionda flavipinnis'],
      ['nueces roundnose minnow',    'Dionda texensis'],
      ['medina roundnose minnow',    'Dionda nigrotaeniata'],
      ['frio roundnose minnow',      'Dionda serena'],
    ]) {
      it(`"${commonName}" resolves to ${binomial}`, () => {
        const hit = lookups.commonNameMap.get(commonName);
        assert.ok(hit, `${commonName} lost its common-name lookup`);
        assert.equal(hit.binomial, binomial);
      });
    }

    it('renamed the incumbents rather than duplicating their names', () => {
      assert.equal(db.valid_names['Dionda nigrotaeniata'].common_name_en,
        'Medina Roundnose Minnow');
      assert.equal(db.valid_names['Dionda serena'].common_name_en,
        'Frio Roundnose Minnow');
    });
  });

  describe('withdrawn species', () => {
    it('Gambusia clarkhubbsi is no longer a valid name', () => {
      assert.ok(!('Gambusia clarkhubbsi' in db.valid_names));
    });

    it('is recorded with a reason rather than dropped silently', () => {
      const rec = db.removed_names && db.removed_names['Gambusia clarkhubbsi'];
      assert.ok(rec, 'removed_names must explain the withdrawal');
      assert.ok(rec.reason && rec.reason.length > 0);
    });

    it('reports the withdrawal instead of a bare unknown', () => {
      const r = classify('Gambusia', 'clarkhubbsi');
      assert.ok(r);
      assert.equal(r.removed, true);
      assert.ok(r.note && r.note.length > 0, 'must carry an explanation');
      // No replacement name was published — never invent one.
      assert.equal(r.suggestion, null);
    });
  });

  describe('genera bookkeeping', () => {
    // db.genera is a SEPARATE array; engine.js builds generaSet from it alone, so
    // it can silently drift from valid_names.
    it('added the genera the addenda introduces', () => {
      for (const g of ['Caliraja', 'Rubricatochromis', 'Vexillichthys', 'Allinectes',
                       'Radiicephalus', 'Agamyxis', 'Ioichthys']) {
        assert.ok(lookups.generaSet.has(g.toLowerCase()), `${g} missing from genera`);
      }
      // Misspelled in the table; the real genera already existed, so neither
      // misspelling may leak into db.genera.
      for (const g of ['Plectrobranchus', 'Bollmania']) {
        assert.ok(!lookups.generaSet.has(g.toLowerCase()),
          `${g} is a table typo and must not become a genus`);
      }
      for (const g of ['Plectobranchus', 'Bollmannia']) {
        assert.ok(lookups.generaSet.has(g.toLowerCase()), `${g} should be present`);
      }
    });

    it('dropped only the genera that actually lost every species', () => {
      for (const g of ['Hemichromis', 'Temnocora']) {
        assert.ok(!lookups.generaSet.has(g.toLowerCase()),
          `${g} has no species left and should be gone`);
      }
      // These three look emptied but are same-genus corrections — they keep a species.
      for (const g of ['Galeocerdo', 'Doryrhamphus', 'Sparus']) {
        assert.ok(lookups.generaSet.has(g.toLowerCase()),
          `${g} still has a species and must remain`);
      }
    });

    it('genera array matches the genera of valid_names exactly', () => {
      const derived = [...new Set(Object.keys(db.valid_names).map(k => k.split(' ')[0]))].sort();
      assert.deepEqual(db.genera, derived);
    });
  });

  describe('curated synonyms', () => {
    // Three old names are claimed by two species' Eschmeyer pages — once by the
    // established species and once, in passing, by a species the addenda adds.
    // Which wins is dict-insertion order, so the overlay pins them. Without this,
    // a full synonym rebuild and an incremental --merge disagree.
    for (const [old, expected] of [
      ['Notropis deliciosus', 'Miniellus stramineus'],   // pre-existing cache drift
      ['Notropis lutrensis',  'Cyprinella lutrensis'],   // Red Shiner; both candidates were wrong
      ['Isabela ove',         'Quassiremus evionthas'],  // Ophichthidae, not a parrotfish
      ['Conger brasiliensis', 'Conger triporiceps'],     // genuine homonym; Kaup 1856 entry
      // Recovered by hand after the scrape missed them (queried by family+epithet).
      ['Caecula equatorialis', 'Apterichtus equatorialis'],  // original combination
    ]) {
      it(`${old} stays mapped to ${expected}`, () => {
        assert.equal(db.synonyms[old], expected);
      });
    }
  });

  describe('transcription errors in the supplementary table', () => {
    // Five names in the table disagree with Eschmeyer's record of the original
    // spelling. All five sit on rows labelled "New to the List" / "New for Mexico"
    // — never "Spelling correction", a label the addenda uses 8 times when it means
    // it — and all five contradict the List's own house style. ICZN governs original
    // spellings, so the published form is valid and the table's form resolves to it.
    for (const [printed, correct] of [
      ['Ipnops agassizi',           'Ipnops agassizii'],
      ['Symphurus ocullelus',       'Symphurus oculellus'],
      ['Apterichtus aequatorialis', 'Apterichtus equatorialis'],
      ['Bollmania gomezi',          'Bollmannia gomezi'],
      ['Plectrobranchus evides',    'Plectobranchus evides'],
    ]) {
      it(`${correct} is the valid name; ${printed} resolves to it`, () => {
        const ok = classify(...split(correct));
        assert.ok(ok, `${correct} should be recognized`);
        assert.ok(ok.type === 'valid' || ok.type === 'changed',
          `${correct} should be valid, got ${ok.type}`);

        const bad = classify(...split(printed));
        assert.ok(bad, `${printed} should still be recognized`);
        assert.equal(bad.suggestion, correct,
          `a reader working from the table must still land on ${correct}`);
      });
    }

    it('did not add a duplicate of a species already in the 8th edition', () => {
      // Plectobranchus evides Gilbert 1890 was already listed; the table's
      // "Plectrobranchus" inserts an r, which made the row look like a new species.
      assert.ok(!('Plectrobranchus evides' in db.valid_names));
      assert.ok('Plectobranchus evides' in db.valid_names);
      // The row is a new-for-Mexico occurrence record, so Mexico must be present.
      assert.match(db.valid_names['Plectobranchus evides'].occurrence, /M/);
    });

    it('does not map Tomiyamichthys gomezi onto Bollmannia gomezi', () => {
      // Same epithet, unrelated Indo-Pacific gobiid — a different valid species.
      const r = classify('Tomiyamichthys', 'gomezi');
      assert.ok(!(r && r.suggestion), 'must not suggest a replacement');
    });
  });

  describe('database invariants', () => {
    it('no name is both valid and a synonym', () => {
      const overlap = Object.keys(db.synonyms).filter(k => k in db.valid_names);
      assert.deepEqual(overlap, [],
        'classifyName checks valid before synonym, so an overlap makes the ' +
        'synonym entry unreachable');
    });

    it('every synonym points at a name that is actually valid', () => {
      const dangling = Object.entries(db.synonyms)
        .filter(([, target]) => !(target in db.valid_names))
        .map(([old, target]) => `${old} -> ${target}`);
      assert.deepEqual(dangling.slice(0, 5), [],
        `${dangling.length} synonyms suggest a name that is not valid`);
    });

    it('every addenda name is shaped so the engine can see it', () => {
      // A non-breaking space in the source table would produce a single-token
      // "genus" that CANDIDATE_RE can never match.
      const bad = Object.keys(db.valid_names).filter(name => {
        const parts = name.split(' ');
        return parts.length !== 2 || !/^[\x20-\x7E]*$/.test(name) || parts[1].length < 3;
      });
      assert.deepEqual(bad.slice(0, 5), [], `${bad.length} unusable names`);
    });

    it('metadata counts match reality', () => {
      assert.equal(db.metadata.species_count, Object.keys(db.valid_names).length);
      assert.equal(db.metadata.synonym_count, Object.keys(db.synonyms).length);
    });

    it('records the data version and its source', () => {
      assert.equal(db.metadata.data_version, 'FF-8.1');
      assert.ok(db.metadata.addenda, 'metadata.addenda must record the provenance');
      assert.equal(db.metadata.addenda.doi, '10.1093/fshmag/vuaf083');
    });
  });
});
