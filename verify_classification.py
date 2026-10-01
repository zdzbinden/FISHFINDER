#!/usr/bin/env python3
"""
verify_classification.py — Cross-check the database's orders and families
against Eschmeyer's Catalog of Fishes classification.

Why. FISHFINDER never reads class/order/family, so nothing else notices when
they go wrong. Until 2026-10-01 parse_pdf.py missed every `*`-flagged order
header and filed 51% of species under the wrong order; the shipped database
had no Perciformes at all. The 8th edition says its arrangement of orders and
families "generally follow[s] Fricke et al. (2022, Eschmeyer's Catalog of
Fishes)", which makes the catalog the natural independent check.

AFS stays the authority. The catalog is a guide: it filled the one gap in the
print (the 8th edition omits ORDER CHARACIFORMES; see parse_pdf.py) and broke
the tie on Stathmonotus (see parse_addenda.py). Where the 8th edition chose
differently, on purpose, the difference is listed in KNOWN_ORDER_DIFFERENCES
with its reason, usually an Appendix 1 entry. Printed page numbers below are
the book's; the PDF runs 10 pages ahead.

Two sections, written to classification_crosscheck.json (committed):

  orders    Every family in the database, its order there and in the catalog.
            A family the catalog does not list (it lumps or spells it
            differently) is resolved through the catalog family its species'
            own pages give. An unexplained difference fails the run (exit 1),
            as does a known difference that no longer occurs.
  families  Informational. Each species' family against the one on its own
            catalog page (eschmeyer_text/, no network), grouped by pair. Every
            pair today is a whole-genus split the catalog makes and the 8th
            edition does not. A parse error would show up as a new pair.

The fetched page is stored at eschmeyer_text/classification.html.gz (gitignored),
so --offline replays a change to the database without the network.

Usage:
  uv run --with requests --with beautifulsoup4 python verify_classification.py
      --offline   reuse the stored page
"""

import collections
import datetime
import gzip
import json
import re
import sys
from pathlib import Path

import requests

import scrape_eschmeyer as esch

ROOT      = Path(__file__).parent
DB_PATH   = ROOT / "fishfinder" / "data" / "fish_names.json"
OVERLAY   = ROOT / "addenda_changes.json"
OUT_PATH  = ROOT / "classification_crosscheck.json"
PAGE_PATH = esch.TEXT_CACHE_DIR / "classification.html.gz"
PAGE_URL  = "https://www.calacademy.org/eschmeyers-catalog-of-fishes-classification"

# "<li>Order <strong>Characiformes</strong>" — one rank per list item.
RANK_RE = re.compile(r"<li>\s*(Class|Order|Suborder|Family|Subfamily)\s+<strong>\s*"
                     r"([A-Z][a-z]+)\s*</strong>")
# "... Current status: Valid as Arcos nudus (Linnaeus 1758). Gobiesocidae: Gobiesocinae."
STATUS_RE = re.compile(r"Current status: Valid as ([A-Z][a-z]+ [a-z-]+)[^.]*?\d{4}\)?\.\s+"
                       r"([A-Z][a-z]+idae)\b")

_PERCIFORMES = ("The 8th edition keeps this family in Perciformes. Appendix 1 (p. 243) "
                "moves only Acanthuridae, Chaetodontidae, Ephippidae, Lobotidae, "
                "Luvaridae, Pomacanthidae and Zanclidae to Acanthuriformes, following "
                "Gill & Leis (2019).")
_SACCOPHARYNX = ("The 8th edition keeps Saccopharyngiformes; Appendix 1 records no "
                 "change. The catalog includes these families in Anguilliformes.")

