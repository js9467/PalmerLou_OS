# Palmer Lou Vessel OS
## Product Requirements, Architecture, and AI Build Specification

**Project name:** Palmer Lou Vessel OS  
**Primary platform:** Fanless Linux mini-PC connected to a Garmin GPSMAP 8616  
**Primary interaction model:** Touchscreen appliance UI through Garmin USB Touch Out  
**Primary goals:** Vessel dashboard, streaming/media launcher, BoatEye 360 video integration, marine telemetry, recording, overlays, weather/fishing tools, and future AI-assisted diagnostics

---

# Branding and Visual Identity

Palmer Lou OS must use the vessel's existing **Palmer Lou** identity as the basis for the entire visual system. The supplied artwork is the authoritative visual reference.

## Brand direction

- Preserve the recognizable **Palmer Lou** script/logo as the primary mark.
- Base the UI palette on the artwork: **aqua/teal, deep blue-black/navy, warm sand/gold, white, and black**.
- The flowing wave/fish-tail artwork should influence dividers, loading animations, splash screens, selected-state accents, and subtle background treatments.
- The interface should feel **premium custom sportfishing**, not like a generic Android launcher or consumer smart-TV UI.
- Keep the functional screens restrained: branding should be obvious but never interfere with readability, camera visibility, gauges, alerts, or use in bright sunlight/night conditions.
- Develop both **day** and **night** themes from the same palette. Night mode should heavily favor black/deep navy backgrounds with restrained aqua and sand accents.
- Use the supplied logo/artwork on the boot splash, Home screen, About/System page, mobile/PWA identity, app icon/favicons, and appropriate generated trip reports/media.
- Create simplified logo variants for small UI locations where the full artwork is too detailed. Do not redraw or materially alter the primary logo unless explicitly approved.

## UI implementation requirements

The frontend should define brand tokens rather than hard-code colors throughout the application. Create variables/tokens for primary aqua, secondary teal, deep navy, sand/gold, surface black, white, warning, critical, and success states. Exact production color values should be sampled from the supplied source artwork during implementation.

Create reusable branded components for:

- Boot/splash screen
- Home header
- Navigation/selected states
- Loading indicator
- App tiles
- Gauge accents
- Camera overlay treatment
- Mobile/PWA iconography
- Trip summary cards
- Empty/offline states

The AI developer should treat the supplied Palmer Lou artwork as a project asset and build the design system around it rather than inventing an unrelated theme.

---

## 1. Product Vision

Build a dedicated vessel operating environment for **Palmer Lou** that runs on a hidden Linux mini-PC and uses a **Garmin GPSMAP 8616** as the primary display and touchscreen interface.

The system must feel like an embedded marine appliance, not a general-purpose PC.

The user should never need to interact with:

- A Linux desktop
- A browser address bar
- A terminal
- Window management
- OS update dialogs
- Login prompts
- Antivirus software
- Generic Android home screens
- Mouse/keyboard controls during normal operation

On power-up, the device should boot directly into a full-screen **Palmer Lou** interface.

The system should complement, not replace, Garmin navigation, radar, sonar, autopilot, SiriusXM Fish Mapping, Mercury/JPO integration, or other mission-critical marine systems.

---

# 2. Core Design Principles

1. **Garmin remains the primary navigation platform.**
2. **Palmer Lou OS is an auxiliary vessel management, media, video, and analytics system.**
3. **No critical propulsion, steering, autopilot, or safety system should depend on the Linux PC.**
4. NMEA 2000 integration should begin as **read-only**.
5. The UI must be usable while underway with large touch targets.
6. The system must operate locally even when internet access is unavailable.
7. Internet-dependent features should degrade gracefully.
8. The interface must hide all underlying operating-system complexity.
9. Apps may use Linux-native software, browser engines, Android compatibility layers, or APIs internally, but the user should experience one unified interface.
10. Power interruption must not corrupt the system or require manual recovery.

---

# 3. Initial Hardware Architecture

## 3.1 Linux Mini-PC

Target hardware class:

- Fanless Intel x86 mini-PC
- Intel N95 / N100 / N150 class CPU or better
- 16 GB RAM preferred
- 512 GB SSD minimum
- 1 TB SSD preferred if continuous video recording is enabled
- Intel integrated graphics
- HDMI output
- Multiple USB-A ports
- At least two USB 3.x ports
- Bluetooth
- Wi-Fi
- Ethernet
- BIOS option for **automatic power-on after power loss**
- Linux compatible
- Nominal 12 VDC input

