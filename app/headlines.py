"""Top headlines: the stories most outlets are carrying right now.

Headlines from the last hours are grouped into stories by the words they share, and a story ranks by
how many different outlets ran it (then by how recent it is). Rough on purpose: two outlets rarely word
a headline the same way, so a story is only counted once it clearly shares its key words.

Each story also gets a topic (for its colour), the tracked conflict it belongs to when one of its articles
is already a source of that conflict, and the place it is about when a headline names one."""
import math
import re
import threading
import time
from functools import lru_cache

from . import countries, geo, goodnews
from .config import outlet_of
from .db import all_conflicts, db

# UN agencies, the Red Cross and investigators publish reports, not the day's headlines
NOT_NEWS = {"UN News", "OHCHR", "ReliefWeb", "ICRC", "Bellingcat"}
STOP = set("""
about after again against amid among around away back been before being below between both could down during
each even ever from further have having here into just like more most much must near news next only other over
says said same should since some still such than that their them then there these they this those though three
through today told under until very watch what when where which while will with would year years your live
latest update updates week first last day days make made takes take gets calls call new
kill killed killing dead death dies died injured wounded people dozens least mass attack
attacks police report reports""".split())
# video pages, transcripts, letters and opinion: not what to show when the story has a proper headline
MINOR = re.compile(r"^(watch( live)?|live|video|transcript|in pictures|opinion)\b|\|\s*(letter|opinion|video)\b", re.I)
MINOR_URL = re.compile(r"/(video|videos|av|live|liveblog|live-news|podcasts?|audio|gallery|in-pictures)/", re.I)
WORD = re.compile(r"[a-z0-9]+(?:['’][a-z]+)?")
_cache: dict = {}
_lock = threading.Lock()


def _words(title: str) -> set[str]:
    out = set()
    for w in WORD.findall(title.lower()):
        w = re.sub(r"['’]s$", "", w)
        if len(w) < 4 or w in STOP or w.isdigit():
            continue
        out.add(w[:-1] if w.endswith("s") and not w.endswith("ss") else w)   # "strikes" = "strike"
    return out


def _minor(title: str, link: str) -> bool:
    return bool(MINOR.search(title) or MINOR_URL.search(link or ""))


def _same_story(a: set[str], b: set[str]) -> bool:
    shared = len(a & b)
    # against the average length, not the shorter one: two words ("South Africa") can't carry a story on their own
    return shared >= 2 and shared / ((len(a) + len(b)) / 2) >= 0.4


# ---- topic: the same four kinds as the local news layer. Disasters and accidents come first so
# ---- "avalanche leaves 2 dead" is not filed as violence.
DISASTER = re.compile(r"\b(avalanche|flood|storm|earthquake|quake|wildfire|bushfire|hurricane|typhoon|cyclone|tornado|"
                      r"landslide|mudslide|nor.?easter|heatwave|drought|eruption|volcano|tsunami|capsiz|shipwreck|derail|"
                      r"plane crash|bus crash|overturn)", re.I)
VIOLENCE = re.compile(r"\b(kill|dead|death|shoot|shot|gunm|gunfire|attack|strike|airstrike|bomb|blast|explo|missile|drone|"
                      r"rocket|shell|massacre|war\b|fighting|clash|militant|insurgen|terror|murder|stab|hostage|kidnap|abduct|"
                      r"arrest|charged|raid|siege|troops|soldier|gang|violen|assault|offensive|invasion|executi)", re.I)
TENSION = re.compile(r"\b(protest|march|rally|riot|demonstrat|tension|standoff|stand-off|sanction|threat|warn|dispute|"
                     r"row\b|spat|accus|condemn|blockade|unrest|walkout|boycott|expel|crackdown)", re.I)


def _topic(titles: list[str]) -> str:
    t = " ".join(titles)
    if DISASTER.search(t):
        return "other"
    if VIOLENCE.search(t):
        return "violence"
    if TENSION.search(t):
        return "tension"
    if all(goodnews.local_title(x) for x in titles) and goodnews.GOOD.search(t):
        return "good"
    return "other"


