#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-/opt/palmer-lou}"
SERVICE_FILE="/etc/systemd/system/palmer-lou-backend.service"
AUTOSTART_DIR="/etc/xdg/autostart"
AUTOSTART_FILE="${AUTOSTART_DIR}/palmer-lou-kiosk.desktop"
AUTOLOGIN_CONF="/etc/gdm3/custom.conf"

if [[ ! -d "$REPO_DIR" ]]; then
  echo "Repository directory not found: $REPO_DIR" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required on the target machine." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"

# ---------- build ----------
pushd "$REPO_DIR" >/dev/null
npm install
npm run build
popd >/dev/null

# ---------- backend service ----------
install -m 0644 "$REPO_DIR/infrastructure/systemd/palmer-lou-backend.service" "$SERVICE_FILE"
sed -i "s|/opt/palmer-lou|$REPO_DIR|g" "$SERVICE_FILE"
sed -i "s|/usr/bin/node|$NODE_BIN|g" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable palmer-lou-backend.service
systemctl restart palmer-lou-backend.service

# ---------- GDM auto-login ----------
KIOSK_USER="${PALMER_LOU_KIOSK_USER:-$(getent passwd {1000..60000} | awk -F: 'NR==1{print $1}')}"

if [[ -f "$AUTOLOGIN_CONF" && -n "$KIOSK_USER" ]]; then
  if ! grep -q "AutomaticLoginEnable" "$AUTOLOGIN_CONF"; then
    sed -i '/^\[daemon\]/a AutomaticLoginEnable=True\nAutomaticLogin='"$KIOSK_USER" "$AUTOLOGIN_CONF"
  fi
  echo "GDM auto-login -> $KIOSK_USER"

  # Direct NMEA serial adapters commonly appear as /dev/ttyUSB* and require dialout/tty groups.
  usermod -aG dialout,tty "$KIOSK_USER" || true
  echo "Serial access groups granted -> $KIOSK_USER (dialout, tty)"
else
  echo "WARNING: configure GDM auto-login manually in $AUTOLOGIN_CONF"
fi

# ---------- kiosk extension ----------
EXT_SRC="$REPO_DIR/infrastructure/kiosk-extension"
EXT_DEST="/home/palmerlou/palmer-lou-extension"
if [[ -d "$EXT_SRC" ]]; then
  rm -rf "$EXT_DEST"
  cp -r "$EXT_SRC" "$EXT_DEST"
  chown -R palmerlou:palmerlou "$EXT_DEST" 2>/dev/null || true
  echo "Kiosk extension installed -> $EXT_DEST"
fi

# ---------- kiosk autostart ----------
mkdir -p "$AUTOSTART_DIR"

if command -v google-chrome-stable >/dev/null 2>&1; then
  BROWSER_BIN="google-chrome-stable"
elif command -v chromium-browser >/dev/null 2>&1; then
  BROWSER_BIN="chromium-browser"
elif [[ -x /snap/bin/chromium ]]; then
  BROWSER_BIN="/snap/bin/chromium"
else
  BROWSER_BIN="chromium"
fi

cat > "$AUTOSTART_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Palmer Lou Kiosk
Exec=$BROWSER_BIN --start-fullscreen --disable-infobars --noerrdialogs --disable-session-crashed-bubble --disable-features=TranslateUI,DisableLoadExtensionCommandLineSwitch --disable-restore-session-state --no-first-run --no-default-browser-check --disk-cache-dir=/tmp/palmer-lou-cache --load-extension=$EXT_DEST http://127.0.0.1:8787
X-GNOME-Autostart-enabled=true
DESKTOP

chmod 0644 "$AUTOSTART_FILE"

cat <<'MSG'

============================================================
BIOS steps required on the mini-PC:

  1. "Restore AC Power Loss" -> POWER ON
     Device must boot automatically when boat 12 V returns.

  2. Disable "Fast Boot" if USB touch/display misses at cold boot.

  3. Set OS drive first in boot order; disable PXE/network boot.

Access BIOS with Del or F2 at POST (label varies by vendor).
============================================================
MSG

echo "Installation complete. Reboot to verify unattended boot."
