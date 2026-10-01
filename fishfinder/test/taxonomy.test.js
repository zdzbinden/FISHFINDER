/**
 * Classification fields: class, order and family.
 *
 * The engine never reads them, so nothing else would notice them going wrong,
 * and they did: until 2026-10-01 parse_pdf.py missed every `*`-flagged order
 * header and filed 51% of species under the wrong order (no Perciformes at all;
 * catfishes as Gymnotiformes), and filed all 43 clingfishes as mullets.
 * verify_classification.py checks the whole hierarchy against Eschmeyer's
 * Catalog; these tests pin the invariants and the cases that were wrong.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { db, engine, lookups } = require('./setup');

const entries = Object.entries(db.valid_names);

function groupSets(keyOf, valueOf) {
  const out = new Map();
  for (const [name, info] of entries) {
    const k = keyOf(name, info);
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(valueOf(name, info));
  }
  return out;
}

describe('classification invariants', () => {
  it('every species has a class, order and family', () => {
    const blank = entries.filter(([, i]) => !(i.class && i.order && i.family));
    assert.deepEqual(blank.map(([n]) => n), []);
  });

  it('each family sits in exactly one class and order', () => {
    const split = [...groupSets((n, i) => i.family, (n, i) => `${i.class}/${i.order}`)]
      .filter(([, s]) => s.size > 1);
    assert.deepEqual(split, []);
  });

  it('each genus sits in exactly one family', () => {
    const split = [...groupSets((n) => n.split(' ')[0], (n, i) => i.family)]
      .filter(([, s]) => s.size > 1);
    assert.deepEqual(split, []);
  });

  it('has the 8th edition hierarchy, not a collapsed one', () => {
    // Floors track the current build (FF-8.1: 5 classes, 70 orders, 345 families).
    // The header bug left 50 orders.
    const count = (f) => new Set(entries.map(([, i]) => i[f])).size;
    assert.equal(count('class'), 5);
    assert.ok(count('order') >= 70, `expected >=70 orders, got ${count('order')}`);
    assert.ok(count('family') >= 345, `expected >=345 families, got ${count('family')}`);
  });
});

describe('species the header bug misfiled', () => {
  for (const [name, order, family, why] of [
    ['Ictalurus punctatus', 'Siluriformes', 'Ictaluridae', 'flagged order; was Gymnotiformes'],
    ['Perca flavescens', 'Perciformes', 'Percidae', 'flagged order; was Tetraodontiformes'],
    ['Micropterus nigricans', 'Centrarchiformes', 'Centrarchidae', 'flagged order'],
    ['Mugil cephalus', 'Blenniiformes', 'Mugilidae', 'Appendix 1: Dornburg & Near 2021'],
    ['Gobiesox strumosus', 'Blenniiformes', 'Gobiesocidae', 'comma header; was Mugilidae'],
    ['Paralichthys dentatus', 'Carangiformes', 'Paralichthyidae', 'Appendix 1: Girard et al. 2020'],
    ['Astyanax mexicanus', 'Characiformes', 'Characidae', 'the book omits the header'],
    ['Brycon guatemalensis', 'Characiformes', 'Bryconidae', 'the book omits the header'],
    ['Agamyxis pectinifrons', 'Siluriformes', 'Doradidae', 'addenda family, inherited'],
    ['Platyrhinoidis triseriata', 'Torpediniformes', 'Platyrhinidae', 'book prints Platyrhynidae'],
  ]) {
    it(`${name}: ${order} / ${family} (${why})`, () => {
      const info = db.valid_names[name];
      assert.ok(info, `${name} missing from the database`);
      assert.equal(info.order, order);
      assert.equal(info.family, family);
    });
  }
});

describe('a synonym the wrong family cost', () => {
  it('Cyclopterus nudus is the outdated name for Arcos nudus', () => {
    // The catalog files Arcos nudus under its original combination, so the scrape
    // fell back to a family+epithet search. Filed as a mullet, the clingfish was
    // searched for in Mugilidae and kept no synonyms until the family was fixed.
    const r = engine.classifyName(lookups, 'Cyclopterus', 'nudus');
    assert.equal(r.type, 'outdated');
    assert.equal(r.suggestion, 'Arcos nudus');
  });
});

describe('addenda placements decided against the catalog (2026-10-01)', () => {
  it('all Stathmonotus are in Labrisomidae, not split', () => {
    const fams = entries.filter(([n]) => n.startsWith('Stathmonotus ')).map(([, i]) => i.family);
    assert.equal(fams.length, 5);
    assert.deepEqual([...new Set(fams)], ['Labrisomidae']);
  });

  it('Polymetme corythaeola joins its congener in Phosichthyidae', () => {
    assert.equal(db.valid_names['Polymetme corythaeola'].family, 'Phosichthyidae');
    assert.equal(db.valid_names['Polymetme thaeocoryla'].family, 'Phosichthyidae');
  });
});
