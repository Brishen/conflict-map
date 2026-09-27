"""Russian-occupied territory in Ukraine from DeepStateMap.Live, fetched once a day.

Only the occupied areas (incl. Crimea and the areas held since 2014) and the grey "unknown status" zones
are kept; DeepStateMap's other polygons (historic liberations, political claims elsewhere) are dropped.
Each day's total occupied area is kept as a small history so the map can show the change."""
import logging
import math
import time
from datetime import datetime, timezone

import httpx

from .db import db, get_state, set_state

log = logging.getLogger("territory")

SOURCE_URL = "https://deepstatemap.live/api/history/last"
REFRESH_HOURS = 24
HISTORY_DAYS = 120
UA = {"User-Agent": "GlobalNewsMap/1.0 (+https://globalnewsmap.org)"}
# DeepStateMap names are "Ukrainian /// English /// key"; English name -> kind shown on our map
KINDS = {"Occupied": "occupied", "Occupied Crimea": "occupied", "CADR and CALR": "occupied",
         "Occupied Tuzla Island": "occupied", "Unknown status": "contested"}
R = 6378137.0


def _ring_area(ring) -> float:
    """Area of a lon/lat ring on the sphere, m² (the same formula turf.js uses)."""
    total = 0.0
    for (x1, y1, *_), (x2, y2, *_) in zip(ring, ring[1:] + ring[:1]):
        total += math.radians(x2 - x1) * (2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2)))
    return abs(total * R * R / 2)


def _polygon_km2(rings) -> float:
    return max(0.0, _ring_area(rings[0]) - sum(_ring_area(r) for r in rings[1:])) / 1e6


def _clean(feature: dict) -> dict | None:
    name = (feature.get("properties") or {}).get("name") or ""
    parts = [p.strip() for p in name.split("///")]
    kind = KINDS.get(parts[1] if len(parts) > 1 else parts[0])
    geom = feature.get("geometry") or {}
    if not kind or geom.get("type") != "Polygon":
        return None
    rings = [[[round(pt[0], 4), round(pt[1], 4)] for pt in ring] for ring in geom["coordinates"] if len(ring) >= 4]
    if not rings:
        return None
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": rings},
            "properties": {"kind": kind, "km2": round(_polygon_km2(rings))}}


def refresh(force: bool = False) -> int:
    """Fetch the current map if the stored copy is older than REFRESH_HOURS; returns features stored."""
    with db() as con:
        prev = get_state(con, "territory") or {}
    if not force and time.time() - prev.get("fetched", 0) < REFRESH_HOURS * 3600:
        return 0
    with httpx.Client(timeout=60, follow_redirects=True, headers=UA) as client:
        r = client.get(SOURCE_URL)
        r.raise_for_status()
        data = r.json()
    feats = [f for f in (_clean(f) for f in (data.get("map") or {}).get("features") or []) if f]
    if not any(f["properties"]["kind"] == "occupied" for f in feats):
        raise ValueError("no occupied areas in the DeepStateMap response; keeping the last good copy")
    map_id = data.get("id")
    as_of = datetime.fromtimestamp(map_id, timezone.utc).strftime("%Y-%m-%d") if isinstance(map_id, int) else None
    occupied = round(sum(f["properties"]["km2"] for f in feats if f["properties"]["kind"] == "occupied"))
    contested = round(sum(f["properties"]["km2"] for f in feats if f["properties"]["kind"] == "contested"))
    # one history entry per DeepStateMap update date: a newer fetch of the same date replaces it
    history = [h for h in prev.get("history", []) if h.get("date") != as_of] + [{"date": as_of, "occupied_km2": occupied}]
    history = sorted((h for h in history if h.get("date")), key=lambda h: h["date"])[-HISTORY_DAYS:]
    out = {"fetched": int(time.time()), "map_id": map_id, "as_of": as_of, "occupied_km2": occupied,
           "contested_km2": contested, "history": history, "geojson": {"type": "FeatureCollection", "features": feats}}
    with db() as con:
        set_state(con, "territory", out)
    log.info("territory: %d areas, %d km² occupied, %d km² unknown status, as of %s", len(feats), occupied, contested, as_of)
    return len(feats)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    refresh(force=True)
