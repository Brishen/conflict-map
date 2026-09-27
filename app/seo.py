"""What search engines and link previews see: the app shell with real page titles, descriptions and
server-rendered text for the home page, one page per conflict and the about page, plus robots.txt and
sitemap.xml. The app replaces the rendered text with the live list once its script has loaded."""
import json
import re
import time
from datetime import datetime, timezone
from functools import lru_cache
from html import escape
from urllib.parse import urlsplit

from . import countries
from .config import OUTLETS, SITE_URL, STATIC_DIR
from .db import all_conflicts, db

SITE_NAME = "Global News Map"
STATUS_LABEL = {"escalating": "escalating", "active": "active", "de-escalating": "easing",
                "ceasefire": "ceasefire", "frozen": "frozen"}
ROLE_LABEL = {"combatant": "fighting", "supporter": "backing", "mediator": "mediating"}
OG_IMAGE = f"{SITE_URL}/static/og.jpg"


def esc(s) -> str:
    return escape(str(s or ""), quote=True)


def clip(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[:n - 1].rsplit(" ", 1)[0].rstrip(",;:–-") + "…"


def day(ts) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%-d %B %Y") if ts else ""


def iso(ts) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds") if ts else ""


@lru_cache(maxsize=1)
def _country_names() -> dict:
    return {k: (v.get("name") or "").replace("United States of America", "United States")
            for k, v in countries.table()["iso3"].items()}


def country_name(iso3) -> str:
    return _country_names().get(iso3 or "", "")


def _host(url: str) -> str:
    return re.sub(r"^www\.", "", urlsplit(url or "").netloc)


def conflict_path(cid: str) -> str:
    return f"/conflict/{cid}"


# ---- conflicts, cached for a minute: every page view and the sitemap read them
_cache: dict = {}


def conflicts() -> list[dict]:
    if _cache.get("t", 0) > time.time() - 60:
        return _cache["v"]
    with db() as con:
        cs = all_conflicts(con)
    cs.sort(key=lambda c: (-(c.get("severity") or 0), -(c.get("updated") or 0)))
    _cache.update(t=time.time(), v=cs)
    return cs


def conflict(cid: str) -> dict | None:
    return next((c for c in conflicts() if c["id"] == cid), None)


# ---- <head>
def head(title: str, description: str, path: str, ld: list[dict], noindex: bool = False) -> str:
    url = SITE_URL + path
    tags = [
        f"<title>{esc(title)}</title>",
        f'<meta name="description" content="{esc(description)}">',
        f'<link rel="canonical" href="{esc(url)}">' if not noindex else '<meta name="robots" content="noindex">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{SITE_NAME}">',
        f'<meta property="og:title" content="{esc(title)}">',
        f'<meta property="og:description" content="{esc(description)}">',
        f'<meta property="og:url" content="{esc(url)}">',
        f'<meta property="og:image" content="{OG_IMAGE}">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        f'<meta property="og:image:alt" content="{SITE_NAME}: a globe marking the wars and armed conflicts in the news">',
        '<meta property="og:locale" content="en_GB">',
        '<meta name="twitter:card" content="summary_large_image">',
        f'<meta name="twitter:title" content="{esc(title)}">',
        f'<meta name="twitter:description" content="{esc(description)}">',
        f'<meta name="twitter:image" content="{OG_IMAGE}">',
    ]
    for d in ld:
        # "</" can't end the script element early inside the JSON
        tags.append('<script type="application/ld+json">' + json.dumps(d, ensure_ascii=False).replace("</", "<\\/") + "</script>")
    return "\n".join(tags)


def _website_ld() -> dict:
    return {"@context": "https://schema.org", "@type": "WebSite", "name": SITE_NAME, "url": SITE_URL + "/",
            "description": "A live world map of armed conflicts built from established news outlets.",
            "inLanguage": "en"}


def _breadcrumbs(*items) -> dict:
    return {"@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": SITE_URL + p}
                                for i, (n, p) in enumerate(items)]}


# ---- body text
def _card(c: dict) -> str:
    st = c.get("status") or ""
    return (f'<a class="card" href="{conflict_path(esc(c["id"]))}" data-id="{esc(c["id"])}">'
            f'<div class="head"><span class="name">{esc(c.get("name"))}</span>'
            f'<span class="badge st-{esc(st)}">{esc(STATUS_LABEL.get(st, st))}</span></div>'
            f'<div class="region">{esc(c.get("region"))} · updated {esc(day(c.get("updated")))}</div>'
            f'<p class="ssr-sum">{esc(clip(c.get("summary") or "", 220))}</p></a>')


