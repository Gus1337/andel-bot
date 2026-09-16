#!/usr/bin/env python3
"""
Bridge: receives new post events from the Tampermonkey userscript and runs
the filter → classify → notify pipeline.

Listens on 127.0.0.1:5000 (localhost only, not exposed externally).

POST /post   body: {"permalink": "...", "text": "...", "group_url": "..."}
GET  /health responds {"status": "ok"}
"""

import json
import logging
import os
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from filter import passes_filter
from classify import classify_post
from notify import send_message, format_alert

ROOT = os.path.dirname(HERE)
DB_PATH = os.path.join(ROOT, "data", "seen.db")
HOST = "127.0.0.1"
PORT = 5000

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("bridge")


def init_db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.execute("""
        CREATE TABLE IF NOT EXISTS seen (
            permalink TEXT PRIMARY KEY,
            seen_at   TEXT DEFAULT (datetime('now'))
        )
    """)
    con.commit()
    return con


def already_seen(con: sqlite3.Connection, permalink: str) -> bool:
    return con.execute(
        "SELECT 1 FROM seen WHERE permalink = ?", (permalink,)
    ).fetchone() is not None


def mark_seen(con: sqlite3.Connection, permalink: str):
    con.execute("INSERT OR IGNORE INTO seen (permalink) VALUES (?)", (permalink,))
    con.commit()


def handle_post(payload: dict, con: sqlite3.Connection) -> tuple[int, str]:
    permalink = (payload.get("permalink") or "").strip()
    text      = (payload.get("text") or "").strip()
    group_url = (payload.get("group_url") or "").strip()

    if not permalink:
        return 400, "missing permalink"

    if already_seen(con, permalink):
        log.info("SKIP (seen)  %s", permalink)
        return 200, "already seen"

    mark_seen(con, permalink)
    log.info("NEW  %s  text_len=%d", permalink, len(text))

    # TEMP: filter and classify are bypassed until text extraction is reliable.
    # Every new post triggers a Telegram alert with whatever text we have.

    # Notify
    alert = format_alert(
        group_name="Andelsbolig-gruppe",
        group_url=group_url,
        post_text=text if text else "(ingen tekst udtrukket)",
        post_url=permalink,
    )
    try:
        send_message(alert)
        log.info("  ✓ Telegram alert sent")
    except Exception as exc:
        log.error("  telegram error: %s", exc)
        return 500, f"telegram error: {exc}"

    return 200, "alerted"


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
        if self.path == "/debug":
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            with open(os.path.join(ROOT, "data", "vm_debug_dump.json"), "wb") as f:
                f.write(raw)
            log.info("DEBUG dump written  bytes=%d", len(raw))
            self._json(200, {"result": "saved"})
            return
        if self.path != "/post":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json(400, {"error": "invalid JSON"})
            return
        status, msg = handle_post(body, self.__class__.con)
        self._json(status, {"result": msg})

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