# family -> why the 8th edition's order differs from the catalog's.
KNOWN_ORDER_DIFFERENCES = {
    "Moronidae":       _PERCIFORMES,
    "Emmelichthyidae": _PERCIFORMES,
    "Priacanthidae":   _PERCIFORMES,
    "Malacanthidae":   _PERCIFORMES,
    "Lutjanidae":      _PERCIFORMES,
    "Haemulidae":      _PERCIFORMES,
    "Sparidae":        _PERCIFORMES,
    "Sciaenidae":      _PERCIFORMES,
    "Cyematidae":      _SACCOPHARYNX,
    "Monognathidae":   _SACCOPHARYNX,
    "Neocyematidae":   _SACCOPHARYNX,
    "Eurypharyngidae": _SACCOPHARYNX,
    "Saccopharyngidae": _SACCOPHARYNX,
    "Esocidae":        "The 8th edition keeps Esociformes; Appendix 1 records no change. "
                       "The catalog includes pikes in Salmoniformes.",
    "Stylephoridae":   "Appendix 1 (p. 229): Stylephoriformes new to the list, transferred "
                       "from Lampriformes following Miya et al. (2007) and Betancur-R. et "
                       "al. (2017). The catalog places it in Gadiformes.",
    "Holocentridae":   "Appendix 1 (p. 231): Holocentriformes new to the list, transferred "
                       "from Beryciformes following Moore (1993) and Betancur-R. et al. "
                       "(2017). The catalog keeps it in Beryciformes.",
    "Apogonidae":      "Appendix 1 (p. 236): Kurtiformes new to the list, transferred from "
                       "Perciformes following Thacker (2009) and McCraney et al. (2020). "
                       "The catalog places it in Gobiiformes.",
    "Mugilidae":       "Appendix 1 (p. 241): transferred from Perciformes to Blenniiformes "
                       "following Dornburg & Near (2021). The catalog has Mugiliformes.",
    "Gerreidae":       "Appendix 1 (p. 246): Labriformes new to the list, Gerreidae "
                       "transferred from Perciformes following Betancur-R. et al. (2017) "
                       "and Dornburg & Near (2021). The catalog places it in "
                       "Acanthuriformes.",
    "Polymixiidae":    "Same order, spelled differently: the 8th edition prints "
                       "POLYMIXIFORMES, the catalog Polymixiiformes.",
}


def fetch_page(offline: bool) -> tuple[str, str]:
    """Return (html, accessed date). Online, also store the page for --offline."""
    if offline:
        if not PAGE_PATH.exists():
            raise SystemExit(f"ERROR: --offline needs {PAGE_PATH}, which does not exist.")
        with gzip.open(PAGE_PATH, "rt", encoding="utf-8") as f:
            stored = json.load(f)
        return stored["html"], stored["accessed"]
    resp = requests.get(PAGE_URL, headers=esch.HEADERS, timeout=60)
    resp.raise_for_status()
    resp.encoding = "utf-8"
    accessed = datetime.date.today().isoformat()
    PAGE_PATH.parent.mkdir(exist_ok=True)
    with gzip.open(PAGE_PATH, "wt", encoding="utf-8") as f:
        json.dump({"url": PAGE_URL, "accessed": accessed, "html": resp.text}, f)
    return resp.text, accessed


def catalog_orders(html: str) -> dict[str, str]:
    """family -> order, in the catalog's own hierarchy."""
    out, order = {}, ""
    for rank, name in RANK_RE.findall(html):
        if rank == "Order":
            order = name
        elif rank == "Family":
            out.setdefault(name, order)
    if len(out) < 500:
        raise SystemExit(f"ERROR: parsed only {len(out)} families from the catalog page; "
                         "its markup has probably changed.")
    return out


