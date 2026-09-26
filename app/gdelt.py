"""Pull GDELT 2.0 event files (every 15 min) and keep material-conflict events."""
import csv
import io
import logging
import re
import time
import zipfile
from datetime import datetime, timedelta, timezone

import httpx

from .config import GDELT_BACKFILL_HOURS, GDELT_WINDOW_HOURS
from .db import db

log = logging.getLogger("gdelt")
BASE = "https://data.gdeltproject.org/gdeltv2/"


# GDELT's machine coding files plenty of non-violent stories as "fight" (a debate, a fire service deal,
# a hurricane). For the incident dots, an article whose URL slug is readable must name some violence;
# URLs without words (numeric ids) must have wider coverage instead.
VIOLENT = re.compile(r"^(kill|attack|strike|airstrik|drone|missil|rocket|shell|bomb|blast|explos|clash|fighting|fighter|"
                     r"gun|shoot|shot|sniper|stab|troop|soldier|army|armies|milit|rebel|insurg|terror|jihad|massacr|"
                     r"hostage|kidnap|abduct|raid|ambush|assault|offensiv|battl|siege|invad|invasion|war|wars|warfare|"
                     r"casualt|wounded|dead|deadly|violen|mortar|artiller|grenade|genocid|ethnic|cleans|riot|"
                     r"isis|hamas|hezbollah|houthi|taliban|wagner|rsf|idf|m23|gang|cartel|guerrill|paramilitar|"
                     r"frontline|ceasefir|firefight|execut|behead|torch|burn|loot|mob|lynch|murder)")
SLUG_STOP = {"news", "world", "article", "story", "stories", "amp", "html", "www", "com", "local", "national",
             "international", "politics", "the", "and", "for", "with", "from", "that", "this", "after", "over"}


def _plausible_incident(url: str, mentions: int, sources: int) -> bool:
    path = re.sub(r"^https?://[^/]+", "", url or "").lower()
    words = [w for w in re.findall(r"[a-z]{3,}", path) if w not in SLUG_STOP]
    if len(words) >= 4:
        return any(VIOLENT.match(w) for w in words)
    return (mentions or 0) >= 5 and (sources or 0) >= 2


