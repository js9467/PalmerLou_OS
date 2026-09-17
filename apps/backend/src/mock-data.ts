export const dashboardSummary = {
  version: {
    currentVersion: "0.1.0",
    channel: "vessel",
    feedUrl: process.env.PALMER_LOU_UPDATE_FEED_URL ?? "",
    lastCheckedAt: "Never",
    latestVersion: null,
    available: false,
    notes: "Point PALMER_LOU_UPDATE_FEED_URL at a JSON manifest to enable remote version checks."
  },
  vesselName: "Palmer Lou",
  harbor: "Morehead City, NC",
  mode: "Helm ready",
  connectivity: {
    network: "Unknown",
    camera: "Unknown",
    gps: "Unknown",
    nmea: "NMEA status unavailable"
  },
  system: {
    uptime: "Unknown",
    storage: "Unknown",
    recording: "Unknown"
  },
  bluetooth: {
    status: "Unknown",
    device: "Unconfigured",
    audioRoute: "Unknown"
  },
  touchscreen: {
    status: "Unknown",
    resolution: "Unknown",
    calibration: "Unknown"
  },
  weather: {
    wind: "Unknown",
    barometer: "Unknown",
    waterTemp: "Unknown",
    tide: "Unknown"
  },
  update: {
    currentVersion: "0.1.0",
    channel: "vessel",
    feedUrl: process.env.PALMER_LOU_UPDATE_FEED_URL ?? "",
    lastCheckedAt: "Never",
    latestVersion: null,
    available: false,
    notes: "Configure a remote update feed to enable version checks from home."
  },
  camera: {
    label: "BoatEye 360",
    status: "Unknown",
    recording: false,
    bufferMinutes: 0,
    latencyMs: 0
  },
  metrics: [
    { label: "Speed", value: "--", unit: "kt", accent: "aqua" },
    { label: "Heading", value: "--", unit: "deg", accent: "aqua" },
    { label: "Depth", value: "--", unit: "ft", accent: "teal" },
    { label: "Fuel economy", value: "--", unit: "NM/gal", accent: "sand" },
    { label: "Range", value: "--", unit: "NM", accent: "aqua" }
  ],
  engines: [
    { label: "Port", rpm: 0, gph: 0, tempF: 0, voltage: 0 },
    { label: "Center", rpm: 0, gph: 0, tempF: 0, voltage: 0 },
    { label: "Starboard", rpm: 0, gph: 0, tempF: 0, voltage: 0 }
  ],
  apps: [
    {
      id: "streaming",
      name: "TV",
      subtitle: "YouTube TV, YouTube, and other full-screen video apps",
      launchMethod: "Native app / Waydroid / PWA",
      status: "Ready",
      description: "Dedicated full-screen launch point for video services."
    },
    {
      id: "music",
      name: "Music",
      subtitle: "Spotify, SiriusXM, local audio",
      launchMethod: "Native app / Waydroid",
      status: "Ready",
      description: "Unified music entry point with return-to-home behavior."
    },
    {
      id: "bluetooth",
      name: "Bluetooth",
      subtitle: "Stereo pair, reconnect, and audio route",
      launchMethod: "System link",
      status: "Ready",
      description: "Quick path to verify the vessel head unit and audio handoff."
    },
    {
      id: "touchscreen",
      name: "Touchscreen",
      subtitle: "Input test and calibration status",
      launchMethod: "Touch test",
      status: "Ready",
      description: "Large-tile touch validation for the Garmin display."
    },
    {
      id: "camera",
      name: "360°",
      subtitle: "BoatEye live view, snapshot, and recording",
      launchMethod: "Direct video",
      status: "Live",
      description: "Low-latency camera access with snapshot, recording, and clip controls."
    },
    {
      id: "weather",
      name: "Weather",
      subtitle: "NOAA, buoy, tide, and onboard conditions",
      launchMethod: "Local web app / PWA",
      status: "Online",
      description: "Weather overview with marine context and trend tiles."
    },
    {
      id: "fishing",
      name: "Fishing",
      subtitle: "Catch log and fishing intelligence",
      launchMethod: "Local hub / PWA",
      status: "Online",
      description: "Trip-aware fishing workspace with future provider hooks."
    },
    {
      id: "vessel",
      name: "Vessel",
      subtitle: "Engines, telemetry, alarms, and systems",
      launchMethod: "Local dashboard",
      status: "Online",
      description: "A large-touch overview of the boat and its live telemetry."
    },
    {
      id: "trips",
      name: "Trips",
      subtitle: "Trip logs, tracks, and comparisons",
      launchMethod: "Local database",
      status: "Ready",
      description: "Trip summaries and historical comparisons."
    },
    {
      id: "more",
      name: "More",
      subtitle: "Settings, about, and remote access",
      launchMethod: "System settings",
      status: "Ready",
      description: "System settings and future integrations."
    }
  ],
  trips: [],
  alerts: []
} as const;

export const bluetoothBootstrap = {
  status: "Unknown",
  device: "Unconfigured",
  audioRoute: "Unknown",
  connected: false,
  lastAction: "Idle",
  updatedAt: new Date().toISOString(),
  lastError: null
} as const;
