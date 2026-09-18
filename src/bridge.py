#!/usr/bin/env python3
"""
Bridge: receives events from the Tampermonkey userscript
(tampermonkey/group-watcher.user.js, "FB Rental Parser V10" build) and runs
the filter -> classify -> notify pipeline, plus the userscript's on-demand
message-generation / manual send buttons.

Listens on 127.0.0.1:9999 (localhost only, not exposed externally).

POST /webdriver-check  body: {"value": "...", "type": "..."}
POST /post             body: {"postUrl", "bestGuessUrl", "content",
                               "postedText", "contentHash", "pageUrl"}
POST /generate-message body: {"content", "post_url", "user_context"}
POST /send-email       body: {"to_email", "post_url", "content", "body"?}
POST /send-to-telegram body: {"message"}
POST /debug-post       body: userscript's enriched debug dump (saved to disk)
GET  /health           responds {"status": "ok"}
"""

import json
import logging
import os
import sqlite3
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from filter import passes_filter
from classify import classify_post
from notify import send_message, format_alert
from messages import generate_message
from email_sender import send_email

ROOT = os.path.dirname(HERE)
DB_PATH = os.path.join(ROOT, "data", "seen.db")
DEBUG_DIR = os.path.join(ROOT, "data", "debug_logs")
HOST = "127.0.0.1"
PORT = 9999

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("bridge")


def init_db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    # Legacy table from the permalink-keyed bridge; left in place, unused now.
    con.execute("""
        CREATE TABLE IF NOT EXISTS seen (
            permalink TEXT PRIMARY KEY,
            seen_at   TEXT DEFAULT (datetime('now'))
        )
    """)
    # The V10 userscript's /post payload doesn't always carry an exact
    # postUrl (best-guess-only results still get POSTed), so dedup keys on
    # contentHash -- a hash of the extracted text, always present -- instead.
    con.execute("""
        CREATE TABLE IF NOT EXISTS seen_hashes (
            content_hash TEXT PRIMARY KEY,
            seen_at      TEXT DEFAULT (datetime('now'))
        )
    """)
    con.commit()
    return con


def already_seen_hash(con: sqlite3.Connection, content_hash: str) -> bool:
    return con.execute(
        "SELECT 1 FROM seen_hashes WHERE content_hash = ?", (content_hash,)
    ).fetchone() is not None


def mark_seen_hash(con: sqlite3.Connection, content_hash: str):
    con.execute("INSERT OR IGNORE INTO seen_hashes (content_hash) VALUES (?)", (content_hash,))
    con.commit()


def handle_post(payload: dict, con: sqlite3.Connection) -> dict:
    post_url = (payload.get("postUrl") or "").strip()
    best_guess_url = (payload.get("bestGuessUrl") or "").strip()
    content = (payload.get("content") or "").strip()
    content_hash = (payload.get("contentHash") or "").strip()
    page_url = (payload.get("pageUrl") or "").strip()

    if not content_hash:
        return {"status": "error", "reason": "missing contentHash"}

    if already_seen_hash(con, content_hash):
        log.info("SKIP (seen)  hash=%s", content_hash)
        return {"status": "skipped", "reason": "already seen"}

    mark_seen_hash(con, content_hash)

    if not content:
        return {"status": "skipped", "reason": "empty content"}

    ok, reason = passes_filter(content)
    if not ok:
        log.info("SKIP (filter)  %s  hash=%s", reason, content_hash)
        return {"status": "skipped", "reason": reason}

    try:
        is_listing, class_reason = classify_post(content)
    except Exception as exc:
        log.error("  classify error: %s", exc)
        return {"status": "error", "reason": f"classify error: {exc}"}

    if not is_listing:
        log.info("SKIP (classify)  %s  hash=%s", class_reason, content_hash)
        return {"status": "skipped", "reason": class_reason}

    link = post_url or best_guess_url or None
    alert = format_alert(
        group_name="Andelsbolig-gruppe",
        group_url=page_url,
        post_text=content,
        post_url=link,
    )
    try:
        send_message(alert)
        log.info("  ✓ Telegram alert sent  hash=%s", content_hash)
    except Exception as exc:
        log.error("  telegram error: %s", exc)
        return {"status": "error", "reason": f"telegram error: {exc}"}

    return {"status": "sent", "reason": class_reason}


def handle_debug_post(payload: dict) -> dict:
    os.makedirs(DEBUG_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    fname = f"{stamp}-{abs(hash(json.dumps(payload, sort_keys=True))) % 100000}.json"
    path = os.path.join(DEBUG_DIR, fname)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log.info("DEBUG dump written  %s", path)
    return {"status": "saved"}


class Handler(BaseHTTPRequestHandler):
    con: sqlite3.Connection = None  # injected at startup

    def log_message(self, fmt, *args):
        pass  # silence default access log (we use our own)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except (json.JSONDecodeError, ValueError):
            self._json(400, {"error": "invalid JSON"})
            return

        if self.path == "/webdriver-check":
            log.info("webdriver-check: %s", body)
            self._json(200, {"status": "ok"})

        elif self.path == "/post":
            result = handle_post(body, self.__class__.con)
            self._json(200, result)

        elif self.path == "/debug-post":
            result = handle_debug_post(body)
            self._json(200, result)

        elif self.path == "/generate-message":
            try:
                english, danish = generate_message(
                    body.get("content", ""),
                    post_url=body.get("post_url", ""),
                    user_context=body.get("user_context", ""),
                )
                self._json(200, {"english": english, "danish": danish})
            except Exception as exc:
                log.error("generate-message error: %s", exc)
                self._json(200, {"error": str(exc)})

        elif self.path == "/send-email":
            to_email = body.get("to_email", "")
            content = body.get("content", "")
            post_url = body.get("post_url", "")
            email_body = body.get("body", "")
            try:
                if not email_body:
                    _, email_body = generate_message(content, post_url=post_url)
                subject = "Angaaende jeres andelsbolig-opslag"
                send_email(to_email, subject, email_body)
                self._json(200, {"status": "sent"})
            except Exception as exc:
                log.error("send-email error: %s", exc)
                self._json(200, {"status": "error", "error": str(exc)})

        elif self.path == "/send-to-telegram":
            try:
                send_message(body.get("message", ""))
                self._json(200, {"status": "sent"})
            except Exception as exc:
                log.error("send-to-telegram error: %s", exc)
                self._json(200, {"status": "error", "error": str(exc)})

        else:
            self._json(404, {"error": "not found"})

    def _json(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(data))
        self.end_headers()
        self.wfile.write(data)


def main():
    con = init_db()
    Handler.con = con
    server = HTTPServer((HOST, PORT), Handler)
    log.info("bridge listening on %s:%d  db=%s", HOST, PORT, DB_PATH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        con.close()


if __name__ == "__main__":
    main()