def _stamps(hours: int):
    """Every 15-minute stamp for the last N hours, newest first."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    now -= timedelta(minutes=now.minute % 15)
    t = now
    end = now - timedelta(hours=hours)
    while t > end:
        yield t.strftime("%Y%m%d%H%M%S")
        t -= timedelta(minutes=15)


LOCAL_KEEP_HOURS = 24


def _parse(stamp: str, raw: bytes):
    """-> (material-conflict event rows, local-news rows: one city-located point per article of any kind)."""
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = z.namelist()[0]
        text = z.read(name).decode("utf-8", "replace")
    rows, local = [], {}
    for r in csv.reader(io.StringIO(text), delimiter="\t"):
        if len(r) < 61:
            continue
        try:
            quad = int(r[29])
        except ValueError:
            continue
        # local news: any event geocoded to a city (ActionGeo_Type 3 = US city, 4 = world city), keep the
        # most-mentioned one per article; the URL slug has to be readable, it doubles as the headline
        if r[51] in ("3", "4") and r[56] and r[57] and _slug_title(r[60]):
            try:
                cand = (r[60], int(datetime.strptime(r[59], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp()),
                        round(float(r[56]), 4), round(float(r[57]), 4), r[52] or None, r[53] or None,
                        int(r[28]), quad, int(r[31]), float(r[34]))
            except ValueError:
                cand = None
            if cand and (r[60] not in local or cand[8] > local[r[60]][8]):
                local[r[60]] = cand
        if quad != 4:  # material conflict only
            continue
        try:
            lat = float(r[56]) if r[56] else None
            lon = float(r[57]) if r[57] else None
        except ValueError:
            lat = lon = None
        added = datetime.strptime(r[59], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        rows.append((
            int(r[0]), r[1], int(added.timestamp()),
            r[7] or None, r[17] or None,
            int(r[28]), int(r[27]), int(r[26]),
            float(r[30]), int(r[31]), int(r[32]), float(r[34]),
            r[53] or None, r[52] or None, lat, lon, r[60],
        ))
    return rows, list(local.values())


def _slug_title(url: str) -> str | None:
    """A headline from the URL slug ("/2026/09/26/man-stabbed-at-paddington-station" -> "Man stabbed at
    paddington station"), or None when the URL has no readable words."""
    path = re.sub(r"^https?://[^/]+", "", url or "").split("?")[0].rstrip("/")
    best = max(path.split("/"), key=lambda seg: len(re.findall(r"[A-Za-z]{2,}", seg)), default="")
    best = re.sub(r"\.(html?|php|aspx?|cms|ece|shtml)$", "", best, flags=re.I)
    best = re.sub(r"^\d+[.\-_]", "", best)            # "/news/26584775.christine-jardine-..." (Newsquest-style ids)
    words = [w for w in re.split(r"[-_+]+", best) if w and not re.fullmatch(r"[0-9a-f]{6,}|\d+", w, flags=re.I)]
    if len([w for w in words if re.fullmatch(r"[A-Za-z']{2,}", w)]) < 4:
        return None
    t = " ".join(words)
    return t[:1].upper() + t[1:]


def update(max_files: int | None = None):
    with db() as con:
        have = {r[0] for r in con.execute("SELECT stamp FROM gdelt_files")}
    todo = [s for s in _stamps(GDELT_BACKFILL_HOURS) if s not in have]
    if max_files:
        todo = todo[:max_files]
    if not todo:
        return 0
    log.info("fetching %d GDELT files", len(todo))
    n = 0
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        for stamp in todo:
            url = f"{BASE}{stamp}.export.CSV.zip"
            try:
                resp = client.get(url)
            except httpx.HTTPError as e:
                log.warning("%s: %s", stamp, e)
                continue
            if resp.status_code == 404:
                # files appear a few minutes after their timestamp: only give up on one that is hours overdue
                age_h = (datetime.now(timezone.utc) - datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)).total_seconds() / 3600
                if age_h < 3:
                    continue
                rows, local = [], []
            elif resp.status_code != 200:
                log.warning("%s: HTTP %s", stamp, resp.status_code)
                continue
            else:
                try:
                    rows, local = _parse(stamp, resp.content)
                except Exception as e:  # noqa: BLE001
                    log.warning("%s: parse error %s", stamp, e)
                    continue
            with db() as con:
                con.executemany(
                    "INSERT OR IGNORE INTO gdelt_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows
                )
                con.executemany("INSERT OR IGNORE INTO local_news VALUES (?,?,?,?,?,?,?,?,?,?)",
                                [x for x in local if x[1] >= time.time() - LOCAL_KEEP_HOURS * 3600])
                con.execute("INSERT OR REPLACE INTO gdelt_files VALUES (?,?,?)",
                            (stamp, int(time.time()), len(rows)))
            n += len(rows)
    # prune old
    cutoff = int(time.time()) - max(GDELT_WINDOW_HOURS, GDELT_BACKFILL_HOURS) * 3600 - 3600
    with db() as con:
        con.execute("DELETE FROM gdelt_events WHERE added < ?", (cutoff,))
        con.execute("DELETE FROM local_news WHERE added < ?", (int(time.time()) - LOCAL_KEEP_HOURS * 3600,))
    log.info("stored %d conflict events", n)
    return n


# CAMEO root code -> topic shown for a local news item
def local_topic(root: int, quad: int) -> str:
    if root in (18, 19, 20) or root == 17:
        return "violence"
    if root == 14:
        return "protest"
    if root in (15, 16, 13, 12, 11, 10):
        return "tension"
    if quad in (1, 2):
        return "cooperation"
    return "other"


