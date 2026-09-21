#!/usr/bin/env python3
"""Apply the 2025 Addenda overlay to a loaded fish_names.json structure.

Library module — no CLI. Imported by:

    apply_addenda.py      the standalone applier
    scrape_eschmeyer.py   re-applies the synonym layer after rebuilding the map

Every script that writes `data["synonyms"]` must call `apply_synonyms()` last, or
a scrape silently reverts the addenda. This generalizes the existing
`extralimital_valids.json` pattern (a filter wired into both writers) from a
filter to a transform.

All functions are idempotent: running them twice is a no-op.
"""
import datetime
import hashlib
import json
from pathlib import Path

ROOT         = Path(__file__).parent
OVERLAY_PATH = ROOT / "addenda_changes.json"

# Mirrors SPECIES_ABBREVS in fishfinder/js/engine.js — an epithet in this set is
# never treated as a species name by the engine, so it must never reach the DB.
SPECIES_ABBREVS = {
    "sp", "spp", "cf", "aff", "nr", "var", "subsp",
    "the", "and", "for", "are", "but", "not", "you", "all",
    "can", "has", "her", "was", "one", "our", "out", "its",
    "with", "that", "have", "from", "this", "will", "been",
    "than", "them", "into", "also", "each", "which", "their",
    "were", "other", "about", "these", "would", "there",
    "after", "between", "found", "used", "where", "most",
    "using", "during", "including", "however",
}

# Fields copied onto a renamed entry when the overlay supplies them.
OVERRIDE_FIELDS = ("family", "occurrence", "common_name_en",
                   "common_name_es", "common_name_fr")


def load_overlay(path: Path = OVERLAY_PATH) -> dict | None:
    """Load the overlay, or None when it is absent (pre-addenda builds)."""
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        ov = json.load(f)
    if ov.get("schema_version") != 1:
        raise SystemExit(f"ERROR: unsupported overlay schema_version "
                         f"{ov.get('schema_version')!r}")
    if ov.get("unresolved"):
        raise SystemExit(f"ERROR: overlay has {len(ov['unresolved'])} unresolved rows; "
                         f"resolve them before applying.")
    return ov


def overlay_sha256(path: Path = OVERLAY_PATH) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def is_applied(data: dict, ov: dict) -> bool:
    """True when the taxonomy layer is already fully present."""
    vn = data["valid_names"]
    return (all(r["to"] in vn and r["from"] not in vn for r in ov["renames"])
            and all(a["name"] in vn for a in ov["additions"])
            and all(r["name"] not in vn for r in ov["removals"]))