Example platform currently under consideration:

**GEEKOM iX12 fanless mini-PC**

Because the boat electrical system can exceed nominal 12 V during charging, power should be provided through a **regulated 12 VDC-to-12 VDC converter** rather than directly from the vessel bus unless the selected PC explicitly supports the full vessel voltage range.

---

## 3.2 Garmin GPSMAP 8616 Integration

The Garmin 8616 acts as:

- Display for Palmer Lou OS
- Touchscreen input device for Palmer Lou OS

Physical connections:

```text
Linux PC HDMI OUT
        |
        v
Garmin GPSMAP 8616 HDMI IN

Garmin GPSMAP 8616 USB Touch Out
        |
        v
Linux PC USB
```

The application should run at or be optimized for the Garmin's native display resolution:

**1920 × 1200**

Touch support under Linux must be verified during initial hardware bring-up.

Expected Linux technologies:

- `libinput`
- `evdev`
- USB HID
- Wayland or X11
- Touch calibration if necessary

Touch should support:

- Tap
- Drag
- Scroll
- Large touch targets
- Long press where appropriate
- Multi-touch only if useful and reliable

---

# 4. BoatEye 360 Camera Integration

The vessel has a **Night BoatEye 360 camera system with HDMI output**.

Palmer Lou OS should ingest this camera feed directly.

A typical mini-PC does not have HDMI input, so use a USB HDMI capture device.

Initial test device:

**Guermok USB 3.0 HDMI Capture Card**
- HDMI input
- USB 3.0
- Advertised 1080p60 capture
- Expected UVC/V4L2 compatibility under Linux

Preferred Linux interfaces:

- V4L2
- GStreamer
- FFmpeg
- OpenCV only where needed
- Hardware-assisted encoding using Intel Quick Sync / VAAPI if available

Recommended camera path:

```text
BoatEye HDMI OUT
        |
        v
Powered HDMI splitter
     /        \
    /          \
   v            v
Garmin HDMI   HDMI Capture
Direct Input      |
                  v
              Linux PC
```

This preserves a direct, raw BoatEye path to the Garmin if the PC fails.

---

# 5. BoatEye Features

## Phase 1

- Full-screen live 360° camera view
- Low-latency display
- Snapshot button
- Start/stop recording
- Rolling video buffer
- "Save Last 5 Minutes" button
- Optional timestamp
- Camera source status

## Phase 2

Overlay marine telemetry on top of the camera feed:

- Speed over ground
- Course over ground
- Heading
- Depth
- Water temperature
- Wind speed
- Wind direction
- RPM
- Fuel burn
- Battery voltage
- GPS coordinates
- Rudder/steering angle if available
- Engine status
- Alarm state

## Phase 3

Advanced video features:

- Automatic docking recording
- Event-based clip creation
- Motion detection
- Object detection
- Boat/person detection where useful
- Track history
- User-selectable overlays
- Clean video export with no overlays
- Telemetry-linked video replay
- Picture-in-picture modes
- Time-lapse
- Trip highlight generation

Do not make autonomous docking or safety-critical control decisions based on computer vision.

---

# 6. NMEA 2000 Integration

Selected interface:

**Digital Yacht iKonvert USB**

Reason for selection:

- NMEA 2000 to USB
- Linux-friendly
- Galvanic isolation
- Raw NMEA 2000 mode
- Standard NMEA 2000 connector
- Compatible with open-source marine data tools
- Suitable for custom software development

Physical path:

```text
NMEA 2000 Backbone
        |
        v
Digital Yacht iKonvert USB
        |
        v
Linux PC
```

Initial integration should be **read-only**.

The software must not transmit NMEA 2000 commands during initial development.

---

# 7. Marine Data Software Stack

Preferred architecture:

```text
iKonvert USB
    |
    v
CANboat / compatible raw decoder
    |
    v
Signal K Server
    |
    v
Palmer Lou Backend
    |
    +--> Live UI
    +--> Telemetry Database
    +--> Camera Overlays
    +--> Alerts
    +--> Trip Logger
    +--> AI Diagnostics
```

Signal K should be treated as an internal backend component.

