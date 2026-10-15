#!/bin/bash
set -euo pipefail

KIOSK_USER="${PALMER_LOU_KIOSK_USER:-${USER:-$(id -un)}}"
USER_HOME="${HOME:-$(getent passwd "$KIOSK_USER" | cut -d: -f6)}"
if [[ -z "${USER_HOME:-}" || ! -d "$USER_HOME" ]]; then
  USER_HOME="/home/$KIOSK_USER"
fi

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

BROWSER_BIN=""
for candidate in google-chrome-stable chromium-browser chromium chromium-browser-stable; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BROWSER_BIN="$(command -v "$candidate")"
    break
  fi
done

if [[ -z "$BROWSER_BIN" ]]; then
  for absolute in /usr/bin/google-chrome-stable /usr/bin/chromium-browser /usr/bin/chromium /snap/bin/chromium; do
    if [[ -x "$absolute" ]]; then
      BROWSER_BIN="$absolute"
      break
    fi
  done
fi

if [[ -z "$BROWSER_BIN" ]]; then
  logger -t palmer-lou-kiosk "No supported Chromium/Chrome binary found in PATH"
  exit 1
fi

if [[ "$BROWSER_BIN" == *"google-chrome"* ]]; then
  PROFILE_ROOT="$USER_HOME/.config/google-chrome"
else
  if [[ -d "$USER_HOME/.config/chromium" ]]; then
    PROFILE_ROOT="$USER_HOME/.config/chromium"
  else
    PROFILE_ROOT="$USER_HOME/snap/chromium/common/chromium"
  fi
fi

PROFILE="$PROFILE_ROOT/Default"
mkdir -p "$PROFILE"

# Delete session markers so no "restore pages" prompt
rm -f "$PROFILE/Last Session" "$PROFILE/Last Tabs" "$PROFILE/Singleton"*
find "$PROFILE/../Crash Reports/attachments" -name "*.dmp" -delete 2>/dev/null || true

# Patch Preferences JSON to mark clean exit
PREFS="$PROFILE/Preferences"
if [ -f "$PREFS" ]; then
  sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS" 2>/dev/null || true
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "$PREFS" 2>/dev/null || true
fi

# Ensure the kiosk extension lives in the user's home AND is owned by the kiosk
# user. snap Chromium's AppArmor profile only grants read access to files owned
# by the running user; a root-owned extension (e.g. copied in via a sudo deploy)
# is silently DENIED, so content scripts never run and the floating Home button
# disappears. Re-sync from the repo copy on every start so the state self-heals.
EXT_DIR="$USER_HOME/palmer-lou-extension"
EXT_SRC="${PALMER_LOU_EXTENSION_SRC:-/opt/palmer-lou/infrastructure/kiosk-extension}"
if [[ -f "$EXT_SRC/manifest.json" ]]; then
  mkdir -p "$EXT_DIR"
  # Remove first (the dir is user-writable) so the copies are recreated as the
  # kiosk user instead of inheriting root ownership from any prior files.
  rm -f "$EXT_DIR"/*.js "$EXT_DIR"/*.json "$EXT_DIR"/*.css 2>/dev/null || true
  cp -f "$EXT_SRC"/*.js "$EXT_SRC"/*.json "$EXT_SRC"/*.css "$EXT_DIR"/ 2>/dev/null || true
fi
APP_URL="${PALMER_LOU_KIOSK_URL:-http://127.0.0.1:8787}"
HEALTH_URL="${PALMER_LOU_KIOSK_HEALTH_URL:-http://127.0.0.1:8787/api/health}"
MAX_WAIT_SECONDS="${PALMER_LOU_KIOSK_MAX_WAIT_SECONDS:-90}"
REMOTE_DEBUG_PORT="${PALMER_LOU_REMOTE_CDP_PORT:-9222}"

if command -v curl >/dev/null 2>&1; then
  deadline=$((SECONDS + MAX_WAIT_SECONDS))
  until curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      break
    fi
    sleep 1
  done
fi

logger -t palmer-lou-kiosk "Launching $BROWSER_BIN for user=$KIOSK_USER home=$USER_HOME url=$APP_URL"

exec "$BROWSER_BIN" \
  --start-fullscreen \
  --disable-gpu \
  --disable-gpu-compositing \
  --use-gl=swiftshader \
  --enable-unsafe-swiftshader \
  --disable-infobars \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --hide-crash-restore-bubble \
  --no-first-run \
  --no-default-browser-check \
  --disable-component-update \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$REMOTE_DEBUG_PORT" \
  --force-device-scale-factor=1 \
  --disk-cache-dir=/tmp/palmer-lou-cache \
  --enable-features=VirtualKeyboard \
  --load-extension="$EXT_DIR" \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  "$APP_URL"
