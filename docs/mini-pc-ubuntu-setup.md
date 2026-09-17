# Mini-PC Ubuntu Setup

This repo is designed to run as a local appliance shell on Ubuntu once the mini-PC is ready.

## Recommended base image

- **Ubuntu 26.04 LTS Desktop** (current target).
- During installation select "Minimal installation" — you need the desktop session for GDM auto-login, but no bundled apps.
- Choose to install third-party drivers when prompted (covers Wi-Fi and GPU).

## BIOS — power-loss survival (do this first)

The boat has no graceful shutdown path. When the engine stops, 12 V drops and the mini-PC hard-powers-off. Configure the BIOS so the device recovers automatically:

| Setting | Value |
|---------|-------|
| Restore AC Power Loss (or AC Power Recovery) | **Power On** |
| Fast Boot | **Disabled** (ensures USB touch/display initialises at cold start) |
| Boot Order | OS SSD first — disable PXE/network boot to eliminate POST delay |

Access BIOS by pressing **Del** or **F2** at the POST screen immediately after power-on.

## Boot path

1. Install Ubuntu 26.04 LTS on the mini-PC (minimal desktop).
2. Clone this repo to `/opt/palmer-lou`.
3. Install Node 22 (`nvm` or the NodeSource repo).
4. Run `sudo ./infrastructure/scripts/install-linux.sh /opt/palmer-lou`.
5. Reboot — the device should come up unattended, auto-login, and open the kiosk browser.

## Hard power-off resilience

The system is designed to survive yanked power at any point:

**Backend service** (`palmer-lou-backend.service`)
- Runs `node` directly — no npm wrapper, so SIGTERM reaches the process immediately.
- `Restart=always` + `StartLimitIntervalSec=0` — restarts indefinitely without a backoff cap.
- `TimeoutStopSec=3` — systemd sends SIGKILL after 3 s if the process does not exit cleanly.
- All buoy data and scores are rebuilt from NOAA NDBC on each startup — no on-disk state to corrupt.

**Kiosk browser**
- Launched with `--incognito` so there is no session to restore after a dirty shutdown.
- `--disable-session-crashed-bubble` and `--disable-restore-session-state` suppress all "Chrome didn't shut down correctly" prompts.
- `--no-first-run` prevents first-run dialogs after OS updates.

**Filesystem**
- The backend holds all caches in memory only. There are no database writes or JSON files that can be left in a torn state.
- Browser `localStorage` (fishing catches, map prefs) is written by the Chromium storage engine which uses atomic journal commits — data survives power loss.

## GDM auto-login

The install script patches `/etc/gdm3/custom.conf` to enable automatic login for the first human user. The kiosk `.desktop` file in `/etc/xdg/autostart` then starts Chromium in full-screen `--app` mode as soon as the desktop session is ready.

If GDM auto-login is not set, the device will sit at the login screen after power-on with no one to press Enter — verify this works on first boot.

## Backend service

Use the unit file in `infrastructure/systemd/palmer-lou-backend.service` as the basis for a systemd service.

For a one-shot install on the target PC, run:

```bash
sudo ./infrastructure/scripts/install-linux.sh /opt/palmer-lou
```

## Kiosk session

The install script detects `google-chrome-stable`, `chromium-browser`, or `chromium` in that order. Google Chrome is preferred for better geolocation API support (used by the fishing map to center on the vessel's position).

```bash
# Verify the kiosk line looks correct after install
cat /etc/xdg/autostart/palmer-lou-kiosk.desktop
```

## USB touch and display

- Keep the Garmin GPSMAP 8616 as the primary display.
- Verify the USB touch device enumerates correctly under Linux.
- Confirm the resolution is 1920 x 1200.
- Use the built-in Garmin touch test pad on the Palmer Lou home screen to confirm pointer events are reaching the browser.
- If touch does not respond, verify USB HID/libinput sees the Garmin device before changing the application.
- The UI is built with large touch targets and `touch-action: manipulation` so it can be driven cleanly from the Garmin display.
