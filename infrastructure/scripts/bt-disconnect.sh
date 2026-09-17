#!/usr/bin/env bash
set -euo pipefail

DEVICE_MAC="${PALMER_LOU_BT_DEVICE_MAC:-}"

if [[ -z "$DEVICE_MAC" ]]; then
  echo "PALMER_LOU_BT_DEVICE_MAC is not set" >&2
  exit 1
fi

bluetoothctl disconnect "$DEVICE_MAC"

echo "disconnected"