The end user should never need to interact with Signal K directly.

Possible technologies:

- Signal K Server
- CANboat
- Node.js / TypeScript
- Python services where appropriate
- PostgreSQL
- TimescaleDB extension if useful
- SQLite for prototype only
- WebSocket for live data
- REST or internal typed API for historical queries

---

# 8. Initial NMEA Data to Capture

Record all useful supported telemetry, including where available:

## Engines

For each engine independently:

- Engine instance
- RPM
- Engine hours
- Fuel rate
- Fuel pressure
- Oil pressure
- Oil temperature
- Coolant temperature
- Coolant pressure
- Boost pressure
- Alternator voltage
- Engine load
- Trim
- Engine alarms
- Engine status flags

The vessel has triple Mercury outboards, so the UI must clearly distinguish:

- Port
- Center
- Starboard

## Navigation and vessel motion

- Latitude
- Longitude
- SOG
- COG
- Heading
- Rate of turn
- Pitch
- Roll
- Rudder/steering angle if exposed
- Depth
- Water temperature
- Wind speed
- Wind direction

## Electrical

- Battery voltage
- Battery current if exposed
- State of charge if exposed
- Alternator/charging data
- DC bus data

## Tanks

- Fuel
- Fresh water
- Waste
- Any additional tank sensors

---

# 9. Telemetry Storage

The system should continuously store marine telemetry locally.

Use efficient time-series storage.

Target retention:

- High-resolution recent data: 30–90 days
- Downsampled historical data: effectively unlimited within storage constraints

Example policy:

- 1 Hz raw values for recent period
- 10-second averages after 90 days
- 1-minute averages after one year

Store:

- Source
- Timestamp
- PGN or normalized Signal K path
- Value
- Unit
- Engine/device instance
- Quality/status flags where available

The application should support historical comparison.

Examples:

- Compare center-engine fuel flow to port/starboard at the same RPM.
- Show battery voltage during the previous five trips.
- Detect long-term changes in fuel economy.
- Compare cruise efficiency before and after propeller or engine changes.

---

# 10. Trip Logging

Trips should be detected automatically.

Possible start criteria:

- Engine RPM above threshold
- Vessel speed above threshold
- GPS movement
- Manual start button

Possible stop criteria:

- Engines off for a configurable period
- Vessel stationary for a configurable period
- Manual stop

Record:

- Start time
- End time
- Departure point
- Arrival point
- Track
- Distance traveled
- Duration
- Moving time
- Engine hours
- Fuel consumed
- Average fuel economy
- Best fuel economy
- Average speed
- Maximum speed
- Cruise RPM distribution
- Weather snapshot
- Water temperature
- Notable alarms/events
- Camera clips and snapshots associated with trip

---

# 11. Media Architecture

The Linux PC should also be the vessel's media system.

The user wants one unified touch interface.

Primary media categories:

- Live TV
- Music
- Music videos
- YouTube
- Local movies
- Streaming video
- Streaming audio

Possible services:

- YouTube TV
- YouTube
- Spotify
- SiriusXM
- Pandora
- Netflix
- Prime Video
- Disney+
- Local media library
- Plex/Jellyfin if useful

---

# 12. Android App Support

The system may use **Waydroid** to run Android applications inside Linux.

Use Android apps only when they provide a better experience than:

- Native Linux software
- A local web application
- API integration
- Browser-based PWA

Waydroid should be fully hidden behind the Palmer Lou interface.

The user should never see the Waydroid launcher.

Expected behavior:

```text
User touches "Spotify"
        |
        v
Palmer Lou launches Spotify Android app full-screen
        |
        v
User exits
        |
        v
Returns directly to Palmer Lou Home
```

Candidate Android app types:

- Music
- Weather
- Fishing
- Video
- Marine utility apps

DRM-dependent services may not function correctly in Waydroid because it is not necessarily a certified Widevine L1 device.

Therefore the software architecture must support multiple launch methods per service:

1. Native Linux app
2. Waydroid Android app
3. Full-screen browser/PWA
4. External API-based custom interface

The user should not care which method is used.

---

# 13. YouTube TV and Streaming Strategy

YouTube TV and other streaming services must appear as dedicated Palmer Lou apps.

The user must never need to open a browser manually.

If browser technology is required internally, launch it in:

- Kiosk mode
- Full screen
- No address bar
- No tabs
- No browser chrome
- No desktop exposure

Example:

```text
PALMER LOU HOME
       |
       v
   YOUTUBE TV
       |
       v
Full-screen YouTube TV experience
       |
       v
PALMER LOU HOME
```

Streaming services should be evaluated individually for:

- DRM support
- Hardware video decode
- Maximum supported resolution
- Audio support
- Touch usability
- Login persistence
- Session stability

Do not assume Netflix/Prime/etc. will support full HD/4K in Linux until tested.

---

# 14. Bluetooth Audio

Linux PC should pair directly with the vessel head unit over Bluetooth.

Requirements:

- Automatic reconnect after reboot
- Prefer configured vessel stereo
- User-visible connection status
- Easy reconnect button
- Media volume control
- Optional source volume normalization

Audio routing should support:

- Streaming services
- Music apps
- Local video
- BoatEye recordings
- System alerts where appropriate

Critical navigation or safety audio must remain independent of Palmer Lou OS unless explicitly designed otherwise.

---

# 15. Home Screen UX

The interface should use very large controls designed for a 16-inch marine touchscreen.

Suggested home screen:

```text
+------------------------------------------------+
|                 PALMER LOU                     |
|                                                |
|      TV              MUSIC                     |
|                                                |
|      360°            WEATHER                   |
|                                                |
|      FISHING         VESSEL                    |
|                                                |
|      TRIPS           MORE                      |
|                                                |
+------------------------------------------------+
```

The UI should be:

- Dark-friendly
- Sunlight-readable
- High contrast
- Minimal
- Large text
- Large touch targets
- No tiny controls
- No hover-dependent behavior
- No excessive animations
- Responsive to 1920 × 1200

Use clear full-screen modes.

---

# 16. Vessel Dashboard

Suggested overview:

```text
PORT             CENTER           STARBOARD
4050 RPM         4042 RPM         4057 RPM
17.1 GPH         17.8 GPH         17.0 GPH
159°F            160°F            158°F
14.2 V           14.1 V           14.2 V

SPEED        32.4 kt
DEPTH        78 ft
FUEL ECON    0.71 NM/gal
RANGE        214 NM
HEADING      084°
```

Support:

- Current values
- Historical charts
- Engine comparison
- Threshold alerts
- Trends
- Derived values

---

# 17. Weather

Do not duplicate SiriusXM Fish Mapping unnecessarily.

Garmin/SiriusXM should continue handling:

- Mission-critical marine weather
- Fish Mapping
- Navigation overlays

Palmer Lou OS should complement those systems with:

- NOAA marine forecasts
- NWS data
- Buoy observations
- Weather radar
- Wind forecast
- Barometric trend
- Tide/current
- SST data if available
- Chlorophyll data if available from lawful/accessible sources
- Lightning
- Forecast confidence
- Local vessel-measured conditions

Possible comparison:

```text
FORECAST WIND     14 kt SW
ONBOARD WIND      17 kt SW
BAROMETER         1008.4 mb
3-HOUR TREND      -2.1 mb
```

---

# 18. Fishing

Fishing must be a **first-class module**, not a generic link collection.

The system should support two complementary approaches:

1. **Palmer Lou Fishing Hub** — a custom, touch-first fishing application built into Palmer Lou OS.
2. **Third-party fishing apps** — launched full-screen through Waydroid, Linux/PWA, or another supported runtime when they offer capabilities worth keeping.

Do not attempt to rebuild or duplicate SiriusXM Fish Mapping where Garmin already provides a strong integrated experience.

## 18.1 Palmer Lou Fishing Hub

Create a dedicated fishing screen that combines vessel telemetry, internet data, trip history, and catch history.

Core features:

- Tide/current
- Moon phase
- Sunrise/sunset
- Water temperature
- Water temperature history
- Barometric pressure
- Barometric trend
- Wind
- Sea state where available
- NOAA buoy observations
- SST imagery/data where lawfully available
- Chlorophyll imagery/data where lawfully available
- Fishing trip log
- Catch log
- Species
- GPS location
- Depth
- Water temperature at catch
- Lure/bait
- Speed at catch
- Heading/course at catch
- Engine RPM at catch
- Weather at catch
- Photos
- Notes
- Waypoint association
- Historical catch analysis
- Favorite areas
- Species-specific views
- Search/filter by date, area, species, lure, temperature, depth, and conditions

