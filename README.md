# andelsbolig-bot

Monitors a list of private Facebook groups for genuine "andelsbolig til salg"
(housing co-op apartment for sale) posts and sends a filtered alert to
Telegram.

## Pipeline

1. Firefox + Tampermonkey (running on a small cloud VM, see `deploy/setup.sh`)
   reads new posts from the group feeds using a dedicated Facebook account.
2. `src/filter.py` — cheap keyword/price/area rule filter, discards obvious
   noise (bytte-posts, søges-posts, etc).
3. `src/classify.py` — OpenAI call that verifies a post is a genuine for-sale
   listing before alerting.
4. `src/notify.py` — sends the formatted alert (post text, link, suggested
   reply) to Telegram.

## Setup

- `groups.json` — the list of target Facebook groups.
- `.env` (not committed — see `.gitignore`) — holds `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`, `OPENAI_API_KEY`.
- `deploy/setup.sh` — provisions Firefox + Xvfb + noVNC + systemd services on
  a fresh Ubuntu VM. Run as root on the target VM.

## Status

Pilot phase: validating against a single group before scaling to the full
list in `groups.json`.