def local_news(w: float, s: float, e: float, n: float, limit: int = 400) -> list[dict]:
    """Located articles of the last 24 h inside a bounding box (w > e means it crosses the antimeridian)."""
    lon_sql = "(lon >= ? AND lon <= ?)" if w <= e else "(lon >= ? OR lon <= ?)"
    try:
        with db() as con:
            rows = con.execute(
                f"SELECT url, added, lat, lon, place, cc, root, quad, mentions FROM local_news "
                f"WHERE lat BETWEEN ? AND ? AND {lon_sql} ORDER BY mentions DESC, added DESC LIMIT ?",
                (s, n, w, e, limit)).fetchall()
    except Exception:  # noqa: BLE001  (a viewer database pushed before this table existed)
        return []
    return [{"url": r["url"], "title": _slug_title(r["url"]), "t": r["added"], "lat": r["lat"], "lon": r["lon"],
             "place": r["place"], "topic": local_topic(r["root"], r["quad"]), "m": r["mentions"]} for r in rows]


def aggregate(hours: int = GDELT_WINDOW_HOURS) -> dict:
    """Per-country heat, point cloud for heatmap, and actor-pair arcs."""
    cutoff = int(time.time()) - hours * 3600
    with db() as con:
        countries = {}
        for r in con.execute(
            "SELECT geo_cc, COUNT(*) c, SUM(mentions) m, AVG(goldstein) g FROM gdelt_events "
            "WHERE added>=? AND geo_cc IS NOT NULL AND root IN (19,20) GROUP BY geo_cc", (cutoff,)):
            countries[r["geo_cc"]] = {"events": r["c"], "mentions": r["m"], "goldstein": round(r["g"], 2)}
        points = [
            [round(r["lon"], 3), round(r["lat"], 3), r["mentions"]]
            for r in con.execute(
                "SELECT lat, lon, mentions FROM gdelt_events WHERE added>=? AND lat IS NOT NULL "
                "AND root IN (19,20) ORDER BY mentions DESC LIMIT 4000", (cutoff,))
        ]
        pairs = [
            {"a1": r["a1"], "a2": r["a2"], "mentions": r["m"], "events": r["c"]}
            for r in con.execute(
                "SELECT a1, a2, SUM(mentions) m, COUNT(*) c FROM gdelt_events "
                "WHERE added>=? AND a1 IS NOT NULL AND a2 IS NOT NULL AND a1<>a2 "
                "GROUP BY a1, a2 ORDER BY m DESC LIMIT 40", (cutoff,))
        ]
        # located violent incidents (fight / mass violence) aggregated per place; the most-mentioned row supplies the source
        agg: dict = {}
        for r in con.execute(
            "SELECT geo_name, geo_cc, ROUND(lat,2) la, ROUND(lon,2) lo, mentions, sources, root, day, url FROM gdelt_events "
            "WHERE added>=? AND lat IS NOT NULL AND root IN (19,20) "
            "AND geo_name LIKE '%,%' "            # country-level geocodes sit on the centroid: nowhere in particular
            "ORDER BY mentions DESC", (cutoff,)):
            if not _plausible_incident(r["url"], r["mentions"], r["sources"]):
                continue
            k = (r["la"], r["lo"])
            a = agg.get(k)
            if a is None:
                agg[k] = {"name": r["geo_name"], "cc": r["geo_cc"], "lat": r["la"], "lon": r["lo"], "n": 1,
                          "m": r["mentions"], "root": r["root"], "day": r["day"], "url": r["url"], "urls": [r["url"]]}
            else:
                a["n"] += 1
                a["m"] += r["mentions"]
                a["root"] = max(a["root"], r["root"])
                a["day"] = max(a["day"], r["day"])
                if len(a["urls"]) < 3 and r["url"] not in a["urls"]:
                    a["urls"].append(r["url"])
        incidents = sorted(agg.values(), key=lambda a: -a["m"])[:2500]
        total = con.execute("SELECT COUNT(*) FROM gdelt_events WHERE added>=?", (cutoff,)).fetchone()[0]
        latest = con.execute("SELECT MAX(added) FROM gdelt_events").fetchone()[0]
    return {"hours": hours, "total": total, "latest": latest,
            "countries": countries, "points": points, "pairs": pairs, "incidents": incidents}