The fishing module should automatically associate catches and notes with the active trip whenever possible.

Example future queries:

- "Show conditions from our best king mackerel days."
- "Where did we catch kings in 68–72°F water?"
- "What was the barometer doing on our best fishing days?"
- "Show catches within 5 NM of Cape Lookout Shoals."
- "What lure produced the most fish this season?"

## 18.2 Third-Party Fishing Apps

The platform must support launching selected fishing applications as dedicated full-screen Palmer Lou apps.

Possible categories:

- Fishing forecasts
- SST/chlorophyll products
- Tides/currents
- Catch logging
- Species regulations
- Weather routing
- Offshore fishing intelligence

Implementation options:

- Waydroid Android app
- Native Linux app
- PWA/web app in kiosk mode
- API integration into Palmer Lou Fishing Hub

The system should maintain a configurable **App Registry** describing each third-party app:

- Name
- Launch method
- Package ID or URL
- Authentication requirements
- Touch suitability
- Offline capability
- DRM/licensing limitations
- Data source/API availability
- Whether the app can be embedded or must run full-screen

Do not hard-code the product to any one commercial fishing provider. Build the module so providers can be added or removed later.

## 18.3 Fishing Data Provider Policy

Prefer:

- Official APIs
- Licensed feeds
- Public NOAA/NWS/USGS data
- User-owned data
- Export/import supported by the provider

Do not scrape or bypass access controls where prohibited.

Where a provider has no supported API, launch its official app or web interface instead of attempting brittle scraping.

## 18.4 SiriusXM Fish Mapping

SiriusXM Fish Mapping remains a Garmin-native capability.

Palmer Lou OS should not duplicate it unless a specific gap is identified.

Instead, Palmer Lou OS should complement SiriusXM with:

- Historical vessel data
- Catch history
- Local environmental trends
- Trip analytics
- User notes
- Camera/video linkage
- Cross-trip comparisons

---

# 19. Local Media

Store local media on the PC.

Suggested storage:

- 1–2 TB SSD

Features:

- Movies
- Kids' content
- Music
- Offline playback
- Downloaded media
- No internet required

Optional:

- Jellyfin
- Plex client/server
- Local indexed library
- Automatic metadata

---

# 20. Maintenance

Add a vessel maintenance area.

Track:

- Engine service
- Generator service
- Filters
- Pumps
- Batteries
- Oil changes
- Watermaker
- Electronics
- Safety equipment
- Trailer/service items if relevant

Support:

- Engine-hour-based reminders
- Date-based reminders
- Notes
- Photos
- Receipts
- Parts
- Part numbers
- Manuals
- Service history

---

# 21. Documentation Library

Store vessel documentation locally.

Examples:

- Mercury manuals
- Garmin manuals
- Wiring diagrams
- NMEA network diagram
- Parts lists
- Engine serial information
- Equipment manuals
- Service procedures
- Photos of wiring
- Connector pinouts
- Installation notes

Provide a searchable UI.

Future AI feature:

"Where does the center engine steering harness terminate?"

The answer should be grounded only in uploaded/local vessel documentation when possible.

---

# 22. AI Assistant

AI should initially be advisory and read-only.

Example queries:

- "Anything weird today?"
- "Why is the center engine burning more fuel?"
- "Compare the three engines at 4,000 RPM."
- "How much fuel did we burn on the last Cape Lookout trip?"
- "Has battery voltage been getting worse?"
- "When is the next engine service?"
- "Show me abnormal events from the last 30 minutes."

The AI should query:

- Telemetry
- Trip history
- Maintenance history
- Vessel documentation
- Alerts
- Camera event metadata

Do not allow AI to control:

- Steering
- Throttle
- JPO
- Autopilot
- Engine shutdown
- Bilge pumps
- Critical navigation systems

Noncritical control may be considered later with explicit user confirmation.

---

# 23. Alert Engine

Support configurable alerts.

Examples:

- Engine temperature above threshold
- Voltage below threshold
- Fuel burn imbalance
- Fuel economy deviation
- Excessive bilge activity
- Tank level low/high
- Rapid barometric drop
- NMEA device disappears
- Camera unavailable
- Bluetooth audio disconnected
- Internet lost
- Disk storage low

