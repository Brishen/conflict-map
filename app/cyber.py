"""Cyber mode: the virtual side of the wars.

Four sources, each shown with its real delay rather than as a fake live feed:
- attacks between countries: Cloudflare Radar's top origin -> target pairs of network-layer (DDoS) and
  application-layer attacks over the last day (needs CLOUDFLARE_RADAR_TOKEN);
- ransomware claims: ransomware.live's list of victims posted on the gangs' leak sites. Only the group, the
  sector and the country are kept: naming victims would do the extortion's work for it;
- internet outages: IODA (Georgia Tech) country outage scores over the last day;
- incidents: cyber attacks read from the news by the local model, attribution included only when the
  article gives it, each checked against the article text like the conflict claims (app/verify.py)."""
import hashlib
import json
import logging
import math
import re
import time
from datetime import datetime, timezone

import httpx

from . import countries, extract, verify
from .config import CLOUDFLARE_RADAR_TOKEN, CYBER_BATCH, CYBER_FEEDS, CYBER_MAX_BATCHES, outlet_of
from .db import db, get_state, set_state

log = logging.getLogger("cyber")
UA = {"User-Agent": "Mozilla/5.0 conflict-map/0.1 (+https://globalnewsmap.org)"}
KEEP_DAYS = 14
KINDS = {"ransomware", "ddos", "breach", "espionage", "wiper", "defacement", "hack-and-leak", "infrastructure", "other"}
# general-news articles worth showing the model: the cyber feeds are read whole
CYBER_TERMS = re.compile(r"\b(cyber|hack|hacker|hacked|ransomware|malware|ddos|data breach|breached|spyware|phishing|"
                         r"botnet|wiper|zero-day|apt\d+|state-sponsored|infostealer|leak site|cyberattack|cyber-attack)", re.I)


def _iso3_from_2(a2: str | None) -> str | None:
    if not a2:
        return None
    a2 = a2.upper()
    for rec in countries.table()["iso3"].values():
        if rec["iso2"] == a2:
            return rec["iso3"]
    return None


def _ts(s: str | None) -> int | None:
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except (AttributeError, TypeError, ValueError):
        return None


# ---------------------------------------------------------------- Cloudflare Radar
def _radar(path: str, params: dict) -> list[dict]:
    r = httpx.get(f"https://api.cloudflare.com/client/v4/radar/{path}", params={**params, "format": "json"},
                  headers={"Authorization": f"Bearer {CLOUDFLARE_RADAR_TOKEN}", **UA}, timeout=30)
    r.raise_for_status()
    res = r.json().get("result") or {}
    return res.get("top_0") or []


def refresh_attacks() -> int:
    if not CLOUDFLARE_RADAR_TOKEN:
        return 0
    pairs = []
    for layer, path in (("l3", "attacks/layer3/top/attacks"), ("l7", "attacks/layer7/top/attacks")):
        try:
            rows = _radar(path, {"dateRange": "1d", "limit": 25})
        except httpx.HTTPError as e:
            log.warning("cloudflare %s: %s", layer, e)
            continue
        for x in rows:
            a, b = _iso3_from_2(x.get("originCountryAlpha2")), _iso3_from_2(x.get("targetCountryAlpha2"))
            try:
                v = float(x.get("value"))
            except (TypeError, ValueError):
                continue
            if a and b:
                pairs.append({"from": a, "to": b, "share": round(v, 2), "layer": layer})
    if not pairs:
        return 0
    with db() as con:
        set_state(con, "cyber_attacks", {"updated": int(time.time()), "window_hours": 24, "pairs": pairs})
    return len(pairs)


