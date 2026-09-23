#!/usr/bin/env python3
"""Parse the 2025 Addenda supplementary table into a curated overlay JSON.

Reads the Word table from

    names_of_fishes/addenda/vuaf083_supplementary_data.docx

(Schmitter-Soto et al., "Addenda, corrigenda, et explanenda to Common and
Scientific Names of Fishes, Eighth Edition," Fisheries 51(5):225-227,
doi:10.1093/fshmag/vuaf083) and emits `addenda_changes.json` — the committed,
human-reviewable overlay that `apply_addenda.py` applies to fish_names.json.

The docx is copyrighted (gitignored alongside the AFS source PDF), so the
*output* is what gets committed: contributors without the docx can still
regenerate fish_names.json. Same split as meta_analysis/verify_extralimital.py
(the derivation tool) vs extralimital_valids.json (the committed artifact).

Standard library only — no dependencies, deterministic output.

Usage:
    python parse_addenda.py            # write addenda_changes.json
    python parse_addenda.py --check    # re-parse and diff; write nothing
"""
import argparse
import datetime
import json
import re
import sys
import zipfile
from html import unescape
from pathlib import Path

ROOT       = Path(__file__).parent
DOCX_PATH  = ROOT / "names_of_fishes" / "addenda" / "vuaf083_supplementary_data.docx"
DB_PATH    = ROOT / "fishfinder" / "data" / "fish_names.json"
OUT_PATH   = ROOT / "addenda_changes.json"

DATA_VERSION = "FF-8.1"

# ── Text normalization ────────────────────────────────────────────────────────
# 44 of the 244 name cells carry U+00A0; in at least one (Etmopterus litvinovi)
# the non-breaking space IS the genus/epithet separator. Splitting on ' ' without
# normalizing first yields a single-token genus, which silently corrupts db.genera
# and makes the species unreachable by the engine's CANDIDATE_RE.
NBSP_MAP = {
    " ": " ",   # no-break space
    " ": " ",   # figure space
    " ": " ",   # narrow no-break space
    "​": "",    # zero-width space
    "‌": "",    # zero-width non-joiner
    "‑": "-",   # non-breaking hyphen
    "‐": "-",   # hyphen
}

BINOMIAL_RE = re.compile(r"^[A-Z][a-z]+ [a-z][a-z-]{2,}$")

# Transcription errors in the supplementary table, verified against Eschmeyer's
# Catalog 2026-09-21. Every one is on a row labelled "New to the List" or "New for
# Mexico" — never "Spelling correction" — and each contradicts both Eschmeyer's
# record of the original spelling and the List's own house style. ICZN governs
# original spellings (Art. 32.5, 33.2.3), so the published spelling is used as the
# valid name and the table's spelling is recorded as a synonym.
#
# 132 of the 138 new binomials matched Eschmeyer character-for-character on an
# exact query, so this list is the complete set of discrepancies.
NAME_CORRECTIONS = {
    # addenda spelling            correct spelling
    "Ipnops agassizi":            "Ipnops agassizii",
    "Symphurus ocullelus":        "Symphurus oculellus",
    "Apterichtus aequatorialis":  "Apterichtus equatorialis",
    "Bollmania gomezi":           "Bollmannia gomezi",
    "Plectrobranchus evides":     "Plectobranchus evides",
}

CORRECTION_NOTES = {
    "Ipnops agassizii":
        "Garman 1899. The List already spells 6 of 7 Agassiz patronyms 'agassizii', "
        "including Leptochilichthys agassizii — the same author, same year.",
    "Symphurus oculellus":
        "Munroe 1991. oculus + diminutive -ellus; 'ocullelus' doubles the L in the "
        "wrong position and is not a well-formed Latin diminutive.",
    "Apterichtus equatorialis":
        "Myers & Wade 1941. The List already holds four 'equatorialis' epithets and "
        "no 'aequatorialis'. Latinising to 'aequ-' would be an unjustified emendation "
        "under ICZN Art. 33.2.3.",
    "Bollmannia gomezi":
        "The gobiid genus is Bollmannia Jordan 1890 (8 species already in the List); "
        "the table drops an 'n'.",
    "Plectobranchus evides":
        "Gilbert 1890 — ALREADY in the 8th edition. The table's 'Plectrobranchus' "
        "inserts an 'r', which made the row look like a new species; it is in fact a "
        "new-for-Mexico occurrence record for an existing entry.",
}

