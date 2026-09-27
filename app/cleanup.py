"""Keep only what the current, trusted outlets back (config.FEEDS / OUTLETS).

Runs after every refresh, before the database is pushed: attacks, developments, sources and figures
whose article came from an outlet no longer used are removed, and a conflict left with nothing from a
current outlet is removed too (it comes back if a current outlet reports on it)."""
import json
import logging

from .config import outlet_of
from .db import all_conflicts, db

log = logging.getLogger("cleanup")


def purge_untrusted() -> dict:
    n = {"strikes": 0, "developments": 0, "sources": 0, "figures": 0, "conflicts": 0}
    with db() as con:
        link_source = {r[0]: r[1] for r in con.execute("SELECT link, source FROM articles")}
        current = lambda link: bool(outlet_of(link_source.get(link)))
        # attacks: from a current outlet, or dropped (this also removes the few with no article at all)
        bad = [r[0] for r in con.execute("SELECT id, source FROM strikes") if not outlet_of(r[1])]
        con.executemany("DELETE FROM strikes WHERE id=?", [(i,) for i in bad])
        n["strikes"] = len(bad)
        for c in all_conflicts(con):
            cid = c.pop("id"); c.pop("created", None); updated = c.pop("updated", None)
            before = json.dumps(c, sort_keys=True)
            srcs = [s for s in c.get("sources") or [] if outlet_of(s.get("source"))]
            n["sources"] += len(c.get("sources") or []) - len(srcs)
            c["sources"] = srcs
            devs = []
            for d in c.get("developments") or []:
                keep = [u for u in d.get("sources") or [] if current(u)]
                if keep:
                    d["sources"] = keep
                    devs.append(d)
            n["developments"] += len(c.get("developments") or []) - len(devs)
            c["developments"] = devs
            for key in ("parties", "consequences"):
                for x in c.get(key) or []:
                    if isinstance(x, dict) and x.get("sources"):
                        x["sources"] = [u for u in x["sources"] if current(u)]
                        if not x["sources"]:
                            x.pop("sources"); x["basis"] = "background"
            st = c.get("stats") or {}
            if st.get("figures"):
                figs = [f for f in st["figures"] if outlet_of(f.get("source")) or current(f.get("link"))]
                n["figures"] += len(st["figures"]) - len(figs)
                st["figures"] = figs
            has_strikes = con.execute("SELECT 1 FROM strikes WHERE conflict_id=? LIMIT 1", (cid,)).fetchone()
            if not srcs and not devs and not has_strikes:
                con.execute("DELETE FROM conflicts WHERE id=?", (cid,))
                n["conflicts"] += 1
                log.info("removed %s: nothing from a current outlet", cid)
            elif json.dumps(c, sort_keys=True) != before:
                con.execute("UPDATE conflicts SET data=? WHERE id=?", (json.dumps(c), cid))   # keep 'updated'
    if any(n.values()):
        log.info("removed untrusted data: %s", n)
    return n


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    print(purge_untrusted())
