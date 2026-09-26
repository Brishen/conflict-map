import asyncio
import gzip
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import aircraft, countries, ships, gdelt, livetv, pipeline, reader
from .config import AIRCRAFT_ENABLED, DATA_DIR, GDELT_WINDOW_HOURS, REFRESH_MINUTES, SERVE_ONLY, STATIC_DIR
from .db import all_conflicts, db, get_state, store_report

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("server")
app = FastAPI(title="conflict-map")
_lock = threading.Lock()
_agg_cache: dict = {}


def _aggregate_cached(hours: int):
    now = time.time()
    hit = _agg_cache.get(hours)
    if hit and now - hit[0] < 60:
        return hit[1]
    data = gdelt.aggregate(hours)
    _agg_cache[hours] = (now, data)
    return data


def _refresh_job(skip_llm=False):
    if not _lock.acquire(blocking=False):
        return {"busy": True}
    try:
        return pipeline.refresh(skip_llm=skip_llm)
    finally:
        _lock.release()


async def _loop():
    await asyncio.sleep(5)
    while True:
        await asyncio.to_thread(_refresh_job)
        await asyncio.sleep(REFRESH_MINUTES * 60)


@app.on_event("startup")
async def _start():
    if AIRCRAFT_ENABLED:
        threading.Thread(target=aircraft.run_forever, name="aircraft", daemon=True).start()
    threading.Thread(target=ships.run_forever, name="ships", daemon=True).start()
    if SERVE_ONLY:
        log.info("SERVE_ONLY: viewer mode, no pipeline")
        return
    asyncio.create_task(_loop())


@app.get("/healthz")
def healthz():
    with db() as con:
        n = con.execute("SELECT COUNT(*) FROM conflicts").fetchone()[0]
    return {"ok": True, "conflicts": n, "serve_only": SERVE_ONLY}


def build_state(hours: int, strike_days: int) -> dict:
    since = (datetime.now(timezone.utc) - timedelta(days=strike_days)).strftime("%Y-%m-%d")
    with db() as con:
        conflicts = all_conflicts(con)
        d7 = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
        d14 = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%d")
        activity = {r[0]: {"attacks_7d": r[1], "attacks_prev_7d": r[2]} for r in con.execute(
            "SELECT conflict_id, SUM(date > ?), SUM(date > ? AND date <= ?) FROM strikes GROUP BY conflict_id", (d7, d14, d7))}
        strikes = [dict(r) for r in con.execute(
            "SELECT * FROM strikes WHERE date >= ? ORDER BY date DESC, id DESC LIMIT 600", (since,))]
        meta = {
            "last_refresh": get_state(con, "last_refresh"),
            "last_extract": get_state(con, "last_extract"),
            "unprocessed": con.execute("SELECT COUNT(*) FROM articles WHERE processed=0").fetchone()[0],
            "articles": con.execute("SELECT COUNT(*) FROM articles").fetchone()[0],
            "skipped": con.execute("SELECT COUNT(*) FROM articles WHERE processed=2").fetchone()[0],
            "sources": con.execute("SELECT COUNT(DISTINCT source) FROM articles WHERE published > strftime('%s','now') - 7*86400").fetchone()[0],
            "busy": _lock.locked(),
            "serve_only": SERVE_ONLY,
            "attacks_since": con.execute("SELECT MIN(created) FROM strikes").fetchone()[0],
            "now": int(time.time()),
        }
    agg = _aggregate_cached(hours)
    tbl = countries.table()
    # translate GDELT FIPS -> ISO3 and CAMEO pairs -> ISO3 with centroids
    heat = {}
    for fips, v in agg["countries"].items():
        rec = tbl["fips"].get(fips)
        if rec:
            h = heat.setdefault(rec["iso3"], {"events": 0, "mentions": 0})
            h["events"] += v["events"]
            h["mentions"] += v["mentions"]
    pairs = []
    for p in agg["pairs"]:
        a, b = countries.iso3(p["a1"]), countries.iso3(p["a2"])
        if a and b and a != b:
            pairs.append({"a": a, "b": b, "mentions": p["mentions"], "events": p["events"]})
    incidents = []
    for i in agg["incidents"]:
        rec = tbl["fips"].get(i["cc"])
        incidents.append({**i, "iso3": rec["iso3"] if rec else None})
    for c in conflicts:
        c["activity"] = activity.get(c["id"], {"attacks_7d": 0, "attacks_prev_7d": 0})
    conflicts.sort(key=lambda c: (-(c.get("severity") or 0), -(c.get("last_seen") or 0)))
    return {
        "meta": meta,
        "conflicts": conflicts,
        "strikes": strikes,
        "gdelt": {"hours": agg["hours"], "total": agg["total"], "latest": agg["latest"],
                  "heat": heat, "points": agg["points"], "pairs": pairs, "incidents": incidents},
    }