# Sentinels in the Occurrence / common-name columns meaning "leave as is".
NO_CHANGE = {"no change", "n/a", "none", ""}

# ── Change-column classification ──────────────────────────────────────────────
ADDITION_CHANGES = {
    "New to the List",
    "New to the List (also the family)",
    "New to the List, also the family",
    "New, Pacific and Mexico",
    "Reinstated in the List",
}

# Renames: the Change column names the old genus or an abbreviated old binomial,
# but gender/spelling corrections name nothing at all. All 22 were resolved by
# hand against fish_names.json and are listed here explicitly; main() ASSERTS that
# every `from` is currently a valid name, so a stale entry fails loudly.
RENAMES = {
    "Galeocerdo cuvieri":           "Galeocerdo cuvier",
    "Etmopterus litvinovi":         "Etmopterus benchleyi",
    "Cyprinella rubripinna":        "Cyprinella garmani",
    "Astronesthes indica":          "Astronesthes indicus",
    "Astronesthes nigra":           "Astronesthes niger",
    "Synodus macrostigmus":         "Synodus macrostigma",
    "Neoniphon coruscus":           "Sargocentron coruscum",
    "Neoniphon suborbitalis":       "Sargocentron suborbitale",
    "Doryrhamphus melanopleura":    "Doryrhamphus excisus",
    "Fundulus herminiamatildae":    "Fundulus herminiamatildarum",
    "Nothonotus ruber":             "Nothonotus rubrus",
    "Sparus aurata":                "Sparus auratus",
    "Caliraja cortezensis":         "Beringraja cortezensis",
    "Caliraja inornata":            "Beringraja inornata",
    "Caliraja rhina":               "Beringraja rhina",
    "Caliraja stellulata":          "Beringraja stellulata",
    "Vexillichthys atripinnis":     "Thoburnia atripinnis",
    "Rubricatochromis guttatus":    "Hemichromis guttatus",
    "Rubricatochromis letourneuxi": "Hemichromis letourneuxi",
    "Allinectes attenuatus":        "Careproctus attenuatus",
    "Urotrygon asterias":           "Urotrygon chilensis",
    "Careproctus candidus":         "Temnocora candida",
}

RENAME_NOTES = {
    "Careproctus candidus":
        "The addenda prints 'Formerly in Temnocara'; the 8th edition and Eschmeyer "
        "both spell the genus 'Temnocora'. The DB spelling is treated as "
        "authoritative for the `from` key. Flag for the Committee.",
    "Urotrygon asterias":
        "Urotrygon asterias is currently a SYNONYM of Urotrygon munda in the DB. "
        "It is promoted to valid here; the stale synonym entry is swept by "
        "addenda_overlay.apply_synonyms().",
}

# Genus-level rows that carry no binomial — handled as explicit notes.
GENUS_ROW_RE = re.compile(r"^([A-Z][a-z]+)(?:\s+and\s*([A-Z][a-z]+))?\s+spp\.$")

# The 5 families the addenda introduces. `anchor` names an existing DB entry —
# a binomial, a genus, or a sibling family — from which class/order are inherited.
#
# On `order`: the DB's order field is wrong for entire families (a documented
# page-boundary carry-over bug in parse_pdf.py — e.g. every catfish family is filed
# under "Gymnotiformes", every stichaeid relative under "Tetraodontiformes"). We
# deliberately inherit the *sibling's* value rather than the correct one, so new
# entries stay internally consistent with their own family. When the parser bug is
# fixed, every entry in a family gets corrected together, these included. The field
# is not read by the engine, the app, or any test.
NEW_FAMILIES = {
    "Galeocerdonidae":  {"en": "tiger sharks",            "es": "tintoreras",
                         "fr": "requins tigre",
                         "anchor": "Galeocerdo cuvier"},        # binomial
    "Radiicephalidae":  {"en": "tapertails",              "es": "colas cónicas",
                         "fr": "queues effilées",
                         "anchor": "family:Trachipteridae"},    # sibling lampriform
    "Doradidae":        {"en": "thorny catfishes",        "es": "bagres espinosos",
                         "fr": "poissons-chats épineux",
                         "anchor": "family:Loricariidae"},      # sibling catfish
    "Cebidichthyidae":  {"en": "monkeyfaces",             "es": "peces cara de mono",
                         "fr": "poissons visage de singe",
                         "anchor": "Cebidichthys"},             # genus, split from Stichaeidae
    "Opisthocentridae": {"en": "spined fin pricklebacks", "es": "abrojos espinosos",
                         "fr": "stichées épineux",
                         "anchor": "Kasatkia"},                 # genus, split from Stichaeidae
}

