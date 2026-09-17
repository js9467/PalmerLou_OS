#!/usr/bin/env bash
set -euo pipefail

DEVICE_MAC="${PALMER_LOU_BT_DEVICE_MAC:-}"

if [[ -z "$DEVICE_MAC" ]]; then
  echo "not connected"
  exit 0
fi

if bluetoothctl info "$DEVICE_MAC" | grep -qi "Connected: yes"; then
  echo "connected"
else
  echo "not connected"
fi