# ---- /api/state is the same for every visitor until the data changes: build it once,
# ---- keep a gzipped copy, and let browsers revalidate with an ETag (304, no body)
_state_cache: dict = {}
_state_lock = threading.Lock()
STATE_MIN_AGE = 30          # seconds; in pipeline mode the db changes often, don't rebuild more than this


def _db_version() -> float:
    from .config import DB_PATH
    v = 0.0
    for suffix in ("", "-wal"):
        try:
            v = max(v, os.stat(str(DB_PATH) + suffix).st_mtime)
        except OSError:
            pass
    return v


def _cached_state(hours: int, strike_days: int) -> dict:
    key = (hours, strike_days)
    ver, now = _db_version(), time.time()
    hit = _state_cache.get(key)
    if hit and (hit["ver"] == ver or now - hit["built"] < STATE_MIN_AGE):
        return hit
    with _state_lock:                                   # one rebuild at a time; others reuse it
        hit = _state_cache.get(key)
        if hit and (hit["ver"] == ver or time.time() - hit["built"] < STATE_MIN_AGE):
            return hit
        body = json.dumps(build_state(hours, strike_days), separators=(",", ":"), ensure_ascii=False).encode()
        entry = {"ver": ver, "built": time.time(), "body": body, "gz": gzip.compress(body, 6),
                 "etag": '"' + hashlib.sha1(body).hexdigest()[:20] + '"'}
        _state_cache[key] = entry
        return entry


@app.get("/api/state")
def state(request: Request, hours: int = GDELT_WINDOW_HOURS, strike_days: int = 7):
    hours = max(1, min(hours, 168))
    strike_days = max(1, min(strike_days, 30))
    e = _cached_state(hours, strike_days)
    headers = {"ETag": e["etag"], "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
    if request.headers.get("if-none-match") == e["etag"]:
        return Response(status_code=304, headers=headers)
    if "gzip" in request.headers.get("accept-encoding", ""):
        return Response(e["gz"], media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})
    return Response(e["body"], media_type="application/json", headers=headers)


_article_hits: dict[str, list[float]] = {}
_article_sem = asyncio.Semaphore(4)
ARTICLE_LIMIT = (20, 60)          # uncached article fetches per client per 60 s


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


@app.get("/api/article")
async def article(request: Request, url: str):
    if len(url) > 2000:
        return JSONResponse({"ok": False, "error": "bad url"}, status_code=400)
    if reader.cached(url):
        return reader.fetch(url)
    ip, now = _client_ip(request), time.time()
    hits = [t for t in _article_hits.get(ip, []) if now - t < ARTICLE_LIMIT[1]]
    if len(hits) >= ARTICLE_LIMIT[0]:
        return JSONResponse({"ok": False, "error": "too many articles opened in a minute, try again shortly"},
                            status_code=429, headers={"Retry-After": "30"})
    hits.append(now)
    _article_hits[ip] = hits
    if len(_article_hits) > 5000:                       # forget idle clients
        for k in [k for k, v in _article_hits.items() if now - v[-1] > 120]:
            _article_hits.pop(k, None)
    async with _article_sem:
        return await asyncio.to_thread(reader.fetch, url)


@app.get("/api/aircraft")
def aircraft_view():
    if not AIRCRAFT_ENABLED:
        return {"enabled": False, "aircraft": []}
    return {"enabled": True, **aircraft.tracker.view()}


@app.get("/api/ships")
def ships_view():
    return ships.fleet.view()


@app.get("/api/countries")
def country_table():
    return countries.table()["iso3"]


@app.post("/api/refresh")
async def refresh(skip_llm: bool = False):
    if SERVE_ONLY:
        return JSONResponse({"error": "viewer mode: refreshes run on the home pipeline"}, status_code=403)
    asyncio.create_task(asyncio.to_thread(_refresh_job, skip_llm))
    return {"started": not _lock.locked()}


@app.get("/api/local-news")
async def local_news(w: float, s: float, e: float, n: float):
    items = await asyncio.to_thread(gdelt.local_news, w, s, e, n)
    return JSONResponse({"items": items}, headers={"Cache-Control": "max-age=60"})


