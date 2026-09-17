#!/bin/bash
XAUTH=$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)
export DISPLAY=":0"
export XAUTHORITY="$XAUTH"
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus"

echo "=== ENV ==="
echo "DISPLAY=$DISPLAY"
echo "XAUTHORITY=$XAUTHORITY"
echo "XAUTH_EXISTS=$(test -f "$XAUTHORITY" && echo yes || echo NO)"

echo "=== SINGLETON LOCK ==="
ls -la /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/SingletonLock 2>/dev/null || echo "No lock file"

echo "=== REMOVING LOCK ==="
rm -f /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/SingletonLock
rm -f /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/SingletonCookie
rm -f /home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv/SingletonSocket

echo "=== LAUNCHING CHROMIUM ==="
timeout 8 chromium \
  --kiosk \
  --start-fullscreen \
  https://tv.youtube.com/ \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-features=Translate,DisableLoadExtensionCommandLineSwitch \
  --disable-infobars \
  --noerrdialogs \
  --user-data-dir=/home/palmerlou/snap/chromium/common/palmer-lou-apps/youtube-tv \
  --load-extension=/home/palmerlou/palmer-lou-extension \
  2>&1 | head -30
echo "=== EXIT: $? ==="
