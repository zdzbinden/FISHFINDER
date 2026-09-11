"""Generate the usage-map basemap: fishfinder/data/world-110m.json

The usage dashboard's map draws its own vector world outline instead of pulling
raster tiles from a third-party service. CARTO's keyless basemap CDN — used
until 2026-09-11 — began stamping "API KEY REQUIRED" across every tile, so the
basemap is now self-hosted: no API key, no external tile host, and one fewer
domain in the Content Security Policy.

Source: Natural Earth 1:110m Admin 0 - Countries (public domain, no attribution
required, though the map credits it anyway).

The raw file is ~840 KB, almost all of it per-country metadata the map never
reads. This strips every property and rounds coordinates to 2 decimals (~1 km at
the equator, far finer than a 300px-tall world map can resolve), which brings it
to ~165 KB (~50 KB gzipped over GitHub Pages).

Usage:
    python make_basemap.py

Standard library only — no dependencies.
"""

import json
import urllib.request
from pathlib import Path

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_110m_admin_0_countries.geojson"
)
OUTPUT = Path(__file__).parent / "fishfinder" / "data" / "world-110m.json"
PRECISION = 2


def round_coords(coords):
    """Recursively round a GeoJSON coordinate structure to PRECISION decimals."""
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], PRECISION), round(coords[1], PRECISION)]
    return [round_coords(c) for c in coords]


def main():
    print(f"Downloading {SOURCE_URL} ...")
    with urllib.request.urlopen(SOURCE_URL) as response:
        source = json.loads(response.read().decode("utf-8"))

    features = [
        {
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": f["geometry"]["type"],
                "coordinates": round_coords(f["geometry"]["coordinates"]),
            },
        }
        for f in source["features"]
        if f.get("geometry")
    ]

    payload = json.dumps(
        {"type": "FeatureCollection", "features": features},
        separators=(",", ":"),
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(payload, encoding="utf-8")

    print(f"Wrote {OUTPUT}")
    print(f"  {len(features)} features, {len(payload):,} bytes")


if __name__ == "__main__":
    main()
