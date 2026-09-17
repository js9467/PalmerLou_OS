#!/usr/bin/env bash
set -euo pipefail

DEVICE_MAC="${PALMER_LOU_BT_DEVICE_MAC:-}"

if [[ -z "$DEVICE_MAC" ]]; then
  echo "PALMER_LOU_BT_DEVICE_MAC is not set" >&2
  exit 1
fi

bluetoothctl power on
bluetoothctl agent on
bluetoothctl default-agent
bluetoothctl pair "$DEVICE_MAC"
bluetoothctl trust "$DEVICE_MAC"
bluetoothctl connect "$DEVICE_MAC"

echo "connected"
