"""Weather mode: the weather over the world and over the fighting.

- rain: RainViewer's radar and satellite mosaic, loaded by the page straight from RainViewer (not stored here);
- storms, floods and wildfires: GDACS (UN / European Commission) current events, cyclone tracks and cones included;
- conditions: Open-Meteo's current weather at every capital and at each conflict's epicentre, with the next two
  days for the conflicts (rain, wind and cloud matter for drones, aircraft and the roads). Fetched at most hourly:
  the free Open-Meteo tier is 10,000 locations a day."""
import json
import logging
import time

import httpx

from . import countries
from .config import STATIC_DIR
from .db import all_conflicts, db, get_state, set_state

log = logging.getLogger("weather")
UA = {"User-Agent": "Mozilla/5.0 conflict-map/0.1 (+https://globalnewsmap.org)"}
GDACS = "https://www.gdacs.org/gdacsapi/api"
KINDS = {"TC": "cyclone", "FL": "flood", "WF": "wildfire", "DR": "drought"}   # earthquakes and volcanoes aren't weather
CONDITIONS_EVERY = 55 * 60
CURRENT = "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover,is_day"
DAILY = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_gusts_10m_max"


def _r(coords, nd=2):
    """Round nested coordinates: GDACS sends 6+ decimals, a map needs two."""
    if isinstance(coords, (int, float)):
        return round(coords, nd)
    return [_r(c, nd) for c in coords]


# ---------------------------------------------------------------- GDACS
def _storm_geometry(ev: dict) -> list[dict]:
    """Track (past solid, forecast dashed) and the forecast cone of one cyclone."""
    r = httpx.get(f"{GDACS}/polygons/getgeometry", params={"eventtype": "TC", "eventid": ev["id"], "episodeid": ev["episode"]},
                  headers=UA, timeout=30)
    r.raise_for_status()
    out = []
    for f in r.json().get("features") or []:
        p, g = f.get("properties") or {}, f.get("geometry") or {}
        cls = p.get("Class") or ""
        if cls.startswith("Line_") and g.get("type") == "LineString":
            out.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": _r(g["coordinates"])},
                        "properties": {"part": "track", "id": ev["id"], "forecast": bool(p.get("forecast")),
                                       "cat": p.get("polygonlabel") or "", "alert": ev["alert"]}})
        elif cls == "Poly_Cones" and g.get("type") in ("Polygon", "MultiPolygon"):
            out.append({"type": "Feature", "geometry": {"type": g["type"], "coordinates": _r(g["coordinates"])},
                        "properties": {"part": "cone", "id": ev["id"], "alert": ev["alert"]}})
    return out


def refresh_hazards() -> int:
    try:
        r = httpx.get(f"{GDACS}/events/geteventlist/EVENTS4APP", headers=UA, timeout=45)
        r.raise_for_status()
        feats = r.json().get("features") or []
    except (httpx.HTTPError, ValueError) as e:
        log.warning("gdacs: %s", e)
        return 0
    events = []
    for f in feats:
        p = f.get("properties") or {}
        kind = KINDS.get(p.get("eventtype"))
        coords = (f.get("geometry") or {}).get("coordinates")
        if not kind or str(p.get("iscurrent")).lower() != "true" or not coords:
            continue
        isos = [countries.iso3(c.get("iso3")) for c in p.get("affectedcountries") or []]
        events.append({"kind": kind, "id": p.get("eventid"), "episode": p.get("episodeid"),
                       "name": p.get("eventname") or p.get("name"), "title": p.get("name"),
                       "alert": (p.get("alertlevel") or "Green").lower(), "score": p.get("alertscore"),
                       "from": p.get("fromdate"), "to": p.get("todate"),
                       "countries": [c for c in dict.fromkeys(isos) if c], "place": p.get("country") or "",
                       "lon": round(coords[0], 2), "lat": round(coords[1], 2),
                       "severity": (p.get("severitydata") or {}).get("severitytext") or "",
                       "report": (p.get("url") or {}).get("report")})
    storms = []
    for ev in events:
        if ev["kind"] == "cyclone":
            try:
                storms += _storm_geometry(ev)
            except (httpx.HTTPError, ValueError) as e:
                log.warning("gdacs track %s: %s", ev["name"], e)
    with db() as con:
        set_state(con, "weather_hazards", {"updated": int(time.time()), "events": events,
                                           "storms": {"type": "FeatureCollection", "features": storms}})
    return len(events)


