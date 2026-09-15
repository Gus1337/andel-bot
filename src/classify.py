"""OpenAI-based classifier: is this Danish Facebook post a genuine
for-sale andelsbolig (housing co-op apartment) listing?

Runs AFTER the cheap keyword filter (src/filter.py) -- only posts that
already passed the rule filter should reach this, since it costs real
money per call (though at nano/mini pricing, trivially small for this
volume).

Reads OPENAI_API_KEY (required) and OPENAI_MODEL (optional, defaults
below) from .env or the environment. Uses only the standard library.
"""
import os
import json
import urllib.request
import urllib.error

try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(HERE, ".env")


def load_env(path=ENV_PATH):
    env = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


ENV = {**load_env(), **os.environ}
API_KEY = ENV.get("OPENAI_API_KEY")
# Cheap, small model is plenty for this yes/no classification task.
# Verify this string is still valid for your account/org -- OpenAI's
# model lineup changes; swap via OPENAI_MODEL in .env if needed.
MODEL = ENV.get("OPENAI_MODEL", "gpt-4o-mini")

SYSTEM_PROMPT = """Du vurderer danske Facebook-opslag fra grupper om andelsboliger.
Opgave: afgør om opslaget er et RIGTIGT SALGSOPSLAG for en andelsbolig
(nogen der sælger deres egen andelsbolig).

Svar NEJ (is_listing: false) hvis opslaget i stedet er:
- et bytte-opslag (nogen der vil bytte deres bolig)
- et "søges/ønskes"-opslag (nogen der leder efter en bolig at købe)
- en udlejning/fremleje, ikke et salg
- et spørgsmål, en diskussion, eller ikke relateret til en konkret bolig til salg
- reklame/spam der ikke er en reel bolig

Svar JA (is_listing: true) kun hvis det tydeligt er nogen der sælger deres
egen andelsbolig.

Svar UDELUKKENDE med gyldig JSON i formatet:
{"is_listing": true or false, "reason": "kort begrundelse på dansk"}
"""


def classify_post(text: str) -> tuple[bool, str]:
    if not API_KEY:
        raise RuntimeError("Missing OPENAI_API_KEY in .env")

    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text.strip()[:3000]},
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"OpenAI API error {e.code}: {e.read().decode('utf-8', 'ignore')}")

    content = data["choices"][0]["message"]["content"]
    try:
        parsed = json.loads(content)
        return bool(parsed.get("is_listing")), str(parsed.get("reason", ""))
    except (json.JSONDecodeError, KeyError):
        # Model didn't return clean JSON -- fail safe to "not a listing"
        # rather than risk a false positive, but surface the raw text.
        return False, f"could not parse model response: {content!r}"


if __name__ == "__main__":
    samples = [
        "Sælges: dejlig 2 vær. andelsbolig, 1.950.000 kr, 65 kvm, Nørrebro. Kontakt for visning.",
        "Andelsbolig til salg, pris efter aftale, kontakt for visning.",
        "Hvem har erfaring med at sidde i en andelsboligforenings bestyrelse?",
    ]
    for s in samples:
        is_listing, reason = classify_post(s)
        print(f"[{'JA ' if is_listing else 'NEJ'}] {reason}  |  {s}")
