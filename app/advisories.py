"""Official travel advice per country: UK Foreign Office (FCDO) and US State Department levels.

Shown as published, never re-graded by us. Fetched by the home pipeline at most every 6 h, stored in
the database (state 'travel_advice') and pushed with it."""
import json
import logging
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime

import httpx

from . import countries
from .config import STATIC_DIR
from .db import db, get_state, set_state

log = logging.getLogger("advice")

FCDO_INDEX = "https://www.gov.uk/api/content/foreign-travel-advice"
US_FEED = "https://travel.state.gov/_res/rss/TAsTWs.xml"
REFRESH_HOURS = 6
UA = {"User-Agent": "GlobalNewsMap/1.0 (+https://globalnewsmap.org)"}

# FCDO alert statuses -> 0..4, in the Foreign Office's own words
FCDO_STATUS = {
    "avoid_all_but_essential_travel_to_parts": 1,
    "avoid_all_travel_to_parts": 2,
    "avoid_all_but_essential_travel_to_whole_country": 3,
    "avoid_all_travel_to_whole_country": 4,
}
FCDO_TEXT = {
    0: "No advice against travel",
    1: "Advises against all but essential travel to parts of the country",
    2: "Advises against all travel to parts of the country",
    3: "Advises against all but essential travel to the whole country",
    4: "Advises against all travel to the whole country",
}
US_TEXT = {1: "Exercise normal precautions", 2: "Exercise increased caution", 3: "Reconsider travel", 4: "Do not travel"}

# names the FCDO / State Department use that differ from Natural Earth's
ALIASES = {
    "burma": "MMR", "burma myanmar": "MMR", "myanmar": "MMR", "democratic republic of the congo": "COD",
    "congo democratic republic of the": "COD", "republic of the congo": "COG", "congo": "COG",
    "congo republic of the": "COG", "cote d ivoire": "CIV", "ivory coast": "CIV", "the gambia": "GMB",
    "gambia": "GMB", "the gambia the": "GMB", "occupied palestinian territories": "PSE",
    "israel the west bank and gaza": "ISR", "south korea": "KOR", "korea south": "KOR", "north korea": "PRK",
    "korea north": "PRK", "north korea democratic people s republic of korea": "PRK", "russia": "RUS",
    "syria": "SYR", "laos": "LAO", "macao": "MAC", "macau": "MAC", "vatican city": "VAT",
    "holy see": "VAT", "czech republic": "CZE", "czechia": "CZE", "eswatini": "SWZ", "timor leste": "TLS",
    "cape verde": "CPV", "cabo verde": "CPV", "usa": "USA", "united states": "USA",
    "st lucia": "LCA", "st kitts and nevis": "KNA", "st vincent and the grenadines": "VCT",
    "saint lucia": "LCA", "saint kitts and nevis": "KNA", "saint vincent and the grenadines": "VCT",
    "north macedonia": "MKD", "bahamas": "BHS", "the bahamas": "BHS", "bahamas the": "BHS",
    "micronesia": "FSM", "turkey": "TUR", "turkiye": "TUR", "brunei": "BRN", "vietnam": "VNM",
    "tanzania": "TZA", "bolivia": "BOL", "venezuela": "VEN", "moldova": "MDA", "iran": "IRN",
    "kyrgyzstan": "KGZ", "south sudan": "SDS", "kosovo": "KOS", "taiwan": "TWN", "hong kong": "HKG",
    "gaza": "PSE", "west bank": "PSE", "the west bank": "PSE",
    "sao tome and principe": "STP", "curacao": "CUW", "united kingdom": "GBR", "mainland china": "CHN",
}


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\btravel advice\b", " ", s)
    return re.sub(r"[^a-z]+", " ", s).strip()


def _iso_by_name() -> dict:
    """normalised name -> the map's own country id (ADM0_A3 of the 50m file, which has the small states)."""
    g = json.load(open(STATIC_DIR / "data" / "ne_50m_admin_0_countries.geojson"))
    idx, by_iso = {}, {}
    for f in g["features"]:
        p = f["properties"]
        adm = p["ADM0_A3"]
        by_iso.setdefault(p.get("ISO_A3"), adm)
        by_iso[adm] = adm
        for k in ("NAME_EN", "NAME", "NAME_LONG", "ADMIN", "FORMAL_EN", "GEOUNIT"):
            if p.get(k):
                idx.setdefault(_norm(p[k]), adm)
    for k, v in ALIASES.items():
        idx[k] = by_iso.get(v, v)                  # e.g. PSE -> PSX, the id the map uses
    return idx