Alert priority:

- INFO
- WARNING
- CRITICAL

Avoid excessive nuisance alarms.

---

# 24. Software Architecture

Recommended structure:

```text
palmer-lou/
├── apps/
│   ├── ui/
│   ├── backend/
│   ├── launcher/
│   └── camera/
├── services/
│   ├── nmea/
│   ├── telemetry/
│   ├── trips/
│   ├── media/
│   ├── weather/
│   ├── alerts/
│   └── ai/
├── infrastructure/
│   ├── docker/
│   ├── systemd/
│   ├── database/
│   └── scripts/
├── docs/
└── tests/
```

Preferred application stack:

### Frontend
- React
- TypeScript
- Vite or Next.js if appropriate
- Touch-first component library
- Full-screen kiosk UI
- WebSocket live updates

### Backend
Either:

- Node.js + TypeScript

or:

- Python FastAPI

Choose based on strongest library support for the feature.

Mixed services are acceptable.

### Database
- PostgreSQL
- TimescaleDB preferred for telemetry if practical

### Video
- GStreamer preferred
- FFmpeg
- V4L2
- VAAPI/Intel hardware acceleration
- OpenCV only for computer vision tasks

### Marine Data
- Signal K
- CANboat
- iKonvert raw mode

### Android
- Waydroid

### Process Management
- systemd
- Docker Compose where useful

---

# 25. Kiosk / Appliance Mode

Boot flow:

```text
Power applied
   |
   v
Linux boot
   |
   v
Networking / Bluetooth
   |
   v
Signal K / telemetry services
   |
   v
Palmer Lou backend
   |
   v
Palmer Lou UI
   |
   v
Full-screen touchscreen ready
```

Requirements:

- Auto-login if a desktop session is required
- No desktop visible
- No cursor unless useful
- Auto-launch UI
- Auto-restart crashed services
- Watchdog
- Read-only or resilient root filesystem where practical
- Graceful handling of abrupt power removal
- Automatic database recovery
- Log rotation
- Storage monitoring
- Remote maintenance via SSH only when explicitly enabled

---

# 26. Mobile and Remote Access

Palmer Lou OS must be accessible from the user's phone and tablet both **on the boat LAN** and, when internet connectivity is available, **remotely from shore**.

The mobile experience should use the same backend and data model as the helm UI but provide a mobile-responsive interface.

## 26.1 Local Mobile Access

When connected to the vessel Wi-Fi/LAN, the user should be able to open Palmer Lou OS from a phone or tablet without any cloud dependency.

Preferred behavior:

- Local hostname such as `palmerlou.local`
- Responsive mobile UI
- Current vessel status
- Engine data
- Battery/electrical data
- Tank levels
- Weather
- Trip status
- Fishing log
- Camera snapshots/live view where practical
- Maintenance status
- Alerts
- Historical charts

Optional:

- Installable PWA icon on iPhone/iPad
- Biometric unlock using device/browser capabilities
- QR code in System Settings for first-time connection

## 26.2 Remote Access

Remote access should use an **outbound-initiated encrypted tunnel** so the boat does not require inbound port forwarding or a public static IP.

Preferred architecture:

```text
Phone / Tablet
      |
      v
Encrypted overlay / reverse tunnel
      |
      v
Palmer Lou Linux PC
      |
      v
Local Palmer Lou API and UI
```

Recommended implementation order:

1. **Tailscale / WireGuard-style private overlay network** for administrator and owner access.
2. Optional **Cloudflare Tunnel or equivalent outbound reverse tunnel** if a browser-accessible public endpoint is later desired.
3. Avoid exposing the Palmer Lou web server directly to the public internet.

The implementation should support Starlink, cellular, marina Wi-Fi, and changing WAN IP addresses.

## 26.3 Remote Information Available

Remote access may expose:

- Vessel online/offline state
- Last contact time
- GPS location
- SOG/COG
- Battery voltage/state
- Shore power/charging status if available
- Fuel/tank levels
- Bilge activity if integrated
- Engine hours
- Current alarms
- Current weather
- Historical telemetry
- Last trip
- Maintenance status
- BoatEye snapshot
- Optional low-bandwidth live camera stream
- Storage/system-health status

The mobile UI should clearly distinguish:

- **LIVE**
- **STALE**
- **OFFLINE**

