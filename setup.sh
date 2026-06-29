#!/usr/bin/env bash
# One-shot setup for running TMC Radio Bot on a Linux VM (Oracle Cloud, etc.).
# Run from inside the cloned TMCBot folder:  bash setup.sh
# First run creates .env for you to fill in; run it again to start the service.
set -e

echo "==> Installing Node.js 20 + git (if needed)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git >/dev/null

echo "==> Installing dependencies..."
npm install --omit=dev

if [ ! -f .env ]; then
  cat > .env <<'EOF'
DISCORD_TOKEN=
TMCAST_STREAM_URL=https://cast.tmc.gg/listen/one/radio.mp3
TMCAST_NOWPLAYING_URL=https://cast.tmc.gg/api/np/one
STATION_NAME=Mavion Radio One
GUILD_ID=
AUTOPLAY_CHANNEL_ID=
EOF
  echo ""
  echo "==> Created .env — fill in DISCORD_TOKEN (and GUILD_ID for instant commands):"
  echo "      nano .env"
  echo "    Then run this script again:  bash setup.sh"
  exit 0
fi

if ! grep -q '^DISCORD_TOKEN=.\+' .env; then
  echo "ERROR: DISCORD_TOKEN is empty in .env. Run 'nano .env', fill it in, then re-run."
  exit 1
fi

echo "==> Installing the systemd service..."
sudo tee /etc/systemd/system/tmcbot.service >/dev/null <<EOF
[Unit]
Description=TMC Radio Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
EnvironmentFile=$(pwd)/.env
ExecStart=$(command -v node) index.js
Restart=always
RestartSec=5
User=$(whoami)

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable tmcbot >/dev/null 2>&1
sudo systemctl restart tmcbot

echo ""
echo "==> Done — the bot is running and will auto-start on reboot."
echo "    Live logs:   sudo journalctl -u tmcbot -f"
echo "    Restart:     sudo systemctl restart tmcbot"
echo "    Update later: git pull && npm install --omit=dev && sudo systemctl restart tmcbot"
