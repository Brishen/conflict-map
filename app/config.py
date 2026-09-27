import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
DB_PATH = DATA_DIR / "conflict.db"
# public address, for canonical links, the sitemap and link previews
SITE_URL = os.environ.get("SITE_URL", "https://globalnewsmap.org").rstrip("/")

LLM_BASE = os.environ.get("LLM_BASE", "http://127.0.0.1:8080/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-oss-120b")
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "900"))

# hours of GDELT history to backfill on first run / keep in aggregations
GDELT_BACKFILL_HOURS = int(os.environ.get("GDELT_BACKFILL_HOURS", "48"))
GDELT_WINDOW_HOURS = int(os.environ.get("GDELT_WINDOW_HOURS", "48"))

REFRESH_MINUTES = int(os.environ.get("REFRESH_MINUTES", "30"))

# SERVE_ONLY=1: read-only viewer (no GDELT/feeds/LLM), used on the public server.
SERVE_ONLY = os.environ.get("SERVE_ONLY", "0") == "1"
# After each refresh, copy the database to this scp target (e.g. "luma:/root/conflict-map/data"). Empty = off.
PUSH_TARGET = os.environ.get("PUSH_TARGET", "")
# optional: a Discord webhook URL; every visitor's problem report is also posted there (a secret, keep it in .env)
DISCORD_REPORTS_WEBHOOK = os.environ.get("DISCORD_REPORTS_WEBHOOK", "")
ARTICLES_PER_BATCH = int(os.environ.get("ARTICLES_PER_BATCH", "40"))

# Military aircraft layer (public ADS-B). Runs in both pipeline and SERVE_ONLY mode.
AIRCRAFT_ENABLED = os.environ.get("AIRCRAFT_ENABLED", "1") == "1"
# never serve positions fresher than this (don't publish live positions near fighting)
AIRCRAFT_DELAY_MIN = int(os.environ.get("AIRCRAFT_DELAY_MIN", "20"))
AIRCRAFT_TRAIL_MIN = int(os.environ.get("AIRCRAFT_TRAIL_MIN", "30"))
AIRCRAFT_POLL_SECONDS = int(os.environ.get("AIRCRAFT_POLL_SECONDS", "60"))
AIRCRAFT_SOURCES = [   # tried in order; both speak the readsb JSON format
    # adsb.fi first: airplanes.live answers 403 to our home and Hetzner IPs (seen 2026-09-23)
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/mil"),
    ("airplanes.live", "https://api.airplanes.live/v2/mil"),
]
# a source that fails is skipped for this long before it is tried again (403/429 back off longer)
AIRCRAFT_BACKOFF_SECONDS = int(os.environ.get("AIRCRAFT_BACKOFF_SECONDS", "900"))

