#!/bin/bash
PROFILE="/home/palmerlou/snap/chromium/common/chromium/Default"
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

# Ensure extension is in user's home (snap confinement)
EXT_DIR="/home/palmerlou/palmer-lou-extension"

exec /snap/bin/chromium \
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
  --force-device-scale-factor=1 \
  --disk-cache-dir=/tmp/palmer-lou-cache \
  --enable-features=VirtualKeyboard \
  --load-extension="$EXT_DIR" \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  http://127.0.0.1:8787