# ---------------------------------------------------------------- Open-Meteo
def _capitals() -> list[dict]:
    g = json.load(open(STATIC_DIR / "data" / "places.geojson"))
    out, seen = [], set()
    for f in g["features"]:
        p = f["properties"]
        iso = countries.iso3(p.get("adm0_a3"))
        if p.get("adm0cap") != 1 or not iso or iso in seen:
            continue
        seen.add(iso)
        out.append({"iso3": iso, "name": p.get("name"), "lat": round(p["latitude"], 3), "lon": round(p["longitude"], 3)})
    return out


def _meteo(points: list[dict], daily: bool) -> list[dict | None]:
    out = []
    for i in range(0, len(points), 100):
        chunk = points[i:i + 100]
        params = {"latitude": ",".join(str(p["lat"]) for p in chunk), "longitude": ",".join(str(p["lon"]) for p in chunk),
                  "current": CURRENT, "timezone": "UTC", "wind_speed_unit": "kmh"}
        if daily:
            params.update(daily=DAILY, forecast_days=3)
        r = httpx.get("https://api.open-meteo.com/v1/forecast", params=params, headers=UA, timeout=60)
        r.raise_for_status()
        data = r.json()
        out += data if isinstance(data, list) else [data]
    return out


def _now(x: dict) -> dict:
    c = x.get("current") or {}
    return {"t": c.get("temperature_2m"), "feels": c.get("apparent_temperature"), "code": c.get("weather_code"),
            "wind": c.get("wind_speed_10m"), "gust": c.get("wind_gusts_10m"), "rain": c.get("precipitation"),
            "cloud": c.get("cloud_cover"), "day": bool(c.get("is_day"))}


def refresh_conditions(force: bool = False) -> int:
    with db() as con:
        last = get_state(con, "weather_conditions")
        conflicts = all_conflicts(con)
    if not force and last and time.time() - last.get("updated", 0) < CONDITIONS_EVERY:
        return 0
    caps = _capitals()
    fronts = []
    for c in conflicts:
        ep = c.get("epicenter") or {}
        if isinstance(ep, dict) and ep.get("lat") is not None and ep.get("lon") is not None:
            fronts.append({"id": c["id"], "name": c.get("name"), "label": ep.get("label") or "",
                           "lat": round(float(ep["lat"]), 3), "lon": round(float(ep["lon"]), 3)})
    try:
        cap_w = _meteo(caps, daily=False)
        front_w = _meteo(fronts, daily=True) if fronts else []
    except (httpx.HTTPError, ValueError) as e:
        log.warning("open-meteo: %s", e)
        return 0
    capitals = [{**p, **_now(w)} for p, w in zip(caps, cap_w) if w and w.get("current")]
    out_fronts = []
    for p, w in zip(fronts, front_w):
        if not w or not w.get("current"):
            continue
        d = w.get("daily") or {}
        days = [{"date": day, "code": (d.get("weather_code") or [None] * 3)[i], "max": (d.get("temperature_2m_max") or [None] * 3)[i],
                 "min": (d.get("temperature_2m_min") or [None] * 3)[i], "rain": (d.get("precipitation_sum") or [None] * 3)[i],
                 "gust": (d.get("wind_gusts_10m_max") or [None] * 3)[i]} for i, day in enumerate(d.get("time") or [])]
        out_fronts.append({**p, **_now(w), "days": days})
    with db() as con:
        set_state(con, "weather_conditions", {"updated": int(time.time()), "capitals": capitals, "conflicts": out_fronts})
    return len(capitals) + len(out_fronts)


def refresh() -> dict:
    """Each failure is logged and the last good copy stays."""
    out = {}
    for name, fn in (("hazards", refresh_hazards), ("conditions", refresh_conditions)):
        try:
            out[name] = fn()
        except Exception as e:  # noqa: BLE001
            log.exception("weather %s failed", name)
            out[name + "_error"] = str(e)
    return out


# ---------------------------------------------------------------- what the page gets
def view() -> dict:
    with db() as con:
        hazards = get_state(con, "weather_hazards") or {"updated": None, "events": [], "storms": {"type": "FeatureCollection", "features": []}}
        conditions = get_state(con, "weather_conditions") or {"updated": None, "capitals": [], "conflicts": []}
    return {"hazards": hazards, "conditions": conditions, "now": int(time.time())}


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    print(refresh_hazards(), refresh_conditions(force="force" in sys.argv[1:]))
