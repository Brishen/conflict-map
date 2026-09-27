"""Live TV news channels: find each broadcaster's current YouTube live stream, so the page can
embed that video (a bare channel embed often fails). Resolved lazily, cached for a while."""
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

log = logging.getLogger("livetv")

# key, label, YouTube handle, channel id (the channel id is the fallback embed and the ownership check)
CHANNELS = [
    ("sky", "Sky News", "@SkyNews", "UCoMdktPbSTixAyNGwb-UYkQ"),            # the default channel
    ("aljazeera", "Al Jazeera", "@AlJazeeraEnglish", "UCNye-wNBqNL5ZzHSJj3l8Bg"),
    ("dw", "DW News", "@DWNews", "UCknLrEdhRCp1aegoMqRaCZg"),
    ("france24", "France 24", "@FRANCE24_en", "UCQfwfsi5VrQ8yKZ-UWmAEFg"),
    ("euronews", "Euronews", "@euronews", "UCSrZ3UV4jOidv8ppoVuvW9Q"),
    ("trt", "TRT World", "@trtworld", "UC7fWeaHhqgM4Ry-RMpM2YYw"),
    ("wion", "WION", "@WION", "UC_gUM8rL-Lrg6O3adPW9K1g"),
    ("abc", "ABC News (US)", "@ABCNews", "UCBi2mrWuNuyYy4gbM6fU18Q"),
]
FRESH = 20 * 60              # re-check a channel after this long
KEEP_GOOD = 6 * 3600         # an unreadable page (bot check, consent) keeps the last good video this long
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
           "Accept-Language": "en-US,en;q=0.9", "Cookie": "SOCS=CAI; CONSENT=YES+cb"}

_cache: dict[str, dict] = {}     # key -> {"video", "live", "checked", "good_at"}
_lock = threading.Lock()


def _player_response(html: str) -> dict | None:
    i = html.find("ytInitialPlayerResponse = {")
    if i < 0:
        return None
    i = html.index("{", i)
    depth, in_str, esc = 0, False, False
    for j in range(i, len(html)):
        ch = html[j]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[i:j + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _resolve(handle: str, channel_id: str) -> dict:
    """{"live": True, "video": id} | {"live": False} (confirmed off air) | {} (page unreadable)."""
    try:
        r = httpx.get(f"https://www.youtube.com/{handle}/live?hl=en", headers=HEADERS, follow_redirects=True, timeout=12)
    except httpx.HTTPError as e:
        log.info("livetv %s: %s", handle, e)
        return {}
    html = r.text
    canon = (re.search(r'<link rel="canonical" href="([^"]+)"', html) or [None, ""])[1]
    if "consent." in canon:
        return {}
    if "/channel/" in canon:
        return {"live": False}             # the /live page fell back to the channel page: nothing on air
    p = _player_response(html) or {}
    vd, ps = p.get("videoDetails") or {}, p.get("playabilityStatus") or {}
    if vd.get("videoId"):
        if vd.get("channelId") != channel_id:
            return {}
        if vd.get("isLive") and ps.get("status") == "OK" and ps.get("playableInEmbed") is not False:
            return {"live": True, "video": vd["videoId"]}
        return {"live": False}
    # servers on datacenter IPs get "Sign in to confirm you're not a bot": the player data is stripped,
    # but the watch page data still names the current video, its owner and whether it is live. Viewers'
    # own browsers aren't bot-checked, so that video id plays fine for them.
    cur = re.search(r'currentVideoEndpoint.{0,400}?"watchEndpoint":\{"videoId":"([A-Za-z0-9_-]{11})"', html)
    owner = re.search(r'videoOwnerRenderer.{0,1500}?"browseId":"(UC[A-Za-z0-9_-]{22})"', html)
    live = re.search(r'videoViewCountRenderer.{0,600}?"isLive":true', html)
    if cur and owner and owner[1] == channel_id and live:
        return {"live": True, "video": cur[1]}
    return {}


def _refresh(stale: list[tuple]):
    def one(ch):
        key, _, handle, cid = ch
        res = _resolve(handle, cid)
        now = time.time()
        prev = _cache.get(key, {})
        if res.get("live"):
            _cache[key] = {"video": res["video"], "live": True, "checked": now, "good_at": now}
        elif res.get("live") is False:
            _cache[key] = {"video": None, "live": False, "checked": now}
        elif prev.get("video") and now - prev.get("good_at", 0) < KEEP_GOOD:
            _cache[key] = {**prev, "checked": now}
        else:
            _cache[key] = {"video": None, "live": None, "checked": now}   # unknown: the page tries the channel embed
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(one, stale))


def channels() -> list[dict]:
    now = time.time()
    stale = [c for c in CHANNELS if now - _cache.get(c[0], {}).get("checked", 0) > FRESH]
    if stale and _lock.acquire(blocking=False):
        try:
            _refresh(stale)
        finally:
            _lock.release()
    out = []
    for key, label, handle, cid in CHANNELS:
        c = _cache.get(key, {})
        out.append({"key": key, "label": label, "channel": cid, "video": c.get("video"), "live": c.get("live"),
                    "youtube": f"https://www.youtube.com/watch?v={c['video']}" if c.get("video") else f"https://www.youtube.com/{handle}/live"})
    return out
