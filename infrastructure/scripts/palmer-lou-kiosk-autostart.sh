#!/usr/bin/env bash
set -euo pipefail

LAUNCHER="/usr/local/bin/palmer-lou-kiosk.sh"
RETRY_SECONDS="${PALMER_LOU_KIOSK_RETRY_SECONDS:-2}"

if [[ ! -x "$LAUNCHER" ]]; then
  logger -t palmer-lou-kiosk "Launcher not executable: $LAUNCHER"
  exit 1
fi

# Keep kiosk in the foreground appliance loop: if Chromium exits, relaunch.
while true; do
  "$LAUNCHER" || logger -t palmer-lou-kiosk "Launcher exited with status $?; retrying in ${RETRY_SECONDS}s"
  sleep "$RETRY_SECONDS"
done