# Only outlets with strong editorial standards and a public corrections record, whose articles the
# pipeline can read in full: every attack and development is checked against the article text before it
# is shown (app/verify.py). Dropped on purpose: state-controlled or partisan outlets, outlets tied to one
# side of a conflict they cover, aggregators (Google News), analysis sites, and paywalled or bot-blocked
# sites whose claims could not be checked (NYT, Washington Post, France 24, Sky, Reuters/AP via Google).
FEEDS = {
    "BBC World": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "BBC Middle East": "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
    "BBC Africa": "https://feeds.bbci.co.uk/news/world/africa/rss.xml",
    "BBC Europe": "https://feeds.bbci.co.uk/news/world/europe/rss.xml",
    "BBC Asia": "https://feeds.bbci.co.uk/news/world/asia/rss.xml",
    "BBC Latin America": "https://feeds.bbci.co.uk/news/world/latin_america/rss.xml",
    "Guardian World": "https://www.theguardian.com/world/rss",
    "Guardian Ukraine": "https://www.theguardian.com/world/ukraine/rss",
    "Guardian Middle East": "https://www.theguardian.com/world/middleeast/rss",
    "Guardian Africa": "https://www.theguardian.com/world/africa/rss",
    "Guardian Americas": "https://www.theguardian.com/world/americas/rss",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    "DW World": "https://rss.dw.com/rdf/rss-en-world",
    "DW Top": "https://rss.dw.com/rdf/rss-en-top",
    "CBC World": "https://www.cbc.ca/webfeed/rss/rss-world",
    "NPR World": "https://feeds.npr.org/1004/rss.xml",
    "CNN World": "http://rss.cnn.com/rss/edition_world.rss",
    "CBS World": "https://www.cbsnews.com/latest/rss/world",
    "Independent World": "https://www.independent.co.uk/news/world/rss",
    "Euronews": "https://www.euronews.com/rss",
    "Africanews": "https://www.africanews.com/feed/rss",
    # UN / humanitarian: casualty, displacement and access reporting
    "UN News": "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
    "OHCHR": "https://www.ohchr.org/en/rss.xml",
    "ReliefWeb": "https://reliefweb.int/updates/rss.xml",
    "ICRC": "https://www.icrc.org/en/rss/news",
    # open-source verification
    "Bellingcat": "https://www.bellingcat.com/feed/",
    # cyber mode only: never read by the conflict extraction (see CYBER_FEEDS)
    "The Record": "https://therecord.media/feed",
    "BleepingComputer": "https://www.bleepingcomputer.com/feed/",
    "SecurityWeek": "https://www.securityweek.com/feed/",
    "Dark Reading": "https://www.darkreading.com/rss.xml",
    "Krebs on Security": "https://krebsonsecurity.com/feed/",
}
CYBER_FEEDS = {"The Record", "BleepingComputer", "SecurityWeek", "Dark Reading", "Krebs on Security"}

# Who publishes each feed. "country" is used to label an outlet from a country that is itself a party to
# the conflict being shown (a US outlet on a US conflict); "note" explains the outlet in the About panel.
OUTLETS = {
    "BBC": {"feeds": "BBC ", "country": "GBR", "note": "UK public broadcaster"},
    "The Guardian": {"feeds": "Guardian ", "country": "GBR", "note": "UK newspaper"},
    "Al Jazeera": {"feeds": "Al Jazeera", "country": "QAT", "note": "Qatari state-funded broadcaster"},
    "DW": {"feeds": "DW ", "country": "DEU", "note": "German public broadcaster"},
    "CBC": {"feeds": "CBC ", "country": "CAN", "note": "Canadian public broadcaster"},
    "NPR": {"feeds": "NPR ", "country": "USA", "note": "US public radio"},
    "CNN": {"feeds": "CNN ", "country": "USA", "note": "US broadcaster"},
    "CBS News": {"feeds": "CBS ", "country": "USA", "note": "US broadcaster"},
    "The Independent": {"feeds": "Independent ", "country": "GBR", "note": "UK newspaper"},
    "Euronews": {"feeds": "Euronews", "country": None, "note": "pan-European broadcaster"},
    "Africanews": {"feeds": "Africanews", "country": None, "note": "pan-African broadcaster (Euronews group)"},
    "UN News": {"feeds": "UN News", "country": None, "note": "United Nations news service"},
    "OHCHR": {"feeds": "OHCHR", "country": None, "note": "UN human rights office"},
    "ReliefWeb": {"feeds": "ReliefWeb", "country": None, "note": "UN OCHA humanitarian reports"},
    "ICRC": {"feeds": "ICRC", "country": None, "note": "International Committee of the Red Cross"},
    "Bellingcat": {"feeds": "Bellingcat", "country": "NLD", "note": "open-source investigators"},
    "The Record": {"feeds": "The Record", "country": "USA", "note": "cybersecurity newsroom of Recorded Future", "cyber": True},
    "BleepingComputer": {"feeds": "BleepingComputer", "country": "USA", "note": "cybersecurity news site", "cyber": True},
    "SecurityWeek": {"feeds": "SecurityWeek", "country": "USA", "note": "cybersecurity news site", "cyber": True},
    "Dark Reading": {"feeds": "Dark Reading", "country": "USA", "note": "cybersecurity news site", "cyber": True},
    "Krebs on Security": {"feeds": "Krebs on Security", "country": "USA", "note": "investigative cybercrime reporter", "cyber": True},
}


