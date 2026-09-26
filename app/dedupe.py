"""Fold duplicate conflict records (the same conflict stored under several ids) into one."""
import logging
import re

from . import stats
from .db import all_conflicts, db, upsert_conflict
from .extract import same_conflict

log = logging.getLogger("dedupe")


def _dkey(d: dict) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (d.get("text") or "").lower()).strip()[:70]


def merge_duplicates() -> int:
    """Keep the oldest id of each group (links to it keep working), take the freshest record's
    content, union sources / developments / figures, and move the strikes over."""
    with db() as con:
        conflicts = sorted(all_conflicts(con), key=lambda c: c["created"] or 0)
        groups: list[list[dict]] = []
        for c in conflicts:
            g = next((g for g in groups if any(same_conflict(c, x) for x in g)), None)
            (g.append(c) if g else groups.append([c]))
        merged = 0
        for g in groups:
            if len(g) < 2:
                continue
            keep, dups = g[0], g[1:]
            fresh = max(g, key=lambda c: c["updated"] or 0)
            data = {k: v for k, v in fresh.items() if k not in ("id", "created", "updated")}
            srcs = {s["link"]: s for c in g for s in c.get("sources") or []}
            data["sources"] = sorted(srcs.values(), key=lambda s: -(s.get("published") or 0))[:20]
            seen, devs = set(), []
            for d in sorted((d for c in g for d in c.get("developments") or []), key=lambda d: d.get("date", ""), reverse=True):
                k = _dkey(d)
                if k and k not in seen:
                    seen.add(k)
                    devs.append(d)
            data["developments"] = devs[:8]
            data["first_seen"] = min((c.get("first_seen") or c["created"] or 0) for c in g)
            st = None
            for c in g:
                if c.get("stats"):
                    st = stats.merge(st, c["stats"]) if st else c["stats"]
            if st:
                data["stats"] = st
            upsert_conflict(con, keep["id"], data)
            for d in dups:
                # strikes are unique per (conflict, date, weapon, target): a clash means it is already on the kept id
                con.execute("UPDATE OR IGNORE strikes SET conflict_id=? WHERE conflict_id=?", (keep["id"], d["id"]))
                con.execute("DELETE FROM strikes WHERE conflict_id=?", (d["id"],))
                con.execute("DELETE FROM conflicts WHERE id=?", (d["id"],))
            log.info("merged %s into %s", ", ".join(d["id"] for d in dups), keep["id"])
            merged += len(dups)
    return merged


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    print(merge_duplicates(), "duplicates merged")
