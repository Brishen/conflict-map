"""Good news mode: which developments and local stories count as good news.

Strict on purpose: anything that mentions violence, failure or loss is left out, even when
the rest of the sentence is hopeful ("ceasefire holds despite shelling")."""
import re

BAD = re.compile(
    r"\b(kill|dead|death|die[ds]?\b|dying|casualt|wound|injur|attack|strike|shell|bomb|missile|drone|rocket|"
    r"airstrike|massacre|clash|fight|offensive|assault|explo|shot|shoot|gunfire|violat|collaps|stall|fail|"
    r"reject|suspend|broke down|breaks down|threat|hostilit|siege|famine|starv|abduct|kidnap|hostage-tak|"
    r"execut|captur|seiz|invad|invasion|escalat|sanction|condemn|accus|warn|crisis|war\b|terror|"
    r"murder|stab|rape|arrest|charged|jail|prison(?!er)|sentenc|guilty|victim|fraud|scam|crash|fire\b|"
    r"blaze|flood|storm|earthquake|obituar|funeral|missing|lawsuit|layoff|recession|protest|riot|"
    r"police|court|outcry|refus|den(y|ies|ied)|halt|block)", re.I)

GOOD = re.compile(
    r"\b(cease-?fire|truce|peace|armistice|agreement|accord|deal\b|talks|negotiat|releas|freed|swap|"
    r"prisoner exchange|exchange of prisoners|return(ed|ing)? home|returnees|reopen|reconstruct|rebuild|"
    r"de-escalat|troops? withdr|disarm|demobili|amnesty|reconcil|mediat|humanitarian (corridor|access)|"
    r"aid (convoy|deliver|arriv|reach))", re.I)


def development(d: dict) -> bool:
    """True when a conflict development is progress: ceasefires, talks, releases, aid getting through,
    people returning, rebuilding. Uses the model's own tag when it gave one, else the keyword list."""
    text = d.get("text") or ""
    if BAD.search(text):
        return False
    return d["good"] is True if "good" in d else bool(GOOD.search(text))


def local_title(title: str | None, url: str = "") -> bool:
    """A positive-tone local headline that is not about crime, disasters or conflict (the URL path is
    checked too: the headline is read from one slug segment and can miss "33-death-notices")."""
    path = re.sub(r"^https?://[^/]+", "", url or "").replace("-", " ").replace("_", " ")
    return bool(title) and not BAD.search(title) and not BAD.search(path)
