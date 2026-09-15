"""Telegram notification helper for the andelsbolig-bot pipeline.

Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from a .env file in the project
root (or from the environment). Uses only the standard library so it runs
anywhere without pip installs.
"""
import os
import json
import urllib.request
import urllib.parse

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
TOKEN = ENV.get("TELEGRAM_BOT_TOKEN")
CHAT_ID = ENV.get("TELEGRAM_CHAT_ID")


def send_message(text, parse_mode="HTML", disable_preview=False):
    if not TOKEN or not CHAT_ID:
        raise RuntimeError("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env")
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": str(disable_preview).lower(),
    }).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def format_alert(group_name, group_url, post_text, post_url=None, draft_reply=None):
    lines = [
        f"<b>Nyt opslag i {group_name}</b>",
        "",
        post_text.strip()[:800],
        "",
    ]
    if post_url:
        lines.append(f'<a href="{post_url}">Aabn opslag</a>')
    else:
        lines.append(f'<a href="{group_url}">Aabn gruppe (nyeste opslag)</a>')
    if draft_reply:
        lines.append("")
        lines.append("<b>Forslag til besked:</b>")
        lines.append(draft_reply.strip())
    return "\n".join(lines)


if __name__ == "__main__":
    test_text = format_alert(
        group_name="Andelsbolig til salg (TEST)",
        group_url="https://www.facebook.com/groups/andelsbolig.til.salg",
        post_text=(
            "Dette er en test af notifikations-pipelinen. "
            "Saelger 3 vaer. andelsbolig paa Oesterbro, 85 kvm, pris 1.450.000 kr."
        ),
        post_url=None,
        draft_reply=(
            "Hej! Jeg saa jeres opslag om andelsboligen og er meget interesseret. "
            "Er den stadig til salg, og maa jeg hoere mere om den?"
        ),
    )
    result = send_message(test_text)
    print(json.dumps(result, indent=2, ensure_ascii=False))