def home_body(cs: list[dict]) -> str:
    if not cs:
        return ""
    newest = max((c.get("updated") or 0) for c in cs)
    return (f'<section class="ssr"><h2 class="ssr-h">Wars and armed conflicts in the news, {esc(day(newest))}</h2>'
            + "".join(_card(c) for c in cs)
            + '<p class="ssr-foot"><a href="/about">How this works: sources and checks</a></p></section>')


def _party(p: dict) -> str:
    where = country_name(p.get("country"))
    where = "" if where == p.get("name") else where
    role = ROLE_LABEL.get(p.get("role"), p.get("role") or "")
    side = f", side {esc(p['side'])}" if p.get("side") in ("A", "B") and p.get("role") != "mediator" else ""
    note = f": {esc(p['note'])}" if p.get("note") else ""
    return f'<li><b>{esc(p.get("name"))}</b>{f" ({esc(where)})" if where else ""}, {esc(role)}{side}{note}</li>'


def _dev(d: dict) -> str:
    links = " ".join(f'<a href="{esc(u)}" target="_blank" rel="noopener nofollow">{esc(_host(u))}</a>'
                     for u in (d.get("sources") or [])[:3])
    date = f'<time datetime="{esc(d["date"])}">{esc(d["date"])}</time> ' if d.get("date") else ""
    return f"<li>{date}{esc(d.get('text'))}{f' <span class=\"ssr-src\">{links}</span>' if links else ''}</li>"


def conflict_body(c: dict, cs: list[dict]) -> str:
    st = c.get("status") or ""
    devs = sorted(c.get("developments") or [], key=lambda d: d.get("date") or "", reverse=True)[:15]
    cons = [x for x in c.get("consequences") or [] if x.get("text")][:10]
    others = [o for o in cs if o["id"] != c["id"]][:12]
    parts = [
        '<article class="ssr">',
        '<nav class="ssr-crumb" aria-label="Breadcrumb"><a href="/">All conflicts</a></nav>',
        f'<h1 class="ssr-title">{esc(c.get("name"))}</h1>',
        f'<div class="region">{esc(c.get("region"))} · <span class="badge st-{esc(st)}">{esc(STATUS_LABEL.get(st, st))}</span>'
        f' · severity {esc(c.get("severity") or "?")}/5 · updated {esc(day(c.get("updated")))}</div>',
        f'<p>{esc(c.get("summary"))}</p>',
    ]
    if c.get("parties"):
        parts.append("<h2>Who is involved</h2><ul>" + "".join(_party(p) for p in c["parties"]) + "</ul>")
    if devs:
        parts.append("<h2>Latest developments</h2><ul class=\"ssr-devs\">" + "".join(_dev(d) for d in devs) + "</ul>")
    if cons:
        parts.append("<h2>Consequences</h2><ul>" + "".join(
            f"<li>{esc((x.get('category') or '').capitalize())}{': ' if x.get('category') else ''}{esc(x['text'])}</li>" for x in cons) + "</ul>")
    parts.append('<p class="ssr-foot">Summarised by AI from established news outlets and checked against the articles. '
                 '<a href="/about">How this works</a>.</p>')
    if others:
        parts.append("<h2>Other conflicts</h2><ul class=\"ssr-others\">" + "".join(
            f'<li><a href="{conflict_path(esc(o["id"]))}">{esc(o.get("name"))}</a></li>' for o in others) + "</ul>")
    parts.append("</article>")
    return "".join(parts)


def about_body() -> str:
    outlets = "".join(f"<li><b>{esc(k)}</b> {esc(v.get('note'))}</li>" for k, v in OUTLETS.items() if not v.get("cyber"))
    return f"""<article class="ssr">
<nav class="ssr-crumb" aria-label="Breadcrumb"><a href="/">All conflicts</a></nav>
<h1 class="ssr-title">How Global News Map works</h1>
<p>Global News Map reads a small set of established news outlets every 30 minutes. An AI model running on our own machine
turns those reports into the conflicts, parties, developments and attacks shown on the map. It is a news digest, not an
intelligence product. Don't rely on it for safety decisions.</p>
<h2>Sources</h2>
<p>Only outlets with strong editorial standards and a public corrections record, whose articles we can read in full:</p>
<ul>{outlets}</ul>
<h2>How claims are checked</h2>
<p>Every new attack and development is re-read against the full text of the article it cites and thrown away if the
article doesn't say it. Each item shows how many independent outlets reported it, and whether the outlet is based in a
country that is itself a party to the conflict.</p>
<h2>Automatic layers</h2>
<p>News heat, incidents and local news come from GDELT. Military aircraft and ships are public transponder data, shown at
least 20 minutes late. Occupied territory in Ukraine comes from DeepStateMap.Live; weather from RainViewer, Open-Meteo and
GDACS; cyber attacks from Cloudflare Radar, ransomware.live and IODA.</p>
<p>On a first visit the globe turns to your country, looked up from your IP address in a local copy of
<a href="https://db-ip.com">DB-IP</a>'s free database; the address isn't sent anywhere else or kept.</p>
<p class="ssr-foot"><a href="https://github.com/Comm4nd0/conflict-map">Source code on GitHub</a></p>
</article>"""