and display the timestamp of the latest data.

## 26.4 Remote Control Policy

Remote access is **read-only by default**.

Do not permit remote control of:

- Engines
- Steering
- Throttle
- JPO
- Autopilot
- Bilge pumps
- Critical navigation equipment
- Fire suppression
- Any safety-critical system

Future noncritical remote actions such as cabin lighting or media controls may be added only behind explicit authentication, confirmation, audit logging, and per-feature enablement.

## 26.5 Store-and-Forward

When Palmer Lou loses internet connectivity:

- Continue recording telemetry locally.
- Continue camera/event recording locally.
- Continue trip logging.
- Queue remote telemetry summaries.
- Automatically resume synchronization when internet returns.

Do not require constant cloud connectivity for core vessel functionality.

## 26.6 Remote Notifications

Future versions may provide push/email/SMS notifications for important conditions such as:

- Boat unexpectedly moves
- Battery voltage low
- Shore power lost
- High bilge activity
- Critical temperature
- NMEA device missing
- Storage nearly full
- Palmer Lou OS offline unexpectedly

Notifications should link back to the relevant mobile status page.

---

# 27. Security

The system is connected to vessel networks and the internet.

Requirements:

- Firewall enabled
- Minimal exposed ports
- No unnecessary inbound internet access
- Application runs as non-root where possible
- Secrets stored securely
- Local authentication for administrative functions
- Updates under explicit maintenance workflow
- Separate normal-user and admin modes
- No automatic execution of unknown downloads
- Strong isolation between Waydroid and vessel-control components
- NMEA transmit disabled initially
- Never bridge Garmin Marine Network to internet-facing networks without explicit design review

---

# 28. Offline Operation

The following should continue working without internet:

- Home UI
- BoatEye live view
- BoatEye recording
- NMEA telemetry
- Vessel dashboard
- Trip logging
- Maintenance
- Local movies
- Local music
- Historical charts
- Documentation
- Local alerts

Internet-dependent features should indicate:

**OFFLINE**

rather than fail unpredictably.

---

# 29. Phase 1 MVP

The first milestone should prove the hardware and UX assumptions before building advanced features.

## MVP Requirements

1. Linux boots directly into Palmer Lou UI.
2. Garmin 8616 displays PC HDMI output.
3. Garmin 8616 touchscreen controls Linux reliably.
4. Bluetooth connects automatically to vessel stereo.
5. BoatEye feed appears live through HDMI capture.
6. BoatEye latency is measured.
7. Record and save BoatEye video.
8. "Save Last 5 Minutes" works.
9. YouTube launches full-screen.
10. YouTube TV launches full-screen.
11. Spotify launches full-screen.
12. A weather screen exists.
13. User can always return to Palmer Lou Home.
14. No Linux desktop/browser chrome is exposed in normal operation.
15. Mobile-responsive Palmer Lou UI works over the local vessel LAN.
16. Remote-access architecture is prepared but may remain disabled until NMEA integration is stable.

Do not add NMEA until these are stable.

---

# 30. Phase 2

Add:

- Digital Yacht iKonvert USB
- Signal K
- CANboat
- Engine dashboard
- Vessel data
- Telemetry database
- Basic trip logger
- NMEA overlays on BoatEye
- Historical engine charts
- Fuel burn comparison

---

# 31. Phase 3

Add:

- Fishing log
- Maintenance
- Weather integrations
- NOAA buoy data
- Tide/current
- Local media library
- Boat documentation library
- Advanced video event recording

---

# 32. Phase 4

Add:

- AI diagnostics
- Anomaly detection
- Predictive maintenance
- Natural-language telemetry queries
- Video/event correlation
- Automated trip summaries
- Historical performance analysis

---

# 33. Acceptance Criteria

The system is successful when:

- The user powers on the electronics and sees Palmer Lou OS without touching the PC.
- The Garmin touchscreen feels like a native application interface.
- No Linux knowledge is required during normal use.
- BoatEye works reliably and with acceptable latency.
- Streaming services are accessible without manual browser interaction.
- Bluetooth audio reconnects automatically.
- NMEA telemetry can be recorded continuously without affecting the vessel network.
- Garmin navigation and mission-critical systems remain independent.
- The UI remains usable offline.
- A failure of Palmer Lou OS does not impair normal operation of the vessel.

