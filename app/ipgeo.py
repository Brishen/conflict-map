"""Which country a visitor's IP address is in, so the globe can open over their part of the world.
Looked up in a local copy of DB-IP's free country database (CC BY 4.0, https://db-ip.com), fetched
once a month; the address never leaves this server and nothing is stored."""
import gzip
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import httpx
import maxminddb

from . import countries
from .config import DATA_DIR

log = logging.getLogger("ipgeo")
PATH = DATA_DIR / "dbip-country-lite.mmdb"
MAX_AGE = 35 * 86400
_reader = None
_lock = threading.Lock()


def _download() -> bool:
    now = datetime.now(timezone.utc)
    # this month's file appears in the first days of the month; until then use last month's
    months = [now.strftime("%Y-%m"), (now.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")]
    for m in months:
        url = f"https://download.db-ip.com/free/dbip-country-lite-{m}.mmdb.gz"
        try:
            r = httpx.get(url, timeout=120, follow_redirects=True)
            if r.status_code != 200:
                continue
            tmp = PATH.with_suffix(".tmp")
            tmp.write_bytes(gzip.decompress(r.content))
            tmp.replace(PATH)
            log.info("downloaded %s", url)
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("fetching %s failed: %s", url, e)
    return False


def _open():
    global _reader
    try:
        new = maxminddb.open_database(str(PATH))
    except Exception as e:  # noqa: BLE001
        log.warning("can't open %s: %s", PATH, e)
        return
    with _lock:
        old, _reader = _reader, new
    if old:
        old.close()


def run_forever():
    """Background thread: keep the database no older than a month."""
    while True:
        fresh = PATH.exists() and time.time() - PATH.stat().st_mtime < MAX_AGE
        if fresh or _download():
            if _reader is None or not fresh:
                _open()
        time.sleep(86400 if (PATH.exists() and _reader) else 3600)


def locate(ip: str) -> dict | None:
    """{"iso3", "lat", "lon"} for the country of an IP address, or None."""
    with _lock:
        rd = _reader
    if not rd or not ip:
        return None
    try:
        rec = rd.get(ip)
    except ValueError:              # not an IP address
        return None
    iso2 = ((rec or {}).get("country") or {}).get("iso_code")
    if not iso2:
        return None
    c = _by_iso2().get(iso2)
    return {"iso3": c["iso3"], "lat": c["lat"], "lon": c["lon"]} if c else None


@lru_cache(maxsize=1)
def _by_iso2() -> dict:
    return {v["iso2"]: v for v in countries.table()["iso3"].values() if v.get("iso2")}
