#!/usr/bin/env bash
set -euo pipefail

DEVICE_MAC="${PALMER_LOU_BT_DEVICE_MAC:-}"

if [[ -z "$DEVICE_MAC" ]]; then
  echo "PALMER_LOU_BT_DEVICE_MAC is not set" >&2
  exit 1
fi

bluetoothctl power on
bluetoothctl connect "$DEVICE_MAC" >/dev/null

MAC_UNDERSCORE="${DEVICE_MAC//:/_}"
SINK_PATTERN="bluez_output.${MAC_UNDERSCORE}.a2dp"

if command -v wpctl >/dev/null 2>&1; then
  SINK_ID="$(wpctl status | grep -i "$SINK_PATTERN" | head -n1 | sed -E 's/.* ([0-9]+)\\..*/\\1/' || true)"
  if [[ -n "$SINK_ID" ]]; then
    wpctl set-default "$SINK_ID"
    echo "connected"
    exit 0
  fi
fi

if command -v pactl >/dev/null 2>&1; then
  SINK_NAME="$(pactl list short sinks | awk '{print $2}' | grep -i "$SINK_PATTERN" | head -n1 || true)"
  if [[ -n "$SINK_NAME" ]]; then
    pactl set-default-sink "$SINK_NAME"
    echo "connected"
    exit 0
  fi
fi

echo "Bluetooth sink not found for $DEVICE_MAC" >&2
exit 1