---

# 34. Important Constraints for AI Developers

When implementing this project:

1. **Do not assume hardware behavior without testing.**
2. Build hardware diagnostic tools first for:
   - Garmin touch HID
   - BoatEye capture formats
   - Bluetooth audio
   - iKonvert serial/raw data
3. Do not write NMEA 2000 messages during early phases.
4. Do not attempt to control engines, steering, JPO, or autopilot.
5. Avoid vendor lock-in where practical.
6. Keep services modular.
7. Use local-first architecture.
8. Keep the UI touch-first.
9. Hide all implementation complexity from the end user.
10. Prefer documented APIs and open protocols.
11. Build extensive logging and diagnostics.
12. Do not silently fail.
13. Provide a simple "System Status" page for troubleshooting.
14. Treat video latency as a primary requirement for docking mode.
15. Do not expose a generic browser or desktop in normal operation.

---

# 35. Initial Development Tasks for the AI Coding Agent

Start with these tasks in order.

## Task 1 — Repository and Environment

Create the project structure, development README, Docker Compose configuration where appropriate, and Linux install scripts.

## Task 2 — Touch Test Utility

Create a full-screen Linux utility that displays:

- Touch coordinates
- Device ID
- HID device information
- Touch-down/up
- Drag movement
- Multi-touch contacts if present

Purpose: validate Garmin 8616 Touch Out.

## Task 3 — BoatEye Capture Test

Create a utility that:

- Enumerates V4L2 devices
- Displays supported formats
- Shows live BoatEye video
- Measures approximate capture latency
- Records a test clip
- Uses hardware video encode when available

## Task 4 — Bluetooth Test

Create a service/UI that:

- Finds the vessel head unit
- Pairs
- Saves device
- Reconnects automatically
- Shows connection status

## Task 5 — Palmer Lou Launcher

Create a 1920 × 1200 full-screen touch UI containing:

- TV
- Music
- 360°
- Weather
- Fishing
- Vessel
- Trips
- More

At this stage, buttons may open placeholder views.

## Task 6 — Media Launching

Implement full-screen launch/return behavior for:

- YouTube
- YouTube TV
- Spotify

Do not expose browser controls.

## Task 7 — Camera Module

Integrate BoatEye live view into the main application.

Add:

- Record
- Snapshot
- Save Last 5 Minutes
- Home

## Task 8 — Appliance Boot

Configure the machine so that Palmer Lou OS launches automatically after boot.

Verify recovery after abrupt power loss.

## Task 9 — Mobile UI

Create a responsive mobile version of the Palmer Lou interface that works over the vessel LAN.

Include:

- Vessel summary
- Camera snapshot
- Media status
- Weather
- System status
- Placeholder telemetry tiles for future NMEA data

## Task 10 — Secure Remote Access

Implement an outbound-only remote access path using a private overlay network such as Tailscale/WireGuard.

Requirements:

- No router port forwarding
- Strong authentication
- Owner/admin access only
- Read-only remote vessel views by default
- Clear live/stale/offline timestamps
- Easy disable switch from the local System page

Only after Tasks 1–10 are stable should development proceed to NMEA integration.

---

# 36. Future Hardware Expansion

Potential future inputs:

- Additional HDMI cameras
- IP cameras
- FLIR
- NMEA 0183
- Victron data
- Digital switching status
- Bilge-pump current sensors
- Additional environmental sensors
- Additional touchscreen stations

The architecture should not assume only one camera or one display forever, but Phase 1 should focus on **one Garmin 8616**.

---

# 37. Summary

Palmer Lou OS should be an embedded marine infotainment and vessel intelligence appliance that:

- Uses Linux as the underlying OS
- Uses Garmin 8616 as the primary touchscreen
- Ingests BoatEye 360 video directly
- Runs streaming/music/weather/fishing apps in a focused UI
- Supports Android apps through Waydroid where appropriate
- Uses browser technologies invisibly where required
- Uses Digital Yacht iKonvert USB for future raw NMEA 2000 data
- Stores vessel telemetry and trip history
- Adds useful video overlays and recording
- Eventually provides AI-based vessel diagnostics
- Never interferes with Garmin navigation or Mercury/JPO critical systems

The experience should feel like **a factory-installed Palmer Lou operating system**, not a computer mounted on a boat.
