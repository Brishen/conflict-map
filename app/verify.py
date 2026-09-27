"""Check extracted claims against the full text of the article they cite, before they are shown.

The extraction model only sees headlines and one-line feed summaries, so it fills gaps. Every new attack
and development is therefore re-read against its article: supported claims are marked verified,
unsupported ones are dropped, and claims whose article can't be read are kept but marked unverified."""
import logging
import time
from collections import defaultdict

from . import extract, reader

log = logging.getLogger("verify")

MAX_ARTICLES = 25          # per extraction batch; claims beyond this stay unverified
MAX_CHARS = 14000

PROMPT = """You check whether ONE news article supports specific claims. Answer ONLY compact JSON:
{{"results":[{{"n":1,"supported":true,"why":"<= 12 words"}}]}}
A claim is supported only when the article itself reports it: the same event, the same place (or a place
inside it), the same actor, and, wherever the claim gives a number or a casualty figure, the same number.
Detail that the claim leaves out is fine. A claim attributed in the article to one side ("Russia said it
struck ...") still counts as supported. An event the article does not mention, a different place, a different
attacker, a different number or a detail the article does not contain is NOT supported. Judge each claim
on its own; do not use outside knowledge.

ARTICLE ({site}, {date}):
{text}

CLAIMS:
{claims}"""


def _article_text(url: str) -> tuple[str, dict] | None:
    a = reader.fetch(url)
    if not a.get("ok") or a.get("note"):          # "note" = feed-summary fallback, not the article
        return None
    text = "\n".join([a.get("title") or ""] + list(a.get("paragraphs") or []))
    return (text[:MAX_CHARS], a) if len(text) > 400 else None


def _check_article(url: str, claims: list[str]) -> list[bool | None]:
    got = _article_text(url)
    if got is None:
        return [None] * len(claims)
    text, a = got
    listing = "\n".join(f"{i + 1}. {c}" for i, c in enumerate(claims))
    try:
        out = extract.call_llm([{"role": "user", "content": PROMPT.format(
            site=a.get("site") or "", date=a.get("date") or "", text=text, claims=listing)}])
        res = extract._parse_json(out).get("results") or []
    except Exception as e:  # noqa: BLE001
        log.warning("verify %s: %s", url[:80], e)
        return [None] * len(claims)
    verdict = {r.get("n"): r.get("supported") for r in res if isinstance(r, dict)}
    out = []
    for i in range(len(claims)):
        v = verdict.get(i + 1)
        out.append(True if v is True else False if v is False else None)
        if v is False:
            why = next((r.get("why") for r in res if isinstance(r, dict) and r.get("n") == i + 1), "")
            log.info("not supported by %s: %.120s (%s)", url[:60], claims[i], why)
    return out


def check(claims: dict[str, list[tuple[object, str]]]) -> dict[int, bool | None]:
    """claims: article link -> [(claim object, claim text)]. Returns id(claim object) -> verdict, combined over
    every article that cites it: True if any article supports it, False if every readable article rejects
    it, None if none of its articles could be read (or the batch limit was hit)."""
    t0 = time.time()
    seen: dict[int, list] = defaultdict(list)
    for n, (link, items) in enumerate(claims.items()):
        verdicts = _check_article(link, [txt for _, txt in items]) if n < MAX_ARTICLES else [None] * len(items)
        for (obj, _), v in zip(items, verdicts):
            seen[id(obj)].append(v)
    out = {}
    for k, vs in seen.items():
        out[k] = True if True in vs else False if vs and all(v is False for v in vs) else None
    if claims:
        log.info("verified %d claims from %d articles in %.0fs: %d supported, %d rejected, %d unreadable",
                 len(out), len(claims), time.time() - t0, sum(v is True for v in out.values()),
                 sum(v is False for v in out.values()), sum(v is None for v in out.values()))
    return out


def strike_claim(st: dict) -> str:
    tgt, org = st.get("target") or {}, st.get("origin") or {}
    s = f"On {st.get('date')}, {st.get('attacker') or 'an unnamed attacker'} carried out a {st.get('weapon') or 'attack'} attack on {tgt.get('place')}"
    if org.get("place"):
        s += f", launched from {org['place']}"
    if st.get("launched") is not None:
        s += f"; {st['launched']} launched"
    if st.get("intercepted") is not None:
        s += f"; {st['intercepted']} intercepted"
    if st.get("outcome"):
        s += f"; outcome: {st['outcome']}"
    return s + "."


def development_claim(d: dict) -> str:
    return f"On or around {d.get('date')}: {d.get('text')}"