# Pre-existing cache drift: present in the shipped 8th-ed build but absent from
# eschmeyer_cache.json, so any full rebuild of the synonym map silently loses it.
# Re-asserted by the overlay so a rebuild is lossless. See REVISION_LOG 2026-07-14
# and the lock-in test at fishfinder/test/classify.test.js:46.
CURATED_SYNONYMS = [
    {
        "old": "Notropis deliciosus",
        "new": "Miniellus stramineus",
        "reason": "Present in the shipped 8th-edition build but absent from "
                  "eschmeyer_cache.json (pre-existing cache drift). Re-asserted so a "
                  "full synonym-map rebuild is lossless.",
        "verified": "2026-07-14 (Eschmeyer's Catalog of Fishes)",
        "locked_by_test": "fishfinder/test/classify.test.js:46",
    },
    # Three old names are claimed by TWO species' Eschmeyer pages, so which one
    # wins is pure dict-insertion order and a full rebuild disagrees with a
    # --merge run. Each target below was checked against Eschmeyer directly rather
    # than assumed from whichever value happened to ship.
    {
        "old": "Notropis lutrensis",
        "new": "Cyprinella lutrensis",
        "reason": "The old combination for the Red Shiner. BOTH candidate values were "
                  "wrong: the shipped build had Cyprinella rutila (Mexican Red Shiner) "
                  "and a rebuild produced Cyprinella rubripinna (Gibbous Shiner). "
                  "Eschmeyer has no page under Notropis lutrensis, so neither is "
                  "supported; Cyprinella lutrensis is the actual current combination.",
        "verified": "2026-09-21 (Eschmeyer's Catalog of Fishes; no record under "
                    "Notropis lutrensis)",
    },
    # REMOVED 2026-09-22: "Isabela ove" -> "Quassiremus evionthas".
    #
    # It was never a name. It is a parser artifact: ENTRY_HEADER_RE had no left
    # word boundary, so "...Sulphur Cove, Isabela Island [Albemarle]" in a type
    # locality was read as the entry header ('ove', 'Isabela'). The 2026-09-21
    # note rationalized it ("Isabela is a genus of Ophichthidae, so the Ophichthid
    # target is the right one") — Isabela IS a real snake-eel genus, which is
    # exactly why the artifact looked plausible enough to pin.
    #
    # Curating it made the overlay re-assert it after every rebuild, so the regex
    # fix alone could not have removed it. See test_scraper_parsing.py.
    #
    # Synonyms for addenda-added species that the scrape could not find on its own,
    # recovered by querying Eschmeyer by family+epithet (2026-09-21).
    {
        "old": "Caecula equatorialis",
        "new": "Apterichtus equatorialis",
        "reason": "Original combination. Eschmeyer: 'Caecula equatorialis ... Valid as "
                  "Apterichtus equatorialis (Myers & Wade 1941)'. The scrape missed it "
                  "because the species query is by the current genus, which finds nothing.",
        "verified": "2026-09-21 (Eschmeyer's Catalog of Fishes)",
    },
    {
        "old": "Conger brasiliensis",
        "new": "Conger triporiceps",
        "reason": "A genuine HOMONYM, not a scraping artifact: Eschmeyer lists two "
                  "nominal species under this name — 'brasiliensis, Conger Kaup 1856' "
                  "(Synonym of Conger triporiceps) and another (Synonym of Cynoponticus "
                  "savanna). A flat old->new map cannot express both. Pinned to the Kaup "
                  "1856 entry, which is what the 8th-edition build shipped; the "
                  "Cynoponticus reading is equally legitimate for its own entry.",
        "verified": "2026-09-21 (Eschmeyer's Catalog of Fishes; two entries confirmed)",
    },
    # Two more homonyms, surfaced by the 2026-09-22 parser fix. Before it, the
    # rival pages failed to parse at all (their entry authors are non-ASCII), so
    # these names had only one claimant and needed no curation. Now both pages
    # parse and the loser of a dict-order race would silently win.
    {
        "old": "Etrumeus teres",
        "new": "Etrumeus sadina",
        "reason": "Two nominal species. Eschmeyer's Etrumeus sadina page states "
                  "\"Mitchill's species sadina predates teres DeKay\" and carries "
                  "'Synonym of Etrumeus teres (DeKay 1842)'. The rival claim from "
                  "Etrumeus acuminatus is an incidental chain reference inside the "
                  "Perkinsia othonops entry, and acuminatus is a Pacific species "
                  "while teres/sadina is the Atlantic round herring.",
        "verified": "2026-09-22 (Eschmeyer's Catalog of Fishes; both pages read)",
    },
    {
        "old": "Scomber pelamis",
        "new": "Katsuwonus pelamis",
        "reason": "Senior homonym wins. 'pelamis, Scomber Linnaeus [C.] 1758' is the "
                  "basionym of the skipjack tuna and its entry reads 'Valid as "
                  "Katsuwonus pelamis (Linnaeus 1758)'. The rival, 'pelamis, Scomber "
                  "Brünnich [M. T.] 1768' (Synonym of Sarda sarda), is a junior "
                  "homonym; a manuscript writing Scomber pelamis means the Linnaean one.",
        "verified": "2026-09-22 (Eschmeyer's Catalog of Fishes; both entries read)",
    },
]


