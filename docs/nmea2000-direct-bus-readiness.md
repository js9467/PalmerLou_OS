# NMEA2000 Direct-Bus Readiness (Boat Install)

This runbook prepares Palmer Lou OS for direct NMEA2000 bus wiring and validates live telemetry end-to-end.

## What direct bus integration looks like

NMEA2000 is a CAN bus. Your mini-PC cannot connect directly without an adapter.

Typical path:

1. NMEA2000 backbone (12V powered, terminators at both ends)
2. T-connector drop cable to USB/CAN gateway
3. Gateway into mini-PC (USB, Ethernet, or Wi-Fi)
4. Ingest into Signal K and/or direct serial fallback
5. Palmer Lou backend reads data and updates /api/summary

## Supported gateway patterns

1. USB serial gateway (common): appears as /dev/ttyUSB0
- Example on this host: FTDI FT232R adapter detected.
- Backend serial fallback can read NMEA0183-formatted sentences from this path.

2. Signal K hub (recommended for NMEA2000 PGN richness)
- Run Signal K server on host, ingest from NMEA2000 gateway.
- Backend reads Signal K endpoint at /signalk/v1/api/vessels/self.

3. SocketCAN path (advanced)
- CAN interface appears as can0 via kernel SocketCAN.
- Typically bridged through canboat/Signal K into normalized vessel data.

## Current host findings (Palmer Lou)

Observed on host 192.168.4.58:

- USB adapter present: FTDI FT232R
- Device link: /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B400BIGE-if00-port0 -> /dev/ttyUSB0
- Signal K service not currently running on port 3000

## Environment settings

Set in /etc/palmer-lou/backend.env:

- PALMER_LOU_NMEA2000_ENABLED=true
- PALMER_LOU_SIGNALK_BASE_URL=http://127.0.0.1:3000
- PALMER_LOU_SIGNALK_TIMEOUT_MS=1800
- PALMER_LOU_NMEA_CACHE_MS=1500
- PALMER_LOU_NMEA_STALE_MS=15000
- PALMER_LOU_NMEA0183_ENABLED=true
- PALMER_LOU_NMEA0183_DEVICE=/dev/ttyUSB0
- PALMER_LOU_NMEA0183_BAUD=38400
- PALMER_LOU_NMEA0183_READ_SECONDS=3

## Boot-time permissions

The service user must read /dev/ttyUSB*.

- Ensure backend user is in groups: dialout, tty
- install-linux.sh now applies this for the kiosk user.

## Preflight check command

Run on host:

bash infrastructure/scripts/nmea-bridge-preflight.sh

It checks:

- Signal K endpoint availability
- USB serial adapter presence
- Serial read sample
- Backend summary NMEA status

## Acceptance criteria on boat

1. /api/summary returns one of these healthy states:
- NMEA 2000 via Signal K
- NMEA 0183 serial bridge

2. Home metrics update from live feed:
- Speed not "--"
- Heading not "--"
- Depth not "--"
- Water temperature not "Unknown"

3. Unplug behavior:
- Within stale timeout, NMEA status changes to stale/offline text.

## If no data after wiring

1. Verify backbone power and termination (exactly two terminators).
2. Confirm gateway mode/output (N2K vs 0183) and baud rate.
3. Check Linux sees adapter:
- lsusb
- ls -l /dev/serial/by-id
4. Check Signal K endpoint:
- curl -sS http://127.0.0.1:3000/signalk/v1/api/vessels/self
5. Confirm backend user group membership:
- id palmerlou

## Notes from research

- Signal K is the standard local marine data hub and exposes web-native JSON APIs.
- CANboat provides proven NMEA2000 interface and decode tooling for Linux gateways, including Actisense and SocketCAN paths.