# ---- whole pages
def _list_names(cs: list[dict], n: int) -> str:
    return ", ".join(c["name"] for c in cs[:n] if c.get("name"))


def page(path: str) -> tuple[int, str, str] | None:
    """(status, head html, body html) for a page path, or None when there is no such page."""
    cs = conflicts()
    if path == "/":
        names = _list_names(cs, 4)
        desc = clip(f"Live map of the wars and armed conflicts in the news{': ' + names if names else ''}. "
                    "Attacks, who backs whom and the latest developments, with sources, updated every 30 minutes.", 300)
        ld = [_website_ld()]
        if cs:
            ld.append({"@context": "https://schema.org", "@type": "ItemList", "name": "Armed conflicts in the news",
                       "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": c.get("name"),
                                            "url": SITE_URL + conflict_path(c["id"])} for i, c in enumerate(cs)]})
        return 200, head(f"{SITE_NAME}: live map of wars and conflicts", desc, "/", ld), home_body(cs)
    if path == "/about":
        desc = ("How Global News Map turns reports from established news outlets into a live conflict map: "
                "which outlets it reads, how every claim is checked against its article, and where the map layers come from.")
        ld = [_breadcrumbs((SITE_NAME, "/"), ("How it works", "/about"))]
        return 200, head(f"How it works: sources and checks | {SITE_NAME}", desc, "/about", ld), about_body()
    m = re.fullmatch(r"/conflict/([a-z0-9-]{1,64})", path)
    if not m:
        return None
    c = conflict(m.group(1))
    if not c:
        return 404, head(f"Conflict not found | {SITE_NAME}", "This conflict is no longer on the map.", path, [], noindex=True), home_body(cs)
    p = conflict_path(c["id"])
    title = f"{c.get('name')}: live map and latest news | {SITE_NAME}"
    desc = clip(c.get("summary") or f"Live map and latest developments of {c.get('name')}.", 300)
    ld = [{"@context": "https://schema.org", "@type": "WebPage", "name": title, "url": SITE_URL + p,
           "description": desc, "inLanguage": "en", "isPartOf": {"@type": "WebSite", "name": SITE_NAME, "url": SITE_URL + "/"},
           "datePublished": iso(c.get("created")), "dateModified": iso(c.get("updated")),
           "about": [{"@type": "Place", "name": n} for n in dict.fromkeys(
               country_name(x.get("country")) for x in c.get("parties") or [] if x.get("role") == "combatant") if n]},
          _breadcrumbs((SITE_NAME, "/"), (c.get("name"), p))]
    return 200, head(title, desc, p, ld), conflict_body(c, cs)


def robots() -> str:
    return (f"User-agent: *\nDisallow: /api/article\nDisallow: /api/report\n\n"
            f"Sitemap: {SITE_URL}/sitemap.xml\n")


def sitemap() -> str:
    cs = conflicts()
    newest = max([c.get("updated") or 0 for c in cs] or [int(time.time())])
    urls = [("/", newest, "hourly", "1.0"), ("/about", None, "monthly", "0.5")]
    urls += [(conflict_path(c["id"]), c.get("updated"), "hourly", "0.8") for c in cs]
    rows = "".join(
        f"<url><loc>{esc(SITE_URL + p)}</loc>{f'<lastmod>{iso(t)}</lastmod>' if t else ''}"
        f"<changefreq>{f}</changefreq><priority>{pr}</priority></url>" for p, t, f, pr in urls)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{rows}</urlset>\n'


def render(shell: str, path: str) -> tuple[int, str] | None:
    """The app shell (index.html) filled in for one page."""
    r = page(path)
    if r is None:
        return None
    status, head_html, body_html = r
    html = re.sub(r"<!--seo-head-->.*?<!--/seo-head-->", lambda _: head_html, shell, flags=re.S)
    if body_html:
        html = re.sub(r'<div id="list" aria-busy="true">.*?</div>\s*<div id="detail"',
                      lambda _: f'<div id="list">{body_html}</div>\n    <div id="detail"', html, count=1, flags=re.S)
    if path != "/":      # the page's own title is its h1; the site name stays a plain heading-less label
        html = html.replace('<h1 class="site">Global News Map</h1>', '<a class="site" href="/">Global News Map</a>')
    return status, html