def outlet_of(feed: str | None) -> str | None:
    """Feed name ("BBC Middle East") -> outlet ("BBC"); None for a feed no longer used."""
    for name, o in OUTLETS.items():
        prefix = o["feeds"]         # "BBC " matches every BBC desk; "Al Jazeera" only that exact feed
        if feed == prefix.strip() or (prefix.endswith(" ") and (feed or "").startswith(prefix)):
            return name
    return None


# Articles whose title+summary match none of these never reach the LLM (processed=2).
RELEVANCE_TERMS = [
    "war", "strike", "airstrike", "missile", "drone", "attack", "troops", "military", "army", "rebel",
    "militant", "insurgen", "ceasefire", "offensive", "shelling", "artillery", "bomb", "killed", "clash",
    "fighting", "forces", "soldier", "navy", "naval", "warship", "jets", "occupied", "occupation",
    "front line", "frontline", "siege", "coup", "hostage", "terror", "jihad", "militia", "mercenar",
    "sanction", "refugee", "displaced", "humanitarian", "famine", "blockade", "invasion", "invade",
    "conflict", "combat", "weapon", "nuclear", "hezbollah", "hamas", "houthi", "taliban", "isis",
    "islamic state", "wagner", "kremlin", "nato", "idf", "peacekeep", "junta", "armed", "casualt",
    "massacre", "genocide", "gaza", "ukraine", "sudan", "yemen", "myanmar", "sahel", "congo", "somalia",
    "guerrill", "cartel", "gang", "paramilitar", "farc", "dissident", "haiti",
]

# Cyber mode. Attacks between countries come from Cloudflare Radar (free API token with "Radar: Read";
# without one that layer is off). Ransomware claims (ransomware.live) and outages (IODA) need no key.
CLOUDFLARE_RADAR_TOKEN = os.environ.get("CLOUDFLARE_RADAR_TOKEN", "")
CYBER_BATCH = int(os.environ.get("CYBER_BATCH", "15"))              # articles per model call
CYBER_MAX_BATCHES = int(os.environ.get("CYBER_MAX_BATCHES", "4"))   # per refresh

# Military ships (AIS via aisstream.io, free API key: https://aisstream.io). Off without a key.
AISSTREAM_API_KEY = os.environ.get("AISSTREAM_API_KEY", "")
SHIPS_DELAY_MIN = int(os.environ.get("SHIPS_DELAY_MIN", "20"))       # same safety delay as aircraft
SHIPS_TRAIL_MIN = int(os.environ.get("SHIPS_TRAIL_MIN", "180"))      # ships are slow: longer trails
SHIPS_STALE_MIN = int(os.environ.get("SHIPS_STALE_MIN", "360"))      # drop a ship not heard from in 6 h
# Only listen where it matters (keeps the global stream small on a 2-vCPU box). [[lat, lon], [lat, lon]] corners.
SHIPS_BOXES = [
    [[40.0, 27.0], [47.5, 42.0]],     # Black Sea
    [[30.0, -6.0], [46.0, 36.5]],     # Mediterranean
    [[11.0, 32.0], [30.0, 44.0]],     # Red Sea + Suez
    [[10.0, 42.0], [30.5, 62.0]],     # Gulf of Aden, Arabian Sea, Persian Gulf, Hormuz
    [[53.0, 9.0], [66.0, 31.0]],      # Baltic
    [[49.0, -11.0], [62.0, 9.0]],     # North Sea, Channel
    [[0.0, 105.0], [26.0, 125.0]],    # South China Sea
    [[21.0, 117.0], [35.0, 132.0]],   # Taiwan Strait, East China Sea, Korea
    [[10.0, -90.0], [27.0, -60.0]],   # Caribbean
]
