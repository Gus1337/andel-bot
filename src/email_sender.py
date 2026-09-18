"""Sends an inquiry email via Gmail SMTP (app password), triggered by the
userscript's "Send Email" button.

Reads GMAIL_ADDRESS and GMAIL_APP_PASSWORD from .env or the environment.
GMAIL_APP_PASSWORD must be a Google Account "app password" (Gmail with
2-step verification enabled -> App passwords), not the normal login password.
"""
import os
import smtplib
from email.message import EmailMessage

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
GMAIL_ADDRESS = ENV.get("GMAIL_ADDRESS")
GMAIL_APP_PASSWORD = ENV.get("GMAIL_APP_PASSWORD")


def send_email(to_email: str, subject: str, body: str):
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD:
        raise RuntimeError("Missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD in .env")

    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        smtp.send_message(msg)


if __name__ == "__main__":
    send_email(
        GMAIL_ADDRESS or "test@example.com",
        "Test fra andelsbolig-bot",
        "Dette er en test af email_sender.py.",
    )
    print("sent")
