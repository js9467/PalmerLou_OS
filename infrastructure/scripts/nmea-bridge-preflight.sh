#!/usr/bin/env bash
set -euo pipefail

SIGNALK_URL="${PALMER_LOU_SIGNALK_BASE_URL:-http://127.0.0.1:3000}"
NMEA_DEVICE="${PALMER_LOU_NMEA0183_DEVICE:-/dev/ttyUSB0}"
NMEA_BAUD="${PALMER_LOU_NMEA0183_BAUD:-38400}"
APP_SUMMARY_URL="${PALMER_LOU_SUMMARY_URL:-http://127.0.0.1:8787/api/summary}"

pass() { printf '[PASS] %s\n' "$1"; }
warn() { printf '[WARN] %s\n' "$1"; }
info() { printf '[INFO] %s\n' "$1"; }

info "Signal K URL: ${SIGNALK_URL}"
if curl -sS --max-time 3 "${SIGNALK_URL%/}/signalk/v1/api/vessels/self" >/dev/null; then
  pass "Signal K endpoint reachable"
else
  warn "Signal K endpoint not reachable"
fi

if [[ -e "$NMEA_DEVICE" ]]; then
  pass "Serial device exists: $NMEA_DEVICE"
else
  warn "Serial device missing: $NMEA_DEVICE"
fi

if [[ -e "$NMEA_DEVICE" ]]; then
  info "Attempting serial sample from $NMEA_DEVICE at $NMEA_BAUD baud"
  stty -F "$NMEA_DEVICE" "$NMEA_BAUD" raw -echo min 0 time 1 >/dev/null 2>&1 || true
  SAMPLE="$(timeout 4 cat "$NMEA_DEVICE" 2>/dev/null | head -n 8 || true)"
  if [[ -n "$SAMPLE" ]]; then
    pass "Serial stream produced data"
    printf '%s\n' "$SAMPLE" | sed -n '1,8p'
  else
    warn "No serial lines observed in sampling window"
  fi
fi

info "Checking backend summary NMEA status"
SUMMARY="$(curl -sS --max-time 5 "$APP_SUMMARY_URL" || true)"
if [[ -z "$SUMMARY" ]]; then
  warn "Backend summary unavailable"
  exit 0
fi

STATUS="$(printf '%s' "$SUMMARY" | sed -n 's/.*"nmea"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
if [[ -n "$STATUS" ]]; then
  info "NMEA status: $STATUS"
else
  warn "Could not parse connectivity.nmea from summary"
fi

if printf '%s' "$SUMMARY" | grep -q '"label": "Speed"'; then
  info "Summary metrics present"
fi