# ---- place: a city or region a headline names, else a country; checked against every headline of the story
DEMONYMS = {
    "us": "USA", "u s": "USA", "usa": "USA", "america": "USA", "american": "USA", "uk": "GBR", "u k": "GBR",
    "britain": "GBR", "british": "GBR", "england": "GBR", "english": "GBR", "swiss": "CHE", "israeli": "ISR",
    "iranian": "IRN", "russian": "RUS", "ukrainian": "UKR", "chinese": "CHN", "french": "FRA", "german": "DEU",
    "palestinian": "PSE", "palestinians": "PSE", "syrian": "SYR", "lebanese": "LBN", "yemeni": "YEM", "sudanese": "SDN",
    "saudi": "SAU", "turkish": "TUR", "turkiye": "TUR", "indian": "IND", "pakistani": "PAK", "afghan": "AFG",
    "japanese": "JPN", "mexican": "MEX", "brazilian": "BRA", "venezuelan": "VEN", "cuban": "CUB", "spanish": "ESP",
    "italian": "ITA", "polish": "POL", "ethiopian": "ETH", "ethiopians": "ETH", "somali": "SOM", "nigerian": "NGA",
    "kenyan": "KEN", "congolese": "COD", "drc": "COD", "dr congo": "COD", "egyptian": "EGY", "iraqi": "IRQ",
    "nepali": "NPL", "north korea": "PRK", "north korean": "PRK", "south korea": "KOR", "south korean": "KOR", "s korea": "KOR", "n korea": "PRK",
    "czech": "CZE", "dutch": "NLD", "irish": "IRL", "greek": "GRC", "haitian": "HTI", "malian": "MLI",
    "burmese": "MMR", "burma": "MMR", "filipino": "PHL", "canadian": "CAN", "australian": "AUS", "serbian": "SRB",
    "georgian": "GEO", "armenian": "ARM", "azerbaijani": "AZE", "libyan": "LBY", "tunisian": "TUN", "algerian": "DZA",
    "moroccan": "MAR", "colombian": "COL", "argentine": "ARG", "chilean": "CHL", "peruvian": "PER",
    "south african": "ZAF", "taiwanese": "TWN", "vietnamese": "VNM", "thai": "THA", "bangladeshi": "BGD",
}
# places the gazetteer has no single point for: (lat, lon, zoom)
REGIONS = {
    "northern ireland": (54.6, -6.7, 7), "scotland": (56.8, -4.2, 5.5), "wales": (52.4, -3.7, 6.5),
    "gaza": (31.42, 34.38, 9), "gaza strip": (31.42, 34.38, 9), "west bank": (31.95, 35.25, 8),
    "crimea": (45.3, 34.4, 6.5), "donbas": (48.0, 38.0, 6), "darfur": (13.5, 24.0, 5), "kashmir": (34.1, 74.8, 6),
    "strait of hormuz": (26.6, 56.3, 6.5), "hormuz": (26.6, 56.3, 6.5), "red sea": (20.0, 38.5, 4.5),
    "south china sea": (12.0, 114.0, 4), "taiwan strait": (24.5, 119.5, 6), "tigray": (13.8, 39.0, 6),
    "rakhine": (20.0, 93.5, 6), "north kivu": (-0.8, 29.0, 6.5), "south kivu": (-3.0, 28.3, 6.5),
    "balochistan": (28.5, 65.5, 5.5), "khyber pakhtunkhwa": (34.5, 71.5, 6), "golan heights": (33.0, 35.8, 8),
    "sinai": (29.5, 33.8, 6), "kurdistan": (36.2, 44.0, 6), "sahel": (15.0, 2.0, 4), "caribbean": (15.0, -72.0, 4),
}
# gazetteer names that are more often ordinary words or people in a headline
NOT_PLACES = {"orange", "mobile", "reading", "split", "nice", "bath", "hope", "victoria", "mission", "independence",
              "liberty", "union", "sale", "home", "gore", "pope", "leo", "chase", "march", "may", "police", "church",
              "grand", "university", "university park", "central", "republic", "centre", "labour", "reform", "trump",
              "lincoln", "washington", "jackson", "franklin", "marion", "clinton", "hamilton", "wellington"}
