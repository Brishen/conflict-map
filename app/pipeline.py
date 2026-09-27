"""Run one full refresh: GDELT + feeds + LLM extraction."""
import json
import logging
import sqlite3
import subprocess
import time

from . import advisories, cleanup, dedupe, extract, feeds, gdelt
from . import stats as figures
from .config import DATA_DIR, DB_PATH, PUSH_TARGET
from .db import db, set_state, store_report

log = logging.getLogger("pipeline")


def refresh(skip_llm: bool = False, gdelt_files: int | None = None):
    t0 = time.time()
    stats = {"started": int(t0)}
    try:
        stats["gdelt_events"] = gdelt.update(max_files=gdelt_files)
    except Exception as e:  # noqa: BLE001
        log.exception("gdelt failed")
        stats["gdelt_error"] = str(e)
    try:
        stats["new_articles"] = feeds.update()
    except Exception as e:  # noqa: BLE001
        log.exception("feeds failed")
        stats["feeds_error"] = str(e)
    if not skip_llm:
        try:
            stats["conflicts_updated"] = extract.run_all()
            stats["duplicates_merged"] = dedupe.merge_duplicates()
            stats["untrusted_removed"] = cleanup.purge_untrusted()
            stats["travel_advice"] = advisories.refresh()
            stats["figures_updated"] = figures.refresh()
        except Exception as e:  # noqa: BLE001
            log.exception("extract failed")
            stats["extract_error"] = str(e)
    stats["secs"] = round(time.time() - t0)
    with db() as con:
        set_state(con, "last_refresh", stats)
    if PUSH_TARGET:
        try:
            stats["reports_pulled"] = pull_reports(PUSH_TARGET)
        except Exception as e:  # noqa: BLE001
            log.exception("pulling reports failed")
            stats["reports_error"] = str(e)
        try:
            push_db(PUSH_TARGET)
            stats["pushed"] = PUSH_TARGET
        except Exception as e:  # noqa: BLE001
            log.exception("push failed")
            stats["push_error"] = str(e)
    log.info("refresh done: %s", stats)
    return stats


def pull_reports(target: str) -> int:
    """Copy visitors' problem reports from the public viewer (data/reports.jsonl there) into the local
    database; ids make it idempotent, so the remote file is simply read again next time."""
    host, _, remote_dir = target.partition(":")
    out = subprocess.run(["ssh", host, f"cat {remote_dir}/reports.jsonl 2>/dev/null || true"],
                         capture_output=True, text=True, check=True, timeout=60).stdout
    n = 0
    with db() as con:
        for line in out.splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            before = con.total_changes
            store_report(con, rec)
            n += con.total_changes - before
    if n:
        log.info("pulled %d new problem reports", n)
    return n


def push_db(target: str):
    """WAL-safe snapshot of the database, converted to a single file, copied to the
    viewer with scp and swapped in atomically (mv on the remote side)."""
    snap = DATA_DIR / "conflict.snapshot.db"
    if snap.exists():
        snap.unlink()
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(snap)
    src.backup(dst)
    try:
        dst.execute("DELETE FROM reports")             # visitors' reports stay at home, never on the public box
        dst.commit()
    except sqlite3.OperationalError:
        pass                                           # database from before the reports table
    dst.execute("PRAGMA journal_mode=DELETE")
    dst.execute("VACUUM")
    dst.close()
    src.close()
    host, _, remote_dir = target.partition(":")
    subprocess.run(["scp", "-q", str(snap), f"{host}:{remote_dir}/conflict.db.tmp"], check=True, timeout=300)
    subprocess.run(["ssh", host, f"mv -f {remote_dir}/conflict.db.tmp {remote_dir}/conflict.db"], check=True, timeout=60)
    log.info("pushed %.1f MB to %s", snap.stat().st_size / 1e6, target)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-llm", action="store_true")
    ap.add_argument("--gdelt-files", type=int, default=None)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    refresh(skip_llm=a.skip_llm, gdelt_files=a.gdelt_files)