def page_families(valid_names: dict, renames: dict) -> dict[str, str]:
    """binomial -> the family on its own catalog page, where one is found.

    A renamed species may only have a page under its pre-addenda name, which is
    how the catalog keys it."""
    out = {}
    for name in valid_names:
        hits = collections.Counter()
        for key in (name, renames.get(name)):
            page = esch.load_text(key) if key else None
            if page is None:
                continue
            for m in STATUS_RE.finditer(page["text"]):
                if m.group(1) in (name, key):
                    hits[m.group(2)] += 1
            if hits:
                break
        if hits:
            out[name] = hits.most_common(1)[0][0]
    return out


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    offline = "--offline" in sys.argv

    with open(DB_PATH, encoding="utf-8") as f:
        db = json.load(f)
    vn = db["valid_names"]
    with open(OVERLAY, encoding="utf-8") as f:
        renames = {r["to"]: r["from"] for r in json.load(f)["renames"]}

    html, accessed = fetch_page(offline)
    cat = catalog_orders(html)
    on_page = page_families(vn, renames)

    afs_order = {}
    members = collections.defaultdict(list)
    for name, info in vn.items():
        afs_order[info["family"]] = info["order"]
        members[info["family"]].append(name)

    orders, unexplained = {}, []
    for fam in sorted(afs_order):
        rec = {"afs": afs_order[fam]}
        if fam in cat:
            rec["catalog"] = cat[fam]
        else:
            # Not a family in the catalog: follow its species to the catalog
            # family they are filed under there.
            via = collections.Counter(on_page[n] for n in members[fam] if n in on_page)
            if via:
                rec["via"] = via.most_common(1)[0][0]
                rec["catalog"] = cat.get(rec["via"], "")
        if rec.get("catalog") == rec["afs"]:
            rec["status"] = "agree"
        elif not rec.get("catalog"):
            rec["status"] = "not_found"
            unexplained.append(fam)
        elif fam in KNOWN_ORDER_DIFFERENCES:
            rec["status"] = "afs_differs"
            rec["reason"] = KNOWN_ORDER_DIFFERENCES[fam]
        else:
            rec["status"] = "UNEXPLAINED"
            unexplained.append(fam)
        orders[fam] = rec
    stale = [f for f in KNOWN_ORDER_DIFFERENCES
             if orders.get(f, {}).get("status") != "afs_differs"]

    pairs = collections.defaultdict(list)
    for name, fam in on_page.items():
        if fam != vn[name]["family"]:
            pairs[(vn[name]["family"], fam)].append(name)
    families = [
        {"afs": a, "catalog": c, "species": len(names),
         "genera": sorted({n.split(" ")[0] for n in names})}
        for (a, c), names in sorted(pairs.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    ]

    status = collections.Counter(r["status"] for r in orders.values())
    out = {
        "source": {
            "title": "Eschmeyer's Catalog of Fishes Classification",
            "editors": "R. van der Laan and R. Fricke",
            "url": PAGE_URL,
            "accessed": accessed,
        },
        "database": {
            "data_version": db["metadata"].get("data_version"),
            "species": len(vn),
            "families": len(afs_order),
            "orders": len(set(afs_order.values())),
        },
        "summary": {
            "families_agree": status["agree"],
            "families_via_species": sum(1 for r in orders.values() if "via" in r),
            "known_differences": status["afs_differs"],
            "unexplained": len(unexplained),
            "species_with_catalog_family": len(on_page),
            "species_family_differs": sum(len(v) for v in pairs.values()),
        },
        "orders": orders,
        "families": families,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    s = out["summary"]
    print(f"Catalog accessed {accessed}: {len(cat)} families")
    print(f"Orders: {s['families_agree']} of {len(orders)} families agree "
          f"({s['families_via_species']} resolved via their species), "
          f"{s['known_differences']} known differences, {s['unexplained']} unexplained")
    print(f"Families: {s['species_with_catalog_family']} species have a catalog family; "
          f"{s['species_family_differs']} differ, in {len(families)} (AFS, catalog) pairs")
    print(f"Wrote {OUT_PATH.name}")
    for fam in unexplained:
        print(f"  UNEXPLAINED {fam}: {orders[fam]}")
    for fam in stale:
        print(f"  STALE reason for {fam}: now {orders.get(fam, {}).get('status', 'absent')}")
    return 1 if unexplained or stale else 0


if __name__ == "__main__":
    sys.exit(main())
