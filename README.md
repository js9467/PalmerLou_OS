# Palmer Lou OS

Palmer Lou OS is a local-first vessel appliance shell for the Garmin GPSMAP 8616 and the BoatEye/NMEA stack described in `MD/Palmer_Lou_Vessel_OS_Spec_v3.md`.

## What is in this repo

- A touch-first React kiosk UI for the Garmin display.
- A local Node backend that serves the UI, mock vessel data, brand artwork, and native app launch bridges.
- The boat artwork in `images/Palmer Lou Artwork.png` and the color reference art in `images/Color Artwork.pdf`.
- Docker support for repeatable local testing.
- Ubuntu bring-up notes for the mini-PC deployment path.
- Weekend test surfaces for streaming video, Bluetooth, touchscreen calibration, and remote version checks.
- Full-screen app launch and return-home behavior for Linux media apps.

## Local development

```bash
npm install
npm run dev
```

The UI runs on Vite and proxies API calls to the local backend.

## Production-style build

```bash
npm run build
npm run start
```

The backend serves the built UI from `apps/ui/dist`.

You can map real Linux launch commands with `PALMER_LOU_LAUNCH_COMMANDS`, for example:

```bash
PALMER_LOU_LAUNCH_COMMANDS='{"youtube":"chromium --app=https://www.youtube.com/tv --start-fullscreen","youtube-tv":"chromium --app=https://tv.youtube.com/ --start-fullscreen","spotify":"flatpak run com.spotify.Client"}'
```

## Bluetooth wiring for production

Bluetooth and media audio are safety-gated. Media apps are blocked until the built-in Bluetooth command layer can run on Linux and the stereo is confirmed connected.

Use the provided scripts:

- `infrastructure/scripts/bt-pair.sh`
- `infrastructure/scripts/bt-reconnect.sh`
- `infrastructure/scripts/bt-route.sh`
- `infrastructure/scripts/bt-disconnect.sh`
- `infrastructure/scripts/bt-status.sh`

On the Linux mini-PC:

```bash
cd /opt/palmer-lou
chmod +x infrastructure/scripts/bt-*.sh
chmod +x infrastructure/scripts/configure-bluetooth.sh
chmod +x infrastructure/scripts/provision-bluetooth-production.sh
sudo mkdir -p /etc/palmer-lou
sudo cp infrastructure/systemd/palmer-lou-backend.env.example /etc/palmer-lou/backend.env
sudo nano /etc/palmer-lou/backend.env
```

Or generate the env file in one step:

```bash
sudo /opt/palmer-lou/infrastructure/scripts/configure-bluetooth.sh
```

For full production provisioning and verification in one command:

```bash
sudo /opt/palmer-lou/infrastructure/scripts/provision-bluetooth-production.sh
```

Bluetooth device identity is hardcoded in backend logic.

Then reload and restart the service:

```bash
sudo systemctl daemon-reload
sudo systemctl restart palmer-lou-backend
sudo systemctl status palmer-lou-backend
```

API verification (on the mini-PC):

```bash
curl -s http://127.0.0.1:8787/api/bluetooth
curl -s -X POST http://127.0.0.1:8787/api/bluetooth/action \
	-H 'content-type: application/json' \
	-d '{"action":"route-audio"}'
curl -s -X POST http://127.0.0.1:8787/api/bluetooth/diagnostics
```

Expected behavior:

- `ready: true`
- `config.missingCommands: []`
- `connected: true` after successful reconnect/route
- media launch endpoints return `status: "Launched"` instead of `"Audio path not configured"`

Notes:

- Bluetooth action/status commands are hardcoded in backend logic for Linux and no longer require command-specific environment variables.
- The stereo MAC and label are hardcoded in backend logic and should be edited in `apps/backend/src/bluetooth.ts` for vessel-specific deployments.

## Strict production startup

Set `PALMER_LOU_REQUIRE_BLUETOOTH_READY=true` to hard-fail backend startup unless Bluetooth diagnostics are fully ready. This prevents accidental partial deployments where media appears available but audio routing is not truly functional.

## NMEA 2000 telemetry feed

Home screen instruments and the depth/temperature trend graph are now driven by the NMEA 2000 path through Signal K when enabled.

Set:

- `PALMER_LOU_NMEA2000_ENABLED=true`
- `PALMER_LOU_SIGNALK_BASE_URL=http://127.0.0.1:3000`
- `PALMER_LOU_SIGNALK_TIMEOUT_MS=1800`
- `PALMER_LOU_NMEA_CACHE_MS=1500`
- `PALMER_LOU_NMEA_STALE_MS=15000`
- `PALMER_LOU_NMEA0183_ENABLED=true`
- `PALMER_LOU_NMEA0183_DEVICE=/dev/ttyUSB0`
- `PALMER_LOU_NMEA0183_BAUD=38400`
- `PALMER_LOU_NMEA0183_READ_SECONDS=3`

Expected Signal K values (read-only):

- `navigation.speedOverGround` (m/s)
- `navigation.headingMagnetic` or `navigation.courseOverGroundTrue` (radians)
- `environment.depth.belowTransducer` (meters)
- `environment.water.temperature` (Kelvin)

When the feed is unavailable, the backend falls back to local mock values and reports status in `connectivity.nmea`.

Direct boat-bus prep and validation is documented in `docs/nmea2000-direct-bus-readiness.md`.

For plug-and-play behavior in Palmer Lou, no manual Signal K input is required as long as your gateway emits NMEA sentences on a USB serial device. The backend auto-detects `/dev/serial/by-id/*` and `/dev/ttyUSB*`/`/dev/ttyACM*`, then probes common baud rates.

Run the preflight checker on the host after wiring:

```bash
chmod +x infrastructure/scripts/nmea-bridge-preflight.sh
bash infrastructure/scripts/nmea-bridge-preflight.sh
```

## Docker

```bash
docker compose up --build
```

For repeatable Docker deploy modes:

```bash
chmod +x infrastructure/scripts/deploy-docker.sh
./infrastructure/scripts/deploy-docker.sh --mode dev
```

Linux Bluetooth-integrated Docker mode (requires Linux host with BlueZ and D-Bus):

```bash
./infrastructure/scripts/deploy-docker.sh --mode linux-bt
```

Before first run, copy and edit:

```bash
cp infrastructure/docker/backend.env.example infrastructure/docker/backend.env
```

Important:

- `dev` mode is fast functional UI/backend test, but Bluetooth can remain intentionally not ready.
- `linux-bt` mode is the deploy-like path and can enforce strict Bluetooth readiness.

## Mini-PC setup

See `docs/mini-pc-ubuntu-setup.md` for the Ubuntu and kiosk notes intended for the mini-PC deployment.

## Remote updates

See `docs/remote-update.md` for the update feed format and the remote update script flow.