# headline spellings the gazetteer knows differently (on top of geo.ALIASES)
SPELLINGS = {"taiz": "taizz", "hodeida": "al hudaydah", "khartoum north": "khartoum"}


@lru_cache
def _country_names() -> dict[str, str]:
    idx = {}
    for iso3, rec in countries.table()["iso3"].items():
        for n in (rec["name"], rec["label"]):
            if n:
                idx[geo._norm(n)] = iso3
    idx.update(DEMONYMS)
    return idx


@lru_cache
def _country_view(iso3: str) -> tuple[float, float, float]:
    """Centre and a zoom that fits the country's largest landmass (mainland US, not Alaska to Guam)."""
    rec = countries.table()["iso3"][iso3]
    g = geo._countries_geo().get(iso3)
    span = 20.0
    if g:
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        ring = max((p[0] for p in polys), key=len)
        xs, ys = [x for x, _ in ring], [y for _, y in ring]
        span = max(max(xs) - min(xs), (max(ys) - min(ys)) * 1.4, 0.5)
    return rec["lat"], rec["lon"], round(max(2.5, min(7.0, math.log2(360 / span) - 0.2)), 1)


def _phrases(title: str) -> list[str]:
    """Runs of capitalised words ("Strait of Hormuz", "Northern Ireland") and every sub-run of up to 3 words."""
    words = re.findall(r"[A-Za-z][A-Za-z'’.]*", title.replace("-", " "))
    out, run = [], []
    for w in words + [""]:
        w = re.sub(r"['’]s$", "", w)
        if w and (w[0].isupper() or (run and w in ("of", "al", "el"))):
            run.append(w)
            continue
        while run and run[-1] in ("of", "al", "el"):
            run.pop()
        for n in (3, 2, 1):
            for i in range(len(run) - n + 1):
                if run[i] in ("of", "al", "el") or run[i + n - 1] in ("of", "al", "el"):
                    continue
                out.append(" ".join(run[i:i + n]))
        run = []
    return out


def _place(titles: list[str]) -> dict | None:
    names = _country_names()
    found_c: dict[str, int] = {}
    spots: dict[str, list] = {}          # normalised name -> [count, candidates or region]
    order: list[str] = []
    for t in titles:
        for ph in _phrases(t):
            n = geo._norm(ph).replace(".", " ").strip()
            n = re.sub(r"\s+", " ", n)
            if not n:
                continue
            if n in REGIONS:
                spots.setdefault(n, [0, ("region", ph, REGIONS[n])])[0] += 1
            elif n in names:
                iso3 = names[n]
                found_c[iso3] = found_c.get(iso3, 0) + 1
                if iso3 not in order:
                    order.append(iso3)
            elif n not in NOT_PLACES and len(n) > 3:
                recs = geo._places().get(SPELLINGS.get(n) or geo.ALIASES.get(n, n))
                if recs:
                    spots.setdefault(n, [0, ("city", ph, recs)])[0] += 1
    best = None
    for n, (count, (kind, label, data)) in spots.items():
        if kind == "region":
            cand = (count, 10**9, {"name": label, "lat": data[0], "lon": data[1], "zoom": data[2]})
        else:
            recs = [r for r in data if r[0] in found_c] or data
            r = max(recs, key=lambda r: r[3])
            # a named country vouches for the town; without one only a big city is believable
            if not (r[0] in found_c or (not found_c and r[3] >= 300000)):
                continue
            cand = (count, r[3], {"name": r[4], "lat": r[1], "lon": r[2], "zoom": 7 if r[3] < 1e6 else 6.5})
        if best is None or cand[:2] > best[:2]:
            best = cand
    if best:
        return best[2]
    if order:
        iso3 = max(order, key=lambda c: (found_c[c], -order.index(c)))
        lat, lon, zoom = _country_view(iso3)
        return {"name": countries.table()["iso3"][iso3]["name"], "lat": lat, "lon": lon, "zoom": zoom}
    return None


