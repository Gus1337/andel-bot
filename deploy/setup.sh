#!/usr/bin/env bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
timedatectl set-timezone Europe/Copenhagen

# Swap file as a safety net on smaller boxes
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

apt-get update
apt-get install -y xvfb x11vnc novnc websockify dbus-x11 bzip2 --no-install-recommends

# Firefox's runtime GTK/graphics libs -- package names vary by Ubuntu
# release (the t64 suffix from the 64-bit time_t transition), so try
# both and ignore whichever doesn't exist on this release.
for pkg in libgtk-3-0 libgtk-3-0t64 libdbus-glib-1-2 libxt6 libxt6t64 libx11-xcb1 libasound2 libasound2t64 libpci3 libegl1 libgbm1 fonts-liberation; do
  apt-get install -y --no-install-recommends "$pkg" 2>/dev/null || true
done

# Real Firefox from Mozilla directly (avoids Ubuntu's Snap-only packaging,
# which causes sandboxing issues in headless/service setups)
if [ ! -d /opt/firefox ]; then
  cd /opt
  curl -L -o firefox.tar.bz2 "https://download.mozilla.org/?product=firefox-esr-latest&os=linux64&lang=en-US"
  tar xf firefox.tar.bz2   # auto-detects actual compression (currently xz, not bz2, despite the URL)
  rm firefox.tar.bz2
fi
ln -sf /opt/firefox/firefox /usr/local/bin/firefox-esr

id -u botuser &>/dev/null || useradd -m -s /bin/bash botuser

VNC_PASS=$(openssl rand -base64 12)
mkdir -p /home/botuser/.vnc
chown -R botuser:botuser /home/botuser/.vnc
su - botuser -c "x11vnc -storepasswd '$VNC_PASS' /home/botuser/.vnc/passwd"

su - botuser -c "xvfb-run -a firefox-esr -CreateProfile 'andelsbot /home/botuser/.mozilla/firefox/andelsbot-profile'"

cat > /etc/systemd/system/xvfb.service << 'EOF'
[Unit]
Description=Virtual display for Firefox
After=network.target

[Service]
User=botuser
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -nolisten tcp
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/andelsbot-firefox.service << 'EOF'
[Unit]
Description=Firefox for andelsbolig-bot
After=xvfb.service
Requires=xvfb.service

[Service]
User=botuser
Environment=DISPLAY=:99
Environment=HOME=/home/botuser
ExecStart=/usr/local/bin/firefox-esr --no-remote --profile /home/botuser/.mozilla/firefox/andelsbot-profile
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/x11vnc.service << 'EOF'
[Unit]
Description=x11vnc server
After=xvfb.service
Requires=xvfb.service

[Service]
User=botuser
Environment=DISPLAY=:99
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -rfbauth /home/botuser/.vnc/passwd -rfbport 5900
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/novnc.service << 'EOF'
[Unit]
Description=noVNC web proxy
After=x11vnc.service
Requires=x11vnc.service

[Service]
User=botuser
ExecStart=/usr/bin/websockify --web=/usr/share/novnc/ 6080 localhost:5900
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now xvfb.service andelsbot-firefox.service x11vnc.service novnc.service

# Bridge (filter/classify/notify HTTP receiver for the Tampermonkey script).
# Only install/start it once the repo is actually deployed to botuser's
# home -- ExecStart would otherwise fail and loop-restart forever. Re-run
# this script after deploying the code to pick it up.
REPO_DIR=/home/botuser/andelsbolig-bot
if [ -f "$REPO_DIR/src/bridge.py" ]; then
  cp "$REPO_DIR/deploy/andelsbot-bridge.service" /etc/systemd/system/andelsbot-bridge.service
  chown -R botuser:botuser "$REPO_DIR"
  systemctl daemon-reload
  systemctl enable --now andelsbot-bridge.service
else
  echo "NOTE: $REPO_DIR not found yet -- skipping andelsbot-bridge.service install."
  echo "      Deploy the repo there, then re-run this script (it's idempotent)."
fi

ufw allow OpenSSH
ufw allow 6080/tcp
ufw --force enable

echo ""
echo "=================================================="
echo "Setup done."
echo "noVNC URL:   http://$(curl -s ifconfig.me):6080/vnc.html"
echo "VNC password: $VNC_PASS"
echo "=================================================="