# ---------------------------------------------------------------- ransomware.live
def refresh_ransomware() -> int:
    try:
        r = httpx.get("https://api.ransomware.live/v2/recentvictims", headers=UA, timeout=30)
        r.raise_for_status()
        rows = r.json()
    except (httpx.HTTPError, ValueError) as e:
        log.warning("ransomware.live: %s", e)
        return 0
    if not isinstance(rows, list):
        log.warning("ransomware.live: unexpected %s", str(rows)[:100])
        return 0
    new = 0
    cutoff = int(time.time()) - KEEP_DAYS * 86400
    with db() as con:
        for x in rows:
            disc = _ts(x.get("discovered"))
            if not disc or not x.get("group"):
                continue
            # an opaque id: the victim's name is only used to tell claims apart, never stored
            vid = hashlib.sha1(f"{x.get('group')}|{x.get('victim')}|{x.get('domain')}".encode()).hexdigest()[:16]
            before = con.total_changes
            con.execute("INSERT OR IGNORE INTO cyber_ransom(id,grp,sector,country,attacked,discovered) VALUES (?,?,?,?,?,?)",
                        (vid, x["group"], (x.get("activity") or "").strip() if x.get("activity") not in (None, "N/A", "Not Found") else None,
                         _iso3_from_2(x.get("country")), _ts(x.get("attackdate")), disc))
            new += con.total_changes - before
        con.execute("DELETE FROM cyber_ransom WHERE discovered < ?", (cutoff,))
    return new


# ---------------------------------------------------------------- IODA
def refresh_outages() -> int:
    now = int(time.time())
    try:
        r = httpx.get("https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary",
                      params={"from": now - 86400, "until": now, "entityType": "country"}, headers=UA, timeout=60)
        r.raise_for_status()
        data = r.json().get("data") or []
    except (httpx.HTTPError, ValueError) as e:
        log.warning("ioda: %s", e)
        return 0
    out = []
    for x in data:
        iso3 = _iso3_from_2((x.get("entity") or {}).get("code"))
        score = (x.get("scores") or {}).get("overall") or 0
        if not iso3 or score < 1000:              # IODA reports small blips too; below this it is noise on a map
            continue
        signals = sorted(k.split(".")[0] for k in (x.get("scores") or {}) if k != "overall")
        # log scale: 1e3 minor, 1e4 moderate, 1e5+ severe
        out.append({"iso3": iso3, "score": round(score), "level": min(3, max(1, int(math.log10(score)) - 2)),
                    "signals": signals})
    with db() as con:
        set_state(con, "cyber_outages", {"updated": now, "window_hours": 24, "countries": out})
    return len(out)


# ---------------------------------------------------------------- incidents from the news
SYSTEM = """You read cybersecurity news and list CYBER ATTACKS that actually happened, for a world map.
Answer ONLY compact JSON: {"incidents":[{"a":<article number>,"date":"YYYY-MM-DD","kind":"ransomware|ddos|breach|espionage|wiper|defacement|hack-and-leak|infrastructure|other",
"title":"<= 12 words, neutral","summary":"one sentence","victim":"organisation or sector attacked","sector":"e.g. healthcare, government, energy",
"victim_country":"ISO3 of the victim","attacker":"group name as reported, or null","attacker_country":"ISO3 or null",
"state_linked":true|false,"attribution":"who says so, <= 8 words (e.g. 'US officials', 'Microsoft researchers', 'group claimed it'), or null"}]}
Rules:
- Only real attacks on named victims or a named country's systems. Not: advisories, patches, vulnerabilities, product news,
  arrests or trials, opinion, statistics, general warnings, how-tos.
- attacker, attacker_country and state_linked come ONLY from the article: never guess from the group name. A group
  claiming the attack counts ("group claimed it"). If the article names no attacker, use null and state_linked false.
- victim_country: where the victim is based. Skip the incident if it is unknown.
- One entry per attack; several articles about the same attack -> one entry citing the clearest article.
- An empty list is fine."""


def _candidates(con, limit: int) -> list[dict]:
    since = int(time.time()) - 3 * 86400
    rows = con.execute("SELECT link, source, title, summary, published FROM articles WHERE published > ? "
                       "AND link NOT IN (SELECT link FROM cyber_seen) ORDER BY published DESC", (since,)).fetchall()
    out = []
    for r in rows:
        if r["source"] in CYBER_FEEDS or CYBER_TERMS.search(f"{r['title']} {r['summary']}"):
            out.append(dict(r))
        if len(out) >= limit:
            break
    return out


def _key(inc: dict) -> str:
    v = re.sub(r"[^a-z0-9]+", " ", (inc.get("victim") or "").lower()).strip()
    return f"{v[:40]}|{inc.get('victim_country')}|{inc.get('kind')}"


def _claim(inc: dict) -> str:
    return f"Around {inc.get('date')}, {inc.get('victim')} ({inc.get('victim_country')}) was hit by a {inc.get('kind')} cyber attack."


