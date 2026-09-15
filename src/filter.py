"""Fixed-rule pre-filter for andelsbolig-bot.

Cheap, fast pass that runs before the OpenAI classification step. Its job
is only to discard obvious noise (bytte-requests, "soeges"-posts, unrelated
chatter) -- not to make the final call. Anything ambiguous should be left
IN (False negatives here are expensive: a missed listing. False positives
just cost one extra OpenAI call).

No price or area filtering yet (not specified) -- add rules in
PRICE_MAX / AREAS below once you have numbers, everything currently passes
through on those dimensions.
"""
import re

# Posts containing these are almost certainly NOT a for-sale listing.
EXCLUDE_PATTERNS = [
    r"\bbytte(s|r)?\b",
    r"\bbytning\b",
    r"\b(ø|oe)nsker?\b.*\bandelsbolig\b",   # "ønsker andelsbolig" = looking to buy, not selling
    r"\bs(ø|oe)ge(r|s)?\b.*\bandelsbolig\b", # "søger andelsbolig"
    r"\budlejes\b",
    r"\bfremlejes\b",
    r"\bleje(s)?\b(?!.{0,20}k(ø|oe)b)",      # "lejes" without "køb" nearby
    r"\bmangler\b.*\b(m(ø|oe)bler|hj(æ|ae)lp|flyttehj(æ|ae)lp)\b",
]

# Posts should contain at least one of these to look like an actual listing.
INCLUDE_SIGNALS = [
    r"\btil\s*salg\b",
    r"\bs(æ|ae)lger\b",
    r"\bs(æ|ae)lges\b",
    r"\bandelsbolig\b",
    r"\bandelslejlighed\b",
    r"\bkr\.?\b",
    r"\bkvm\b",
    r"\bm2\b",
    r"\bm(å|aa)nedlig(t)?\s*boligafgift\b",
]

PRICE_MAX = None   # e.g. 2_000_000 -- set once you have a number
PRICE_MIN = None
AREAS = []         # e.g. ["østerbro", "nørrebro", "2100", "2200"] -- set once you have a list


def _find_price(text: str):
    # Matches "1.450.000 kr", "1450000 kr", "1.450.000,-"
    m = re.search(r"(\d{1,3}(?:[.\s]\d{3}){1,3})\s*(?:kr\.?|,-)", text, re.I)
    if not m:
        return None
    digits = re.sub(r"[.\s]", "", m.group(1))
    try:
        return int(digits)
    except ValueError:
        return None


def passes_filter(text: str) -> tuple[bool, str]:
    """Returns (passes, reason) -- reason is always set, useful for logging."""
    t = text.lower()

    for pat in EXCLUDE_PATTERNS:
        if re.search(pat, t, re.I):
            return False, f"excluded by pattern: {pat}"

    if not any(re.search(pat, t, re.I) for pat in INCLUDE_SIGNALS):
        return False, "no for-sale signal found"

    if AREAS and not any(area.lower() in t for area in AREAS):
        return False, "no matching area"

    price = _find_price(text)
    if price is not None:
        if PRICE_MAX is not None and price > PRICE_MAX:
            return False, f"price {price} above PRICE_MAX"
        if PRICE_MIN is not None and price < PRICE_MIN:
            return False, f"price {price} below PRICE_MIN"
    # price is None (e.g. "pris efter aftale") -> let it through, OpenAI step decides

    return True, "passed rule filter"


if __name__ == "__main__":
    samples = [
        "Sælger min andelsbolig på Østerbro, 85 kvm, 3 vær. Pris 1.450.000 kr.",
        "Byttes: 2 vær. andelsbolig i Valby ønskes byttet til 3 vær.",
        "Vi ønsker at købe en andelsbolig i KBH, gerne 3 vær.",
        "Andelsbolig til salg, pris efter aftale, kontakt for visning.",
        "Nogen der har erfaring med andelsboligforeninger generelt?",
        "Sælges: dejlig 2 vær. andelsbolig, 1.950.000 kr, 65 kvm, Nørrebro.",
    ]
    for s in samples:
        ok, reason = passes_filter(s)
        print(f"[{'PASS' if ok else 'DROP'}] {reason:35s} | {s}")
