"""OpenAI-based drafting of an inquiry message (English + Danish) to send to
the seller of an andelsbolig listing found by the userscript's "Generate
Message" button.

Reads OPENAI_API_KEY (required) and OPENAI_MODEL (optional, defaults below)
from .env or the environment -- same convention as src/classify.py.
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
MODEL = ENV.get("OPENAI_MODEL", "gpt-4o-mini")

SYSTEM_PROMPT = """Du hjaelper en koeber med at skrive en kort, hoeflig
henvendelse til saelgeren af en andelsbolig, ud fra et Facebook-opslag.

Formaal: udtrykke reel interesse i at KOEBE andelsboligen, sporge om den
stadig er til salg, og bede om et fremvisningstidspunkt eller flere
detaljer/billeder hvis relevant. Hold det kort (3-5 saetninger), venligt og
konkret -- ingen skabelonagtige fyldord.

Brugerens ekstra kontekst (hvis givet) skal indarbejdes naturligt.

Svar UDELUKKENDE med gyldig JSON i formatet:
{"danish": "...", "english": "..."}
hvor "english" er en naturlig engelsk oversaettelse af den danske besked
(ikke en bogstavelig gennemgang)."""


def generate_message(content: str, post_url: str = "", user_context: str = "") -> tuple[str, str]:
    if not API_KEY:
        raise RuntimeError("Missing OPENAI_API_KEY in .env")

    user_parts = [f"Opslag:\n{content.strip()[:3000]}"]
    if post_url:
        user_parts.append(f"Link: {post_url}")
    if user_context:
        user_parts.append(f"Ekstra kontekst fra brugeren: {user_context.strip()[:500]}")

    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "\n\n".join(user_parts)},
        ],
        "temperature": 0.4,
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

    raw = data["choices"][0]["message"]["content"]
    try:
        parsed = json.loads(raw)
        return str(parsed.get("english", "")), str(parsed.get("danish", ""))
    except (json.JSONDecodeError, KeyError):
        raise RuntimeError(f"could not parse model response: {raw!r}")


if __name__ == "__main__":
    english, danish = generate_message(
        "Saelger min andelsbolig paa Oesterbro, 3 vaer, 85 kvm, 1.450.000 kr.",
        post_url="https://www.facebook.com/groups/123/posts/456/",
    )
    print("DA:", danish)
    print("EN:", english)