def _attribution_claim(inc: dict) -> str:
    return f"The article reports that {inc.get('attacker')} carried out or claimed the attack on {inc.get('victim')}."


def _state_claim(inc: dict) -> str:
    name = countries.table()["iso3"].get(inc.get("attacker_country"), {}).get("name", inc.get("attacker_country"))
    return f"The article reports that {inc.get('attacker')} is linked to the government or state of {name}."


def _same_victim(a: str, b: str) -> bool:
    """"FBI" and "Federal Bureau of Investigation", "Oracle" and "Oracle Corporation"."""
    wa, wb = re.findall(r"[a-z0-9]+", a.lower()), re.findall(r"[a-z0-9]+", b.lower())
    if not wa or not wb:
        return False
    if len(wa) == 1 and wa[0] == "".join(w[0] for w in wb if w not in ("of", "the", "and")):
        return True
    if len(wb) == 1 and wb[0] == "".join(w[0] for w in wa if w not in ("of", "the", "and")):
        return True
    return bool({w for w in wa if len(w) >= 4} & {w for w in wb if len(w) >= 4})


def run_batch() -> int:
    with db() as con:
        arts = _candidates(con, CYBER_BATCH)
    if not arts:
        return -1
    listing = "\n".join(f"{i + 1}. [{a['source']}, {datetime.fromtimestamp(a['published'], timezone.utc):%Y-%m-%d}] "
                        f"{a['title']} — {a['summary'][:300]}" for i, a in enumerate(arts))
    try:
        out = extract.call_llm([{"role": "system", "content": SYSTEM}, {"role": "user", "content": listing}])
        found = extract._parse_json(out).get("incidents") or []
    except Exception as e:  # noqa: BLE001  (the batch is retried next refresh)
        log.warning("cyber extraction failed: %s", e)
        return 0
    good = []
    for inc in found:
        if not isinstance(inc, dict):
            continue
        try:
            art = arts[int(inc.get("a")) - 1]
        except (TypeError, ValueError, IndexError):
            continue
        vc = countries.iso3(inc.get("victim_country"))
        if not vc or not inc.get("victim"):
            continue
        inc["victim_country"] = vc
        inc["attacker_country"] = countries.iso3(inc.get("attacker_country"))
        inc["kind"] = inc.get("kind") if inc.get("kind") in KINDS else "other"
        if not inc.get("attacker"):                   # nobody named: nothing to attribute
            inc.update(attacker=None, attacker_country=None, state_linked=False, attribution=None)
        # a state link needs a state: criminal gangs come back "state_linked" with no country now and then
        inc["state_linked"] = bool(inc.get("state_linked") and inc.get("attacker_country"))
        inc["art"] = art
        good.append(inc)
    # check against the article text: the event itself, and separately who is blamed for it
    claims: dict[str, list] = {}
    for inc in good:
        claims.setdefault(inc["art"]["link"], []).append((inc, _claim(inc)))
        if inc.get("attacker"):
            claims[inc["art"]["link"]].append((("attr", id(inc)), _attribution_claim(inc)))
        if inc.get("state_linked"):
            claims[inc["art"]["link"]].append((("state", id(inc)), _state_claim(inc)))
    verdicts = verify.check(claims) if claims else {}
    # verify.check keys by id() of the claim object; the attribution claims used a tuple built on the fly
    attr_verdict, state_verdict = {}, {}
    for link, items in claims.items():
        for obj, _ in items:
            if isinstance(obj, tuple):
                (attr_verdict if obj[0] == "attr" else state_verdict)[obj[1]] = verdicts.get(id(obj))
    now = int(time.time())
    stored = 0
    with db() as con:
        for inc in good:
            v = verdicts.get(id(inc))
            if v is False:
                continue
            if inc.get("attacker") and attr_verdict.get(id(inc)) is False:
                inc.update(attacker=None, attacker_country=None, state_linked=False, attribution=None)
            elif inc.get("state_linked") and state_verdict.get(id(inc)) is not True:
                inc["state_linked"] = False            # a state link is only shown when the article itself makes it
            art = inc["art"]
            src = {"link": art["link"], "title": art["title"], "source": art["source"], "published": art["published"]}
            key = _key(inc)
            row = con.execute("SELECT id, sources, verified FROM cyber_incidents WHERE key=?", (key,)).fetchone()
            if not row:                                # the same attack named differently ("FBI"), within a few days
                day = inc.get("date") or ""
                for r in con.execute("SELECT id, sources, verified, victim, date FROM cyber_incidents WHERE victim_country=? AND kind=?",
                                     (inc["victim_country"], inc["kind"])):
                    try:
                        near = abs((datetime.fromisoformat(r["date"]) - datetime.fromisoformat(day)).days) <= 3
                    except (TypeError, ValueError):
                        near = False
                    if near and _same_victim(r["victim"] or "", inc["victim"]):
                        row = r
                        break
            if row:
                srcs = json.loads(row["sources"] or "[]")
                if not any(s["link"] == src["link"] for s in srcs):
                    srcs.append(src)
                con.execute("UPDATE cyber_incidents SET sources=?, verified=MAX(COALESCE(verified,0),?), updated=? WHERE id=?",
                            (json.dumps(srcs), 1 if v else 0, now, row["id"]))
            else:
                con.execute("INSERT INTO cyber_incidents(key,date,kind,title,summary,victim,sector,victim_country,attacker,"
                            "attacker_country,state_linked,attribution,verified,sources,created,updated) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (key, inc.get("date") or datetime.fromtimestamp(art["published"], timezone.utc).strftime("%Y-%m-%d"),
                             inc["kind"], inc.get("title"), inc.get("summary"), inc.get("victim"), inc.get("sector"),
                             inc["victim_country"], inc.get("attacker"), inc.get("attacker_country"),
                             1 if inc.get("state_linked") and inc.get("attacker") else 0, inc.get("attribution"),
                             1 if v else 0, json.dumps([src]), now, now))
                stored += 1
        con.executemany("INSERT OR IGNORE INTO cyber_seen(link, seen) VALUES (?,?)", [(a["link"], now) for a in arts])
        con.execute("DELETE FROM cyber_seen WHERE seen < ?", (now - 10 * 86400,))
        con.execute("DELETE FROM cyber_incidents WHERE date < ?",
                    (datetime.fromtimestamp(now - 60 * 86400, timezone.utc).strftime("%Y-%m-%d"),))
    log.info("cyber: %d articles, %d incidents found, %d new", len(arts), len(good), stored)
    return stored