def _conflict_links(con) -> dict[str, str]:
    """Article link -> the conflict it is a source of (sources, developments and attacks)."""
    out = {}
    for c in all_conflicts(con):
        for s in c.get("sources") or []:
            out[s.get("link")] = c["id"]
        for d in c.get("developments") or []:
            for u in d.get("sources") or []:
                out.setdefault(u, c["id"])
    for link, cid in con.execute("SELECT link, conflict_id FROM strikes WHERE link IS NOT NULL"):
        out.setdefault(link, cid)
    return out


def _build(hours: int, limit: int, good: bool) -> list[dict]:
    since = int(time.time()) - hours * 3600
    with db() as con:
        rows = con.execute("SELECT link, source, title, published FROM articles WHERE published > ? "
                           "AND published <= strftime('%s','now') + 600 ORDER BY published DESC", (since,)).fetchall()
        conflict_of = _conflict_links(con)
        epicenters = {c["id"]: c.get("epicenter") for c in all_conflicts(con)}
    stories: list[dict] = []
    for link, source, title, published in rows:
        outlet = outlet_of(source)
        if not outlet or outlet in NOT_NEWS or not title:
            continue
        words = _words(title)
        if len(words) < 2:
            continue
        # compare with each story's first (newest) headline only, so stories don't chain into each other
        s = next((s for s in stories if _same_story(words, s["words"])), None)
        if s is None:
            stories.append({"words": words, "title": title, "link": link, "outlet": outlet,
                            "published": published, "outlets": [outlet], "first": published,
                            "titles": [title], "links": [link]})
        else:
            if _minor(s["title"], s["link"]) and not _minor(title, link):
                s.update(title=title, link=link, outlet=outlet, published=published)
            if outlet not in s["outlets"]:
                s["outlets"].append(outlet)
            s["first"] = min(s["first"], published)
            s["titles"].append(title)
            s["links"].append(link)
    stories = [s for s in stories if len(s["outlets"]) > 1 or not _minor(s["title"], s["link"])]
    if good:
        stories = [s for s in stories if goodnews.local_title(s["title"], s["link"])]
    stories.sort(key=lambda s: (-len(s["outlets"]), -s["published"]))
    out = []
    for s in stories[:limit]:
        hits: dict[str, int] = {}
        for u in s["links"]:
            if u in conflict_of:
                hits[conflict_of[u]] = hits.get(conflict_of[u], 0) + 1
        conflict = max(hits, key=hits.get) if hits else None
        place = _place(s["titles"])
        epi = epicenters.get(conflict) if conflict else None
        if not place and epi and epi.get("lat") is not None:
            place = {"name": epi.get("label") or "", "lat": epi["lat"], "lon": epi["lon"], "zoom": 5}
        out.append({**{k: s[k] for k in ("title", "link", "outlet", "published", "outlets", "first")},
                    "topic": "good" if good else _topic(s["titles"]), "conflict": conflict, "place": place})
    return out


def top(limit: int = 10, good: bool = False) -> list[dict]:
    """Cached for a minute: the feeds are only fetched every few minutes anyway."""
    key = (limit, good)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < 60:
            return hit[1]
        items = _build(12, limit, good)
        if len(items) < limit:                     # a quiet night: reach back a full day
            items = _build(24, limit, good)
        _cache[key] = (time.time(), items)
        return items


if __name__ == "__main__":
    import sys
    for h in top(15, good="good" in sys.argv[1:]):
        print(len(h["outlets"]), h["topic"], h["conflict"], (h["place"] or {}).get("name"), "|", h["title"])