@app.get("/api/live-tv")
async def live_tv():
    data = await asyncio.to_thread(livetv.channels)
    return JSONResponse({"channels": data}, headers={"Cache-Control": "max-age=120"})


# ---- who is here now: each open, visible tab pings with a random per-tab id; nothing else is kept
PRESENCE_TTL = 70            # seconds without a ping before a tab stops counting (tabs ping every 25 s)
_presence: dict[str, tuple[float, str]] = {}   # tab id -> (last ping, conflict id it has open or "")


@app.post("/api/presence")
async def presence(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    sid = str(body.get("id") or "")[:40]
    view = str(body.get("view") or "")
    view = view if re.fullmatch(r"[a-z0-9-]{1,64}", view) else ""
    now = time.time()
    for k in [k for k, (t, _) in _presence.items() if now - t > PRESENCE_TTL]:
        _presence.pop(k, None)
    if sid and len(sid) >= 8:
        if body.get("leave"):
            _presence.pop(sid, None)
        elif sid in _presence or len(_presence) < 20000:   # cap so junk ids can't grow memory
            _presence[sid] = (now, view)
    views: dict[str, int] = {}
    for _, v in _presence.values():
        if v:
            views[v] = views.get(v, 0) + 1
    return JSONResponse({"online": len(_presence), "views": views}, headers={"Cache-Control": "no-store"})


# ---- "Report a problem": visitors flag wrong locations, non-conflicts, wrong sides. Nothing is shown publicly.
# The public viewer's database is replaced on every push, so there reports go to a separate file that the
# home pipeline pulls in; on the home viewer they go straight into the database.
REPORT_KINDS = {"conflict", "strike", "incident", "local"}
REPORT_LIMIT = [(600, 5), (86400, 30)]        # per client: 5 per 10 min, 30 per day
_report_hits: dict[str, list[float]] = {}


@app.post("/api/report")
async def report(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "bad request"}, status_code=400)
    if body.get("website"):                          # honeypot field, invisible to people
        return JSONResponse({"ok": True})
    kind, reason = str(body.get("kind") or ""), str(body.get("reason") or "").strip()[:80]
    if kind not in REPORT_KINDS or not reason:
        return JSONResponse({"error": "missing kind or reason"}, status_code=400)
    ip, now = _client_ip(request), time.time()
    hits = [t for t in _report_hits.get(ip, []) if now - t < REPORT_LIMIT[-1][0]]
    if any(sum(1 for t in hits if now - t < win) >= n for win, n in REPORT_LIMIT):
        return JSONResponse({"error": "too many reports, try again later"}, status_code=429)
    _report_hits[ip] = hits + [now]
    rec = {"id": uuid.uuid4().hex, "ts": int(now), "kind": kind, "ref": str(body.get("ref") or "")[:200],
           "title": str(body.get("title") or "")[:300], "reason": reason, "note": str(body.get("note") or "").strip()[:1000],
           "page": str(body.get("page") or "")[:300]}
    if SERVE_ONLY:
        path = DATA_DIR / "reports.jsonl"
        if path.exists() and path.stat().st_size > 5_000_000:
            return JSONResponse({"error": "report box is full, try again later"}, status_code=503)
        with open(path, "a") as f:
            f.write(json.dumps(rec) + "\n")
    else:
        with db() as con:
            store_report(con, rec)
    return JSONResponse({"ok": True})


@app.get("/api/reports")
def reports_list():
    if SERVE_ONLY:
        return JSONResponse({"error": "not available here"}, status_code=403)
    with db() as con:
        rows = con.execute("SELECT * FROM reports ORDER BY status='resolved', ts DESC LIMIT 300").fetchall()
    return {"reports": [dict(r) for r in rows]}


@app.post("/api/reports/{rid}")
async def reports_update(rid: str, request: Request):
    if SERVE_ONLY:
        return JSONResponse({"error": "not available here"}, status_code=403)
    status = (await request.json()).get("status")
    if status not in ("open", "resolved"):
        return JSONResponse({"error": "bad status"}, status_code=400)
    with db() as con:
        con.execute("UPDATE reports SET status=? WHERE id=?", (status, rid))
    return {"ok": True}


@app.get("/")
def index():
    # stamp the stylesheet / script URLs with their modification time, so a browser never pairs
    # a new page with a heuristically cached old app.js or style.css after an update
    html = (STATIC_DIR / "index.html").read_text()
    for name in ("style.css", "app.js"):
        v = int((STATIC_DIR / name).stat().st_mtime)
        html = html.replace(f'"/static/{name}"', f'"/static/{name}?v={v}"')
    return Response(html, media_type="text/html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