def norm(text: str) -> str:
    """Normalize exotic whitespace, then collapse runs to single spaces."""
    for bad, good in NBSP_MAP.items():
        text = text.replace(bad, good)
    return re.sub(r"\s+", " ", text).strip()


# ── docx table extraction (stdlib: zipfile + regex over document.xml) ──────────
TR_RE   = re.compile(r"<w:tr[ >].*?</w:tr>", re.S)
TC_RE   = re.compile(r"<w:tc>.*?</w:tc>", re.S)
TEXT_RE = re.compile(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", re.S)
SPAN_RE = re.compile(r'<w:gridSpan w:val="(\d+)"')


def read_table(path: Path) -> tuple[list[list[str]], list[tuple[int, str]]]:
    """Return (species_rows, family_headers).

    species_rows   — 5-cell rows, normalized, excluding the column header.
    family_headers — (row_index, family_name) from gridSpan-merged rows.
    """
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")

    species: list[list[str]] = []
    families: list[tuple[int, str]] = []
    current_family = ""
    seen_header = False

    for tr in TR_RE.findall(xml):
        cells = []
        for tc in TC_RE.findall(tr):
            span = SPAN_RE.search(tc)
            txt = norm(unescape("".join(TEXT_RE.findall(tc))))
            cells.append((txt, int(span.group(1)) if span else 1))

        # Merged row → family header, e.g. "Rajidae—En-hardnose skates, Sp-…, Fr-…"
        if any(s > 1 for _, s in cells):
            label = cells[0][0]
            fam = re.split(r"\s*[-—–]{1,2}\s*En-", label)[0].strip()
            if fam:
                current_family = fam
                families.append((len(species), fam))
            continue

        if len(cells) != 5:
            continue
        row = [t for t, _ in cells]
        if not any(row):
            continue                       # 2 fully blank spacer rows
        if row[0] == "Scientific Name":
            seen_header = True
            continue
        if not seen_header:
            continue
        species.append(row + [current_family])

    return species, families


def parse_common_names(cell: str) -> dict[str, str]:
    """Split the 'Newly proposed common names' cell into en/es/fr.

    Format is 'English / spanish' or 'English / spanish / french'. Title-cased
    parts are English; lowercase parts are Spanish then French. Trailing
    parentheticals and anything after ';' are editorial notes, not names.
    """
    text = cell.strip()
    if text.lower() in NO_CHANGE:
        return {}
    text = text.split(";")[0]                      # drop "…; for the family: …"
    text = re.sub(r"\s*\([^)]*\)", "", text)       # drop "(spelling of … corrected)"
    # Some cells carry ONLY a family-level name (e.g. Galeocerdo cuvieri's
    # "For the family: tiger sharks, tintoreras, requins tigre"). That is not the
    # species' common name — taking it would overwrite "Tiger Shark".
    if re.match(r"(?i)^for the family\b", text.strip()):
        return {}
    parts = [p.strip() for p in text.split("/") if p.strip()]
    if not parts:
        return {}

    out: dict[str, str] = {}
    lower_parts = []
    for p in parts:
        if p[:1].isupper() and "common_name_en" not in out:
            out["common_name_en"] = p
        else:
            lower_parts.append(p)
    if lower_parts:
        out["common_name_es"] = lower_parts[0]
    if len(lower_parts) > 1:
        out["common_name_fr"] = lower_parts[1]
    return out


def modal_class_order(valid_names: dict, family: str) -> tuple[str, str]:
    """Most common (class, order) for a family in the current DB.

    parse_pdf.py's documented page-boundary carry-over bug makes any single
    entry unreliable, so take the mode rather than the first hit.
    """
    counts: dict[tuple[str, str], int] = {}
    for info in valid_names.values():
        if info.get("family") == family:
            key = (info.get("class", ""), info.get("order", ""))
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return "", ""
    return max(counts.items(), key=lambda kv: kv[1])[0]


def build_overlay(rows: list[list[str]], valid_names: dict) -> dict:
    additions, renames, removals, updates, genus_rows, unresolved = [], [], [], [], [], []

    misspellings = []

    for idx, (name, change, occ, common, source, family) in enumerate(rows):
        name = name.strip()
        # Correct transcription errors BEFORE classification: getting the genus
        # right is what turns 'Plectrobranchus evides' from a bogus new species
        # into an occurrence update for the Plectobranchus evides already listed.
        if name in NAME_CORRECTIONS:
            wrong, name = name, NAME_CORRECTIONS[name]
            misspellings.append({
                "as_printed": wrong, "corrected": name,
                "note": CORRECTION_NOTES.get(name, ""),
                "change": change, "source_ref": source, "row": idx,
                "verified": "2026-09-21 (Eschmeyer's Catalog of Fishes)",
            })
        cn = parse_common_names(common)

        # Genus-level rows (Paraliparis spp., Cebidichthys and Esselinichthys spp.)
        m = GENUS_ROW_RE.match(name)
        if m:
            for genus in filter(None, m.groups()):
                genus_rows.append({
                    "genus": genus, "change": change, "family": family or None,
                    "source_ref": source, "row": idx,
                })
            continue

        if not BINOMIAL_RE.match(name):
            unresolved.append({"name": name, "change": change, "row": idx,
                               "why": "not a binomial and not a recognized genus row"})
            continue

        occurrence = occ.strip() if occ.strip().lower() not in NO_CHANGE else None

        if name in RENAMES:
            old = RENAMES[name]
            rec = {"from": old, "to": name, "occurrence": occurrence,
                   "change": change, "source_ref": source, "row": idx}
            # The table's phylogenetic placement is the Committee's; carry it over
            # when it differs (e.g. Galeocerdo cuvieri → the new Galeocerdonidae).
            if family and family != valid_names.get(old, {}).get("family"):
                rec["family"] = family
                # Needed by --check to rebuild the pre-addenda view; without it a
                # re-parse against an already-merged database omits this override
                # and reports a false mismatch.
                rec["from_family"] = valid_names.get(old, {}).get("family", "")
            rec.update({k: v for k, v in cn.items()})
            if name in RENAME_NOTES:
                rec["note"] = RENAME_NOTES[name]
            renames.append(rec)
        elif change == "Remove from List":
            removals.append({
                "name": name,
                "reason": "Removed from the List by the 2025 Addenda "
                          "(no replacement name given).",
                "change": change, "source_ref": source, "row": idx,
            })
        elif name in valid_names:
            # Existing entry — record only the fields that actually move.
            cur = valid_names[name]
            setv, was = {}, {}
            if occurrence and occurrence != cur.get("occurrence"):
                setv["occurrence"] = occurrence
                was["occurrence"] = cur.get("occurrence", "")
            for k, v in cn.items():
                if v and v != cur.get(k):
                    setv[k] = v
                    was[k] = cur.get(k, "")
            # A family delta means the Committee reclassified the genus — capture it
            # even when the Change column doesn't announce it (flagged for review).
            if family and family != cur.get("family"):
                setv["family"] = family
                was["family"] = cur.get("family", "")
            if setv:
                rec = {"name": name, "set": setv, "was": was,
                       "change": change, "source_ref": source, "row": idx}
                if "family" in setv and "family" not in change.lower() \
                        and not change.lower().startswith("we had the gen"):
                    rec["review"] = (
                        f"Family moved {was['family']} -> {setv['family']} based on the "
                        f"table's placement, but the Change column says only "
                        f"{change!r}. Confirm before relying on it."
                    )
                updates.append(rec)
        else:
            rec = {
                "name": name, "family": family,
                "occurrence": occurrence or "", "author": "", "flags": "",
                "common_name_en": cn.get("common_name_en", ""),
                "common_name_es": cn.get("common_name_es", ""),
                "common_name_fr": cn.get("common_name_fr", ""),
                "addenda": "2025",
                "change": change, "source_ref": source, "row": idx,
            }
            cls, order = modal_class_order(valid_names, family)
            rec["class"], rec["order"] = cls, order
            additions.append(rec)

    # Resolve class/order for the 4 addenda-introduced families via their anchors.
    new_families = []
    for fam, meta in NEW_FAMILIES.items():
        anchor = meta["anchor"]
        cls = order = ""
        if anchor and anchor.startswith("family:"):
            cls, order = modal_class_order(valid_names, anchor.split(":", 1)[1])
        elif anchor and " " in anchor:
            info = valid_names.get(anchor, {})
            cls, order = info.get("class", ""), info.get("order", "")
        elif anchor:
            info = next((v for k, v in valid_names.items()
                         if k.startswith(anchor + " ")), {})
            cls, order = info.get("class", ""), info.get("order", "")
        if not cls:
            raise SystemExit(f"ERROR: could not resolve class/order for {fam} "
                             f"via anchor {anchor!r}")
        new_families.append({"family": fam, "class": cls, "order": order,
                             "common_name_en": meta["en"],
                             "common_name_es": meta["es"],
                             "common_name_fr": meta["fr"],
                             "derived_from": anchor})
    for add in additions:
        if not add["class"]:
            for nf in new_families:
                if nf["family"] == add["family"]:
                    add["class"], add["order"] = nf["class"], nf["order"]

    misspellings.sort(key=lambda r: r["as_printed"])
    additions.sort(key=lambda r: r["name"])
    renames.sort(key=lambda r: r["to"])
    updates.sort(key=lambda r: r["name"])
    removals.sort(key=lambda r: r["name"])

    genera_before = {k.split(" ")[0] for k in valid_names}
    after = dict(valid_names)
    for r in renames:
        after.pop(r["from"], None)
        after[r["to"]] = {}
    for r in removals:
        after.pop(r["name"], None)
    for a in additions:
        after[a["name"]] = {}
    genera_after = {k.split(" ")[0] for k in after}

    return {
        "schema_version": 1,
        "data_version": DATA_VERSION,
        "source": {
            "citation": "Schmitter-Soto, J.J., K.E. Bemis, T.E. Dowling, L.T. Findley, "
                        "M.G. Girard, D.A. Hendrickson, K.L. Ilves, K.P. Maslenikov, "
                        "G. Ruiz-Campos, C. Scharpf, and H.J. Walker, Jr. 2026. "
                        "Addenda, corrigenda, et explanenda to Common and Scientific "
                        "Names of Fishes, Eighth Edition. Fisheries 51(5):225-227.",
            "doi": "10.1093/fshmag/vuaf083",
            "supplement": DOCX_PATH.name,
            "note": "Year confirmed as 2026 from the AFS/OUP record (Volume 51, Issue 5, "
                    "May 2026). The PDF itself is inconsistent - a 2025 copyright line, a "
                    "2025 running head, and an advance-access date of 2025-09-16.",
        },
        "generated": datetime.date.today().isoformat(),
        "parser": "parse_addenda.py 1.0",
        "expected": {
            "data_rows": len(rows),
            "additions": len(additions),
            "renames": len(renames),
            "removals": len(removals),
            "updates": len(updates),
            "genus_rows": len(genus_rows),
            "new_families": len(new_families),
            "misspellings_corrected": len(misspellings),
            "species_before": len(valid_names),
            "species_after": len(after),
            "genera_before": len(genera_before),
            "genera_after": len(genera_after),
            "genera_added": sorted(genera_after - genera_before),
            "genera_removed": sorted(genera_before - genera_after),
        },
        "new_families": new_families,
        "additions": additions,
        "renames": renames,
        "updates": updates,
        "removals": removals,
        "genus_rows": genus_rows,
        "misspellings": misspellings,
        "curated_synonyms": CURATED_SYNONYMS,
        "unresolved": unresolved,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="re-parse and diff against the committed JSON; write nothing")
    args = ap.parse_args()

    if not DOCX_PATH.exists():
        print(f"ERROR: {DOCX_PATH} not found (copyrighted source, gitignored).",
              file=sys.stderr)
        return 1

    with open(DB_PATH, encoding="utf-8") as f:
        db = json.load(f)
    valid_names = db["valid_names"]

    rows, families = read_table(DOCX_PATH)
    print(f"Parsed {len(rows)} species rows, {len(families)} family headers")

    # The parser is meant to run against the pristine 8th-edition database. If the
    # overlay is already applied, rebuild the pre-addenda view so a re-parse (and
    # --check) still works: renames go back to their old keys, additions drop out.
    if db.get("metadata", {}).get("data_version"):
        print("  (database already carries the overlay — reconstructing the "
              "pre-addenda view for parsing)")
        prior = json.loads(OUT_PATH.read_text(encoding="utf-8")) if OUT_PATH.exists() else None
        if prior:
            for r in prior["renames"]:
                if r["to"] in valid_names:
                    entry = valid_names.pop(r["to"])
                    if "from_family" in r:
                        entry["family"] = r["from_family"]
                    valid_names[r["from"]] = entry
            for a in prior["additions"]:
                valid_names.pop(a["name"], None)
            for rem in prior["removals"]:
                valid_names.setdefault(rem["name"], {"family": "", "occurrence": "",
                                                     "common_name_en": ""})
            for u in prior["updates"]:
                e = valid_names.get(u["name"])
                if e:
                    for f, was in u.get("was", {}).items():
                        e[f] = was

    # Fail loudly if a curated rename no longer matches the database.
    missing = [old for old in RENAMES.values() if old not in valid_names]
    if missing:
        print(f"ERROR: {len(missing)} rename source(s) not valid in the DB: {missing}",
              file=sys.stderr)
        return 1

    overlay = build_overlay(rows, valid_names)
    e = overlay["expected"]

    print(f"  additions   {e['additions']:4d}")
    print(f"  renames     {e['renames']:4d}")
    print(f"  updates     {e['updates']:4d}")
    print(f"  removals    {e['removals']:4d}")
    print(f"  genus rows  {e['genus_rows']:4d}")
    print(f"  misspellings corrected {e['misspellings_corrected']:2d}")
    print(f"  unresolved  {len(overlay['unresolved']):4d}")
    print(f"  species {e['species_before']} -> {e['species_after']}")
    print(f"  genera  {e['genera_before']} -> {e['genera_after']} "
          f"(+{len(e['genera_added'])} -{len(e['genera_removed'])}: "
          f"{e['genera_removed']})")

    if overlay["unresolved"]:
        print("\nUNRESOLVED rows (must be empty before commit):", file=sys.stderr)
        for u in overlay["unresolved"]:
            print(f"  row {u['row']}: {u['name']!r} — {u['why']}", file=sys.stderr)

    text = json.dumps(overlay, ensure_ascii=False, indent=2) + "\n"

    if args.check:
        if not OUT_PATH.exists():
            print(f"\n--check: {OUT_PATH.name} does not exist yet.", file=sys.stderr)
            return 1
        current = OUT_PATH.read_text(encoding="utf-8")
        if current == text:
            print(f"\n--check: {OUT_PATH.name} is up to date.")
            return 0
        print(f"\n--check: {OUT_PATH.name} DIFFERS from a fresh parse.", file=sys.stderr)
        return 1

    OUT_PATH.write_text(text, encoding="utf-8")
    print(f"\nWrote {OUT_PATH.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
