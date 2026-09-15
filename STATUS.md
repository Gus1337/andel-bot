# Status / handoff notes

Written for continuing this project in a fresh session (e.g. Claude Code).
Read this after README.md.

## Architecture decisions made (and why)

- **Tampermonkey + real Firefox profile**, not Playwright/Selenium. Chosen
  deliberately: automation drivers leave fingerprints (headless flags, CDP
  artifacts) that Facebook's bot detection targets. A userscript in an
  ordinary Firefox tab has no automation driver touching the browser at all.
- **Dummy Facebook account**, not Gustav's real one. Accepted as a
  consumable: it will likely get banned eventually (a similar public setup
  survived ~3 weeks), and the plan is to treat that as a cost of doing
  business rather than something to fully prevent. Gustav creates/ages new
  accounts himself; Claude does not create fake accounts or fabricate
  identity details.
- **Pilot phase first**: validate extraction against ONE group before
  scaling to all 12 in groups.json, and before tightening the polling
  interval. Currently testing against group id 6051852544876491.
- **07:00-22:00 run window** planned (not yet implemented in a scheduler) --
  posts are assumed not to appear overnight, and running fewer hours/day
  reduces the "always-on" bot signature.
- **OpenAI (not Claude) for the final classification step** -- user's choice.

## Infrastructure

- VM: DigitalOcean droplet `ubuntu-s-1vcpu-2gb-fra1`, Frankfurt region, IP
  159.89.5.87. SSH via key auth.
- Services (systemd, all running as user `botuser`): `xvfb.service`
  (virtual display :99), `andelsbot-firefox.service` (Firefox ESR pointed at
  a persistent profile, logged into the dummy FB account), `x11vnc.service`
  (VNC on 5900), `novnc.service` (web VNC proxy on 6080).
- noVNC access: `http://159.89.5.87:6080/vnc.html` -- password was generated
  at setup time and given to Gustav directly (not stored in this repo).
- Firewall (ufw): SSH + port 6080 open. **Not yet hardened** -- 6080 is open
  to the whole internet, password-protected only. Worth restricting to
  Gustav's IP once interactive setup is done.
- `deploy/setup.sh` provisions all of the above from a fresh Ubuntu box.
  Idempotent (safe to re-run). Known gotchas already fixed in the script:
  Ubuntu has no `firefox-esr` apt package (installs real Firefox from
  Mozilla directly instead), current Firefox releases are `.tar.xz` not
  `.tar.bz2` despite the download URL, and Firefox's GTK/graphics runtime
  libs aren't pulled in by a minimal Ubuntu image (installed with
  per-package fallbacks since Ubuntu 24.04 renamed several with a `t64`
  suffix).

## Component status

- `src/notify.py` -- DONE, tested end-to-end, real Telegram messages confirmed
  delivered. Uses `truststore` package to fix a local SSL cert issue on
  Gustav's Mac (unrelated to Telegram itself -- likely antivirus/VPN SSL
  inspection).
- `src/filter.py` -- DONE, tested. Keyword-based, excludes bytte/søges
  posts. No price or area rules set (`PRICE_MAX`/`PRICE_MIN`/`AREAS` in the
  file are empty -- Gustav had no preference yet). Posts with no visible
  price are intentionally passed through rather than dropped.
- `src/classify.py` -- WRITTEN, NOT YET TESTED. Needs Gustav's
  `OPENAI_API_KEY` in `.env` (not yet provided). Model defaults to
  `gpt-4o-mini`; verify this is still valid on his account or swap via
  `OPENAI_MODEL` in `.env`.
- `tampermonkey/group-watcher.user.js` -- IN PROGRESS, pilot-only, console
  logging only (not yet wired to any backend). v0.1 found posts but
  `textPreview` was actually pulling from a nested *comment*, not the
  top-level post (Facebook marks both with `role="article"`). v0.2 (current)
  filters to only top-level articles (not nested inside another article).
  **Not yet confirmed working** -- last step before this handoff was
  reinstalling v0.2 via a GitHub Gist raw URL in the VM's Firefox and
  re-checking the console output.
- Backend bridge (userscript -> filter -> classify -> notify) -- NOT
  STARTED. Plan: small local HTTP server on the VM that the userscript
  POSTs extracted posts to, which then runs filter.py -> classify.py ->
  notify.py and handles dedup (persisted, not just in-memory).
- `deploy/setup.sh` -- DONE for pilot purposes.

## Known friction points from the previous session

- Installing Tampermonkey scripts by clipboard-pasting into the noVNC
  session did not work reliably -- installing via navigating directly to a
  raw script URL (GitHub raw for a public repo, or a GitHub Gist raw URL for
  a private repo) works because Tampermonkey auto-detects `.user.js` URLs
  and offers a one-click install/update.
- `raw.githubusercontent.com` 404s for a private repo from a browser that
  isn't logged into GitHub (the VM's Firefox isn't, and shouldn't be, logged
  into Gustav's real GitHub -- keep that account out of the dummy-account
  browser profile). Use a Gist (public or secret) for anything that needs
  to be fetched from that browser instead.

## Groups

12 groups in `groups.json`, all already joined by the dummy account. Task
(not yet started) to also monitor plain personal-profile posts tagged
"andelsbolig til salg" outside of groups, via Facebook search -- deferred
until the core group pipeline works, since search-based monitoring is a
bigger detection-risk surface.