# ── Phase A: taxonomy ─────────────────────────────────────────────────────────
def apply_taxonomy(data: dict, ov: dict, log=print) -> dict:
    """Mutate valid_names / genera / removed_names. Returns a counter dict."""
    vn = data["valid_names"]
    stats = {"updated": 0, "renamed": 0, "added": 0, "removed": 0,
             "skipped_update": 0, "drift": 0}

    # A1 — in-place updates FIRST. This vacates the common names that the new
    # Dionda species are about to claim; without it, commonNameMap's
    # last-writer-wins would silently drop a species from common-name lookup.
    for u in ov["updates"]:
        entry = vn.get(u["name"])
        if entry is None:
            stats["skipped_update"] += 1
            continue
        for field, want in u["set"].items():
            had = u.get("was", {}).get(field)
            if had is not None and entry.get(field) not in (had, want):
                log(f"  DRIFT {u['name']}.{field}: expected {had!r}, "
                    f"found {entry.get(field)!r}")
                stats["drift"] += 1
            entry[field] = want
        stats["updated"] += 1

    # A2 — renames. Old key leaves valid_names; the new key inherits everything
    # (including flags: `*` means "changed since the 7th edition" and stays true).
    for r in ov["renames"]:
        frm, to = r["from"], r["to"]
        if frm in vn:
            entry = vn.pop(frm)
        elif to in vn:
            entry = vn[to]                      # already applied
        else:
            raise SystemExit(f"ERROR: rename {frm} -> {to}: neither key present")
        for field in OVERRIDE_FIELDS:
            if r.get(field):
                entry[field] = r[field]
        entry["addenda"] = "2025"
        vn[to] = entry
        stats["renamed"] += 1

    # A3 — additions.
    for a in ov["additions"]:
        name = a["name"]
        entry = {
            "class": a["class"], "order": a["order"], "family": a["family"],
            "author": a.get("author", ""), "occurrence": a["occurrence"],
            "flags": a.get("flags", ""),
            "common_name_en": a["common_name_en"],
            "common_name_es": a["common_name_es"],
            "common_name_fr": a["common_name_fr"],
            "addenda": "2025",
        }
        if name in vn and vn[name] != entry:
            # Re-run after a scrape may have added an author; keep the richer value.
            entry["author"] = vn[name].get("author") or entry["author"]
        vn[name] = entry
        stats["added"] += 1

    # A4 — removals. removed_names is TOP-LEVEL because engine.js never reads
    # db.metadata; a per-entry explanation has to live where the engine can see it.
    removed = data.setdefault("removed_names", {})
    for r in ov["removals"]:
        vn.pop(r["name"], None)
        removed[r["name"]] = {
            "reason": r["reason"],
            "source": ov["source"]["citation"],
            "data_version": ov["data_version"],
        }
        stats["removed"] += 1

    # A5 — genus-level family moves (Cebidichthys, Esselinichthys, Kasatkia,
    # Lumpenopsis; Paraliparis carries a French-name note only).
    for g in ov.get("genus_rows", []):
        fam = g.get("family")
        if not fam:
            continue
        prefix = g["genus"] + " "
        for k, v in vn.items():
            if k.startswith(prefix):
                v["family"] = fam

    # A6 — DERIVE genera; never hand-maintain. engine.js builds generaSet from this
    # array alone, so a patched array can silently drift from valid_names.
    data["genera"] = sorted({k.split(" ")[0] for k in vn})

    return stats


# ── Phase B: synonyms ─────────────────────────────────────────────────────────
def apply_synonyms(data: dict, ov: dict, log=print) -> dict:
    """Mutate data["synonyms"]. Safe to call on a freshly rebuilt map."""
    syn = data.setdefault("synonyms", {})
    vn = data["valid_names"]
    demotions = {r["from"]: r["to"] for r in ov["renames"]}
    stats = {"demoted": 0, "retargeted": 0, "conflicts_removed": 0,
             "curated": 0, "misspellings": 0, "dangling_dropped": 0}

    # B1 — the demoted 8th-edition names become synonyms of their replacements.
    for frm, to in demotions.items():
        syn[frm] = to
        stats["demoted"] += 1

    # B2 — retarget inbound edges, transitively. 22 edges over 13 targets today,
    # all depth-1 (Raia rhina -> Beringraja rhina -> Caliraja rhina), but a chained
    # demotion would need another pass, so iterate to a fixpoint.
    for _ in range(8):
        changed = 0
        for old, tgt in list(syn.items()):
            if tgt in demotions and demotions[tgt] != old:
                syn[old] = demotions[tgt]
                changed += 1
        stats["retargeted"] += changed
        if not changed:
            break
    else:
        raise SystemExit("ERROR: synonym retargeting did not converge (cycle?)")

    # B3 — enforce valid ∩ synonyms = ∅. classifyName checks valid before synonym
    # (engine.js:104 vs :114), so any overlap makes the synonym entry unreachable.
    # This is what promotes Urotrygon asterias — no special case needed.
    expected_conflicts = {c["name"] for c in ov.get("synonym_conflicts", [])} or \
                         {r["to"] for r in ov["renames"]}
    for k in [k for k in syn if k in vn]:
        del syn[k]
        stats["conflicts_removed"] += 1
        if k not in expected_conflicts:
            log(f"  NOTE unanticipated valid/synonym conflict removed: {k}")

    # B4 — curated synonyms: pairs present in the shipped build but missing from
    # eschmeyer_cache.json, re-asserted so a full rebuild is lossless.
    for c in ov.get("curated_synonyms", []):
        if c["old"] in vn:
            continue
        syn[c["old"]] = c["new"]
        stats["curated"] += 1

    # B4b — the supplementary table's transcription errors. The published spelling
    # is the valid name; the table's spelling resolves to it, so a reader working
    # straight from the addenda still lands on the right species.
    for m in ov.get("misspellings", []):
        printed, correct = m["as_printed"], m["corrected"]
        if printed in vn or correct not in vn:
            continue
        syn[printed] = correct
        stats["misspellings"] = stats.get("misspellings", 0) + 1

    # B5 — no dangling targets. A synonym pointing at a non-valid name gives the
    # user a suggestion they cannot act on.
    for old, tgt in list(syn.items()):
        if tgt not in vn:
            if tgt in demotions and demotions[tgt] in vn:
                syn[old] = demotions[tgt]
            else:
                del syn[old]
                stats["dangling_dropped"] += 1
                log(f"  DROPPED dangling synonym {old} -> {tgt}")

    return stats