def extract_all() -> int:
    total = 0
    for _ in range(CYBER_MAX_BATCHES):
        n = run_batch()
        if n < 0:
            break
        total += n
    return total


def refresh_feeds() -> dict:
    """The keyless and token feeds; each failure is logged and the last good copy stays."""
    out = {}
    for name, fn in (("attacks", refresh_attacks), ("ransomware", refresh_ransomware), ("outages", refresh_outages)):
        try:
            out[name] = fn()
        except Exception as e:  # noqa: BLE001
            log.exception("cyber %s failed", name)
            out[name + "_error"] = str(e)
    return out


# ---------------------------------------------------------------- what the page gets
def view() -> dict:
    now = int(time.time())
    with db() as con:
        try:
            attacks = get_state(con, "cyber_attacks")
            outages = get_state(con, "cyber_outages")
            ransom = [dict(r) for r in con.execute(
                "SELECT grp, sector, country, attacked, discovered FROM cyber_ransom WHERE discovered > ? "
                "ORDER BY discovered DESC", (now - 7 * 86400,))]
            incidents = []
            for r in con.execute("SELECT * FROM cyber_incidents ORDER BY date DESC, updated DESC LIMIT 120"):
                d = dict(r)
                d["sources"] = json.loads(d["sources"] or "[]")
                for s in d["sources"]:
                    s["outlet"] = outlet_of(s.get("source"))
                d["state_linked"] = bool(d["state_linked"])
                d.pop("key", None)
                incidents.append(d)
        except Exception as e:  # noqa: BLE001  (a viewer whose database predates cyber mode)
            log.warning("cyber view: %s", e)
            attacks = outages = None
            ransom, incidents = [], []
    return {"attacks": attacks, "outages": outages, "ransomware": ransom, "incidents": incidents,
            "attacks_enabled": attacks is not None, "now": now}


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    print(refresh_feeds())
    if "extract" in sys.argv[1:]:
        print("incidents:", extract_all())
