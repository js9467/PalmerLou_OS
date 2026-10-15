#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-/opt/palmer-lou}"
SERVICE_FILE="/etc/systemd/system/palmer-lou-backend.service"
AUTOSTART_DIR="/etc/xdg/autostart"
AUTOSTART_FILE="${AUTOSTART_DIR}/palmer-lou-kiosk.desktop"

if [[ ! -d "$REPO_DIR" ]]; then
  echo "Repository directory not found: $REPO_DIR" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo so it can install systemd and autostart files." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required on the target machine." >&2
  exit 1
fi

pushd "$REPO_DIR" >/dev/null
npm install
npm run build
popd >/dev/null

install -m 0644 "$REPO_DIR/infrastructure/systemd/palmer-lou-backend.service" "$SERVICE_FILE"
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$REPO_DIR|" "$SERVICE_FILE"
sed -i "s|^ExecStart=.*|ExecStart=/usr/bin/npm run start -w apps/backend|" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable palmer-lou-backend.service
systemctl restart palmer-lou-backend.service

mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Palmer Lou Kiosk
Exec=chromium --kiosk --incognito --disable-infobars --noerrdialogs --start-fullscreen http://127.0.0.1:8787
X-GNOME-Autostart-enabled=true
EOF

chmod 0644 "$AUTOSTART_FILE"

echo "Installed Palmer Lou backend service and kiosk autostart."
echo "If you are using a desktop session, log out and back in to start the kiosk browser automatically."