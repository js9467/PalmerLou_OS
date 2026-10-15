# Mini-PC Ubuntu Setup

This repo is designed to run as a local appliance shell on Ubuntu once the mini-PC is ready.

The visual system is built around the artwork in `images/Palmer Lou Artwork.png`, with `images/Color Artwork.pdf` as the palette reference.

## Recommended base image

- Ubuntu 24.04 LTS Desktop or minimal server plus a light desktop session.
- Automatic power-on after power loss enabled in BIOS.
- Local SSD installed with enough room for the UI, cache, and recording storage.

## Boot path

1. Install Ubuntu on the mini-PC.
2. Clone this repo to a fixed location such as `/opt/palmer-lou`.
3. Install Node 22 or use the Docker path in this repo.
4. Run the backend as a service.
5. Start a kiosk browser against `http://127.0.0.1:8787`.
6. Configure `PALMER_LOU_LAUNCH_COMMANDS` so streaming targets launch real Linux apps or app-mode windows.

## Backend service

Use the unit file in `infrastructure/systemd/palmer-lou-backend.service` as the basis for a systemd service.

For a one-shot install on the target PC, run `sudo ./infrastructure/scripts/install-linux.sh /opt/palmer-lou` after cloning the repo there.

## Kiosk session

Launch Chromium or a comparable browser in kiosk mode with no chrome, no tabs, and no address bar.

Example target:

```text
chromium --kiosk --incognito --disable-infobars --noerrdialogs http://127.0.0.1:8787
```

The home screen launchers now call the backend app bridge, which can start and close native Linux processes.

## USB touch and display

- Keep the Garmin GPSMAP 8616 as the primary display.
- Verify the USB touch device enumerates correctly under Linux.
- Confirm the resolution is 1920 x 1200.
- Use the built-in Garmin touch test pad on the Palmer Lou home screen to confirm pointer events are reaching the browser.
- If touch does not respond, verify USB HID/libinput sees the Garmin device before changing the application.
- The UI is built with large touch targets and `touch-action: manipulation` so it can be driven cleanly from the Garmin display.