def stamp_metadata(data: dict, ov: dict, applied: dict | None = None) -> None:
    md = data.setdefault("metadata", {})
    md["data_version"] = ov["data_version"]
    md["species_count"] = len(data["valid_names"])
    md["synonym_count"] = len(data.get("synonyms", {}))
    md["addenda"] = {
        "data_version": ov["data_version"],
        "citation": ov["source"]["citation"],
        "doi": ov["source"]["doi"],
        "applied_date": datetime.date.today().isoformat(),
        "overlay_sha256": overlay_sha256(),
        "species_added": len(ov["additions"]),
        "species_renamed": len(ov["renames"]),
        "species_removed": len(ov["removals"]),
        "entries_updated": len(ov["updates"]),
    }
    if applied:
        md["addenda"].update({k: v for k, v in applied.items() if v})


# ── Invariants ────────────────────────────────────────────────────────────────
def check_invariants(data: dict, ov: dict) -> list[str]:
    """Return a list of failures; empty means the build is sound."""
    vn, syn = data["valid_names"], data.get("synonyms", {})
    errs: list[str] = []
    exp = ov.get("expected", {})

    overlap = set(vn) & set(syn)
    if overlap:
        errs.append(f"{len(overlap)} names are both valid and synonyms: "
                    f"{sorted(overlap)[:5]}")

    dangling = [f"{o} -> {t}" for o, t in syn.items() if t not in vn]
    if dangling:
        errs.append(f"{len(dangling)} dangling synonym targets: {dangling[:5]}")

    derived = sorted({k.split(" ")[0] for k in vn})
    if data.get("genera") != derived:
        errs.append("genera array is out of sync with valid_names")

    seen: dict[str, str] = {}
    collisions = []
    for name, info in vn.items():
        cn = (info.get("common_name_en") or "").lower()
        if not cn:
            continue
        if cn in seen:
            collisions.append(f"{seen[cn]} / {name} both = {cn!r}")
        seen[cn] = name
    if collisions:
        errs.append(f"{len(collisions)} English common-name collisions "
                    f"(last-writer-wins would drop one): {collisions[:5]}")

    bad_shape = []
    for name in vn:
        parts = name.split(" ")
        if len(parts) != 2 or not name.isascii():
            bad_shape.append(name)
        elif len(parts[1]) < 3 or parts[1].lower() in SPECIES_ABBREVS:
            bad_shape.append(name)
    if bad_shape:
        errs.append(f"{len(bad_shape)} names the engine cannot classify: "
                    f"{bad_shape[:5]}")

    if exp.get("species_after") and len(vn) != exp["species_after"]:
        errs.append(f"species_count {len(vn)} != expected {exp['species_after']}")
    if exp.get("genera_after") and len(data.get("genera", [])) != exp["genera_after"]:
        errs.append(f"genera {len(data.get('genera', []))} != "
                    f"expected {exp['genera_after']}")

    md = data.get("metadata", {})
    if md.get("species_count") != len(vn):
        errs.append("metadata.species_count does not match valid_names")
    if md.get("synonym_count") != len(syn):
        errs.append("metadata.synonym_count does not match synonyms")

    return errs
