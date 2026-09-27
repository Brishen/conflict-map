"""Top headlines: the stories most outlets are carrying right now.

Headlines from the last hours are grouped into stories by the words they share, and a story ranks by
how many different outlets ran it (then by how recent it is). Rough on purpose: two outlets rarely word
a headline the same way, so a story is only counted once it clearly shares its key words."""
import re
import threading
import time

from . import goodnews
from .config import outlet_of
from .db import db

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


def _build(hours: int, limit: int, good: bool) -> list[dict]:
    since = int(time.time()) - hours * 3600
    with db() as con:
        rows = con.execute("SELECT link, source, title, published FROM articles WHERE published > ? "
                           "AND published <= strftime('%s','now') + 600 ORDER BY published DESC", (since,)).fetchall()
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
                            "published": published, "outlets": [outlet], "first": published})
        else:
            if _minor(s["title"], s["link"]) and not _minor(title, link):
                s.update(title=title, link=link, outlet=outlet, published=published)
            if outlet not in s["outlets"]:
                s["outlets"].append(outlet)
            s["first"] = min(s["first"], published)
    stories = [s for s in stories if len(s["outlets"]) > 1 or not _minor(s["title"], s["link"])]
    if good:
        stories = [s for s in stories if goodnews.local_title(s["title"], s["link"])]
    stories.sort(key=lambda s: (-len(s["outlets"]), -s["published"]))
    return [{k: s[k] for k in ("title", "link", "outlet", "published", "outlets", "first")} for s in stories[:limit]]


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
        print(len(h["outlets"]), h["outlet"], "|", h["title"], "|", ", ".join(h["outlets"]))