def _lookup(names: dict, name: str) -> str | None:
    n = _norm(name)
    return names.get(n) or names.get(_norm(re.sub(r"\(.*?\)", "", name))) or \
        names.get(_norm((re.search(r"\((.*?)\)", name) or [None, ""])[1]))    # "Myanmar (Burma)"


def _fcdo(client: httpx.Client, prev: dict, names: dict) -> dict:
    kids = client.get(FCDO_INDEX).json().get("links", {}).get("children", [])
    prev_by_path = {v["path"]: v for v in prev.values() if v.get("path")}

    def one(k):
        path, updated = k.get("base_path"), k.get("public_updated_at")
        old = prev_by_path.get(path)
        if old and old.get("updated") == updated:
            return old                                   # unchanged since last time
        d = client.get(f"https://www.gov.uk/api/content{path}").json()
        det = d.get("details") or {}
        statuses = det.get("alert_status") or []
        level = max([FCDO_STATUS.get(s, 0) for s in statuses] or [0])
        name = (det.get("country") or {}).get("name") or k.get("title", "").replace(" travel advice", "")
        return {"name": name, "path": path, "url": f"https://www.gov.uk{path}", "updated": updated,
                "level": level, "text": FCDO_TEXT[level],
                "also": "and against all travel to parts" if level == 3 and "avoid_all_travel_to_parts" in statuses else "",
                "change": (det.get("change_description") or "")[:200]}

    with ThreadPoolExecutor(max_workers=6) as ex:
        rows = [r for r in ex.map(one, kids) if r]
    out, missing = {}, []
    for r in rows:
        iso = _lookup(names, r["name"])
        if iso:
            out[iso] = r
        else:
            missing.append(r["name"])
    if missing:
        log.info("FCDO names without a country match: %s", ", ".join(missing))
    return out


def _us(client: httpx.Client, names: dict) -> dict:
    text = client.get(US_FEED).text
    fips = countries.table()["fips"]
    out, missing = {}, []
    for it in re.findall(r"<item>(.*?)</item>", text, re.S):
        title = re.sub(r"\s+", " ", (re.search(r"<title>(.*?)</title>", it, re.S) or [None, ""])[1]).strip()
        m = re.search(r"Level (\d)", title)
        if not m:
            continue
        name = title.split(" - Level")[0].strip()
        cats = re.findall(r"<category[^>]*>(.*?)</category>", it)
        iso = _lookup(names, name) or next((fips[c]["iso3"] for c in cats if len(c) == 2 and c in fips), None)
        if not iso:
            missing.append(name)
            continue
        link = (re.search(r"<link>(.*?)</link>", it, re.S) or [None, ""])[1].strip()
        pub = (re.search(r"<pubDate>(.*?)</pubDate>", it) or [None, ""])[1]
        try:
            updated = parsedate_to_datetime(pub).date().isoformat()
        except (TypeError, ValueError):
            updated = None
        level = int(m.group(1))
        if iso not in out or level > out[iso]["level"]:
            out[iso] = {"name": name, "level": level, "text": US_TEXT.get(level, title), "url": link, "updated": updated}
    if missing:
        log.info("US advisories without a country match: %s", ", ".join(missing))
    return out


def refresh(force: bool = False) -> int:
    with db() as con:
        prev = get_state(con, "travel_advice") or {}
    if not force and time.time() - prev.get("fetched", 0) < REFRESH_HOURS * 3600:
        return 0
    names = _iso_by_name()
    out = {"fetched": int(time.time()), "fcdo": prev.get("fcdo", {}), "us": prev.get("us", {})}
    with httpx.Client(timeout=30, follow_redirects=True, headers=UA) as client:
        try:
            out["fcdo"] = _fcdo(client, prev.get("fcdo", {}), names)
        except Exception as e:  # noqa: BLE001  (keep the last good copy)
            log.warning("FCDO travel advice failed: %s", e)
        try:
            out["us"] = _us(client, names)
        except Exception as e:  # noqa: BLE001
            log.warning("US travel advisories failed: %s", e)
    with db() as con:
        set_state(con, "travel_advice", out)
    log.info("travel advice: %d FCDO, %d US countries", len(out["fcdo"]), len(out["us"]))
    return len(out["fcdo"]) + len(out["us"])


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    refresh(force=True)
