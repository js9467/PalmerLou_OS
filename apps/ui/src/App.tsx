import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BootSplash } from "./components/BootSplash";
import { CameraPanel } from "./components/CameraPanel";
import { DepthTempGraph } from "./components/DepthTempGraph";
import { HomeHeader } from "./components/HomeHeader";
import { MetricCard } from "./components/MetricCard";
import { OfflineState } from "./components/OfflineState";
import { TripSummaryCard } from "./components/TripSummaryCard";
import { fallbackSummary } from "./lib/fallback";
import { assetUrl } from "./lib/assetUrl";
import {
  appendTripBreadcrumb,
  finalizeTripLog,
  shouldEndTripAtHome,
  startTripLog,
  readStoredTrips,
  writeStoredTrips,
  type TripLog
} from "./lib/trips";
import {
  loadOceanBuoys,
  loadOceanCurrentVectors,
  loadStormRadarFrame,
  loadTrips,
  loadWeatherForecast,
  loadBluetoothState,
  loadLauncherState,
  loadRemoteAccessStatus,
  loadRemoteUpdateStatus,
  loadHomePortConfig,
  loadSummary,
  loadSystemTime,
  loadVersionStatus,
  loadSpeciesIntel,
  loadWifiNetworks,
  requestFishingAdvisor,
  runBluetoothDiagnostics,
  runRemoteUpdateApply,
  scanBluetoothDevices,
  sendBluetoothAction,
  sendKillLaunchedAppRequest,
  sendLaunchRequest,
  sendRemoteControlAction,
  sendRemoteTypeRequest,
  sendRemoteTunnelAction,
  sendReturnHomeRequest,
  saveHomePortConfig,
  disconnectWifiNetwork,
  joinWifiNetwork
} from "./lib/api";
import { Circle, CircleMarker, MapContainer, Polygon, Polyline, Popup, TileLayer, Tooltip, WMSTileLayer, useMap, useMapEvents } from "react-leaflet";
import type {
  AllSpeciesIntelResponse,
  BluetoothDiagnostics,
  BluetoothState,
  DashboardSummary,
  EngineBreadcrumbSnapshot,
  FishingAdvisorResponse,
  FishingCatch,
  LauncherState,
  OceanBuoyObservation,
  OceanCurrentVector,
  RemoteAccessStatus,
  RemoteUpdateStatus,
  SpeciesIntelEntry,
  TripDescriptor,
  WeatherForecastCard,
  WifiNetwork
} from "./types";

const FISHING_LOG_STORAGE_KEY = "palmer-lou-fishing-catches";
const HOME_TILE_LAYOUT_STORAGE_KEY = "palmer-lou-home-tile-layout";
const CUSTOM_BAIT_PRESETS_STORAGE_KEY = "palmer-lou-custom-bait-presets";
const FISHING_MAP_PREFS_STORAGE_KEY = "palmer-lou-fishing-map-prefs";
const OCEAN_CURRENT_VECTOR_CACHE_STORAGE_KEY = "palmer-lou-ocean-current-vectors-cache";
const LAST_VESSEL_POSITION_STORAGE_KEY = "palmer-lou-last-vessel-position";
const TRIP_LOG_STORAGE_KEY = "palmer-lou-trip-log";
const pelagicSpecies = ["Tuna", "Billfish", "Swordfish", "Kingfish", "Wahoo", "Mahi Mahi"];
const BAIT_TYPE_FILTERS = ["All types", "Live bait", "Artificial", "Trolling", "Jigging"] as const;
const BAIT_COLOR_FILTERS = ["All colors", "Natural", "Blue/White", "Pink", "Green", "Purple", "Red/Black", "Silver"] as const;
const HOME_TILE_IDS = ["speed", "heading", "depth", "water-temp", "clock", "connection", "camera", "tide", "barometer", "bluetooth"] as const;

type HomeTileId = typeof HOME_TILE_IDS[number];
type BaitType = Exclude<(typeof BAIT_TYPE_FILTERS)[number], "All types">;
type BaitColor = Exclude<(typeof BAIT_COLOR_FILTERS)[number], "All colors">;
type RemoteControlAction = "up" | "down" | "left" | "right" | "select" | "back" | "home" | "playpause" | "volup" | "voldown" | "mute" | "backspace";
type MapHeadingMode = "north" | "course";

type BaitPreset = {
  id: string;
  name: string;
  type: BaitType;
  color: BaitColor;
  profile: string;
  custom?: boolean;
};

type SpeciesFishProfile = {
  temperatureRangeF: { min: number; max: number };
  chlorophyllSignal: string;
  currentSignal: string;
  depthBand: string;
  color: string;
};

const DEFAULT_HOME_TILE_LAYOUT: HomeTileId[] = ["speed", "heading", "depth", "water-temp", "clock", "camera"];
const TRIP_HOME_RADIUS_STORAGE_KEY = "palmer-lou-trip-home-radius-nm";
const HOME_PORT_CONFIG_STORAGE_KEY = "palmer-lou-home-port-config";
const REMOTE_HAPTICS_ENABLED_STORAGE_KEY = "palmer-lou-remote-haptics-enabled";
const REMOTE_TRACKPAD_SENSITIVITY_STORAGE_KEY = "palmer-lou-remote-trackpad-sensitivity";
const DEFAULT_TRIP_HOME_RADIUS_NM = 0.15;
const REMOTE_ACCESS_PATH = "/?remote=1";
const REMOTE_HOLD_INITIAL_DELAY_MS = 260;
const REMOTE_HOLD_REPEAT_MS = 115;
const REMOTE_TRACKPAD_DRAG_STEP_PX = 5;
const REMOTE_TRACKPAD_TAP_MAX_TRAVEL_PX = 10;
const REMOTE_TRACKPAD_TAP_MAX_MS = 260;
const BILGEBUDDY_EMBED_URL = "https://app.bilgebuddy.io/";
const WEATHER_RADAR_MAX_NATIVE_ZOOM = 8;
const WEATHER_RADAR_MAX_ZOOM = 14;
const WEATHER_RADAR_WMS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r-t.cgi";
const WEATHER_RADAR_WMS_LAYER = "nexrad-n0r-wmst";
const WEATHER_RANGE_RINGS_NM = [10, 20, 40, 80] as const;

function projectPointByCourse(lat: number, lon: number, headingDegrees: number, distanceNm: number) {
  const headingRad = (headingDegrees * Math.PI) / 180;
  const latDelta = (distanceNm / 60) * Math.cos(headingRad);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lngScale = Math.max(0.15, Math.abs(cosLat));
  const lngDelta = ((distanceNm / 60) * Math.sin(headingRad)) / lngScale;

  return {
    latitude: lat + latDelta,
    longitude: lon + lngDelta
  };
}

function readCachedOceanCurrentVectors() {
  if (typeof window === "undefined") {
    return [] as OceanCurrentVector[];
  }

  try {
    const raw = window.localStorage.getItem(OCEAN_CURRENT_VECTOR_CACHE_STORAGE_KEY);
    if (!raw) {
      return [] as OceanCurrentVector[];
    }

    const parsed = JSON.parse(raw) as OceanCurrentVector[];
    if (!Array.isArray(parsed)) {
      return [] as OceanCurrentVector[];
    }

    return parsed.filter((item) => {
      return Number.isFinite(item.latitude)
        && Number.isFinite(item.longitude)
        && Number.isFinite(item.speedKnots)
        && Number.isFinite(item.directionDegrees)
        && typeof item.observedAt === "string";
    });
  } catch {
    return [] as OceanCurrentVector[];
  }
}

function isRemoteModeUrl() {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  const flag = params.get("remote");
  return window.location.pathname.startsWith("/remote") || flag === "1" || flag === "true";
}

function readHomePortConfig() {
  const fallbackRadius = (() => {
    if (typeof window === "undefined") {
      return DEFAULT_TRIP_HOME_RADIUS_NM;
    }

    const rawLegacyRadius = window.localStorage.getItem(TRIP_HOME_RADIUS_STORAGE_KEY);
    const parsedLegacyRadius = rawLegacyRadius === null || rawLegacyRadius === undefined || rawLegacyRadius === ""
      ? Number.NaN
      : Number.parseFloat(rawLegacyRadius);
    if (!Number.isFinite(parsedLegacyRadius) || parsedLegacyRadius <= 0) {
      return DEFAULT_TRIP_HOME_RADIUS_NM;
    }

    return Math.min(Math.max(parsedLegacyRadius, 0.05), 2.5);
  })();

  if (typeof window === "undefined") {
    return {
      latitude: null as number | null,
      longitude: null as number | null,
      radiusNm: fallbackRadius
    };
  }

  const raw = window.localStorage.getItem(HOME_PORT_CONFIG_STORAGE_KEY);
  if (!raw) {
    return {
      latitude: null as number | null,
      longitude: null as number | null,
      radiusNm: fallbackRadius
    };
  }

  try {
    const parsed = JSON.parse(raw) as { latitude?: unknown; longitude?: unknown; radiusNm?: unknown };
    const latitude = typeof parsed.latitude === "number" && Number.isFinite(parsed.latitude) ? parsed.latitude : null;
    const longitude = typeof parsed.longitude === "number" && Number.isFinite(parsed.longitude) ? parsed.longitude : null;
    const parsedRadius = typeof parsed.radiusNm === "number" && Number.isFinite(parsed.radiusNm)
      ? parsed.radiusNm
      : fallbackRadius;
    const radiusNm = Math.min(Math.max(parsedRadius, 0.05), 2.5);

    return {
      latitude,
      longitude,
      radiusNm
    };
  } catch {
    return {
      latitude: null as number | null,
      longitude: null as number | null,
      radiusNm: fallbackRadius
    };
  }
}

function toHomePortLabel(point: { latitude: number; longitude: number } | null) {
  if (!point) {
    return "Not configured";
  }

  return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
}

function readRemoteHapticsEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(REMOTE_HAPTICS_ENABLED_STORAGE_KEY) === "1";
}

function readLastVesselPosition(): { latitude: number; longitude: number } | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(LAST_VESSEL_POSITION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { latitude?: unknown; longitude?: unknown; updatedAt?: unknown };
    if (typeof parsed.latitude === "number" && typeof parsed.longitude === "number" && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
      if (typeof parsed.updatedAt !== "string") {
        return null;
      }

      const updatedAtMs = Date.parse(parsed.updatedAt);
      if (!Number.isFinite(updatedAtMs)) {
        return null;
      }

      // Ignore stale coordinates so old sessions do not force incorrect map centers.
      if (Date.now() - updatedAtMs > (1000 * 60 * 60 * 18)) {
        return null;
      }

      return { latitude: parsed.latitude, longitude: parsed.longitude };
    }
  } catch {
    return null;
  }

  return null;
}

function readTrackpadSensitivity(): TrackpadSensitivity {
  if (typeof window === "undefined") {
    return "normal";
  }

  const stored = window.localStorage.getItem(REMOTE_TRACKPAD_SENSITIVITY_STORAGE_KEY);
  if (stored === "fine" || stored === "normal" || stored === "fast") {
    return stored;
  }

  return "normal";
}

const BAIT_PRESETS: BaitPreset[] = [
  { id: "live-menhaden", name: "Live Menhaden", type: "Live bait", color: "Natural", profile: "Slow troll" },
  { id: "live-ballyhoo", name: "Live Ballyhoo", type: "Live bait", color: "Natural", profile: "Surface skip" },
  { id: "naked-ballyhoo", name: "Naked Ballyhoo", type: "Trolling", color: "Natural", profile: "Naked rig" },
  { id: "iw-lure-bw", name: "Ilander + Ballyhoo", type: "Trolling", color: "Blue/White", profile: "Small/medium skirt" },
  { id: "chugger-pink", name: "Chugger", type: "Trolling", color: "Pink", profile: "Heavy chop" },
  { id: "cedar-plug", name: "Cedar Plug", type: "Trolling", color: "Natural", profile: "High speed" },
  { id: "feather-green", name: "Feather Jig", type: "Artificial", color: "Green", profile: "Bird/school chase" },
  { id: "knife-jig-silver", name: "Knife Jig", type: "Jigging", color: "Silver", profile: "Vertical 120-240 g" },
  { id: "butterfly-purple", name: "Butterfly Jig", type: "Jigging", color: "Purple", profile: "Mark drop" },
  { id: "islander-redblack", name: "Islander Skirt", type: "Trolling", color: "Red/Black", profile: "Low light pass" }
];

const QUICK_LOG_LURE_TYPES: BaitType[] = ["Live bait", "Artificial", "Trolling", "Jigging"];
const QUICK_LOG_LURE_COLORS: BaitColor[] = ["Natural", "Blue/White", "Pink", "Green", "Purple", "Red/Black", "Silver"];
const QUICK_FISH_SIZE_PRESETS = [24, 28, 32, 36, 40, 45] as const;

const SPECIES_FISHMAP_PROFILES: Record<string, SpeciesFishProfile> = {
  Tuna: {
    temperatureRangeF: { min: 70, max: 80 },
    chlorophyllSignal: "Chlorophyll edge + bait cloud",
    currentSignal: "Cross-current seam with stable break",
    depthBand: "120-600 ft temp break",
    color: "#00c0c0"
  },
  Billfish: {
    temperatureRangeF: { min: 74, max: 84 },
    chlorophyllSignal: "Clear-blue water edge with bait shadows",
    currentSignal: "Warm current push with pronounced seam",
    depthBand: "200-1000+ ft canyon edge",
    color: "#b58dff"
  },
  Swordfish: {
    temperatureRangeF: { min: 68, max: 78 },
    chlorophyllSignal: "Deep blue edge with sparse bloom",
    currentSignal: "Offshore break and eddy shoulder",
    depthBand: "300-1200 ft outside edge",
    color: "#f0c96b"
  },
  Kingfish: {
    temperatureRangeF: { min: 72, max: 82 },
    chlorophyllSignal: "Sharp plankton front with clean edge",
    currentSignal: "Current edge with bait compression",
    depthBand: "100-400 ft shelf break",
    color: "#ff8f70"
  },
  Wahoo: {
    temperatureRangeF: { min: 74, max: 82 },
    chlorophyllSignal: "Blue-water side of strong color break",
    currentSignal: "Fast current lane and bait stacking",
    depthBand: "140-600 ft contour edge",
    color: "#ff5b8a"
  },
  "Mahi Mahi": {
    temperatureRangeF: { min: 76, max: 84 },
    chlorophyllSignal: "Floating weed / grassy bloom line",
    currentSignal: "Surface slick with debris and convergence",
    depthBand: "Surface to 200 ft over structure",
    color: "#6ad8a2"
  }
};

const SPECIES_FRONT_PREFERENCE: Record<string, { sst: number; convergence: number }> = {
  Tuna: { sst: 1.05, convergence: 0.95 },
  Billfish: { sst: 0.9, convergence: 1.1 },
  Swordfish: { sst: 0.82, convergence: 1.18 },
  Kingfish: { sst: 1.12, convergence: 0.9 },
  Wahoo: { sst: 1.2, convergence: 0.82 },
  "Mahi Mahi": { sst: 0.92, convergence: 1.08 }
};

const SPECIES_MIN_OFFSHORE_NM: Record<string, number> = {
  tuna: 22,
  billfish: 30,
  swordfish: 32,
  kingfish: 8,
  wahoo: 30,
  "mahi mahi": 16,
  yellowfin: 24,
  marlin: 32,
  sailfish: 24
};

type LaunchTarget = {
  id: string;
  name: string;
  subtitle: string;
  launchUrl: string;
  launchLabel: string;
  logoPath: string;
  accent?: string;
  tileClass?: string;
};

type FishingMapPoint = FishingCatch & {
  mapLatitude: number;
  mapLongitude: number;
  color: string;
  lureName: string;
};

type FishingMapCluster = {
  id: string;
  mapLatitude: number;
  mapLongitude: number;
  points: FishingMapPoint[];
};

type FishingMapViewMode = "clusters" | "heatmap" | "points";
type FishingBasemap = "nautical" | "standard" | "satellite";
type OceanOverlayId = "sst" | "chlorophyll" | "currents" | "contours" | "fronts";
type OceanTileOverlayId = "sst" | "chlorophyll" | "currents";
type FishingSubview = "map" | "logbook";
type FishingMapMode = "navigate" | "hunt";
type VesselSubview = "systems" | "myvessel" | "bilgebuddy";
type SettingsSubview = "bluetooth" | "wifi" | "remote" | "updates";

type FishMappingCircle = {
  id: string;
  species: string;
  latitude: number;
  longitude: number;
  radiusNm: number;
  score: number;
  confidence: "high" | "medium" | "low";
  profile: SpeciesFishProfile;
  supportingCount: number;
  points: [number, number][];
};

type TrackpadPoint = {
  x: number;
  y: number;
};

type TrackpadSensitivity = "fine" | "normal" | "fast";

type GeoPoint = {
  latitude: number;
  longitude: number;
};

function buildSpeciesCoveragePolygon(latitude: number, longitude: number, radiusNm: number, species: string): [number, number][] {
  const arcs = 11;
  const offsetScale = radiusNm / 18;
  const speciesBias = species.length % 5;

  return Array.from({ length: arcs }, (_, index) => {
    const angle = (index / arcs) * Math.PI * 2;
    const spread = 1 + (((Math.sin(angle * 2.1 + speciesBias) + 1) / 2) * 0.8);
    const radialOffset = radiusNm * 0.25 * spread * offsetScale;
    const latOffset = Math.cos(angle) * radialOffset / 60;
    const lngOffset = Math.sin(angle) * radialOffset / 60;

    return [latitude + latOffset, longitude + lngOffset] as [number, number];
  });
}

const LAND_POLYGONS: Array<[number, number][]> = [
  [
    [31.35, -83.8],
    [31.3, -80.0],
    [24.4, -79.9],
    [24.2, -83.2],
    [27.1, -84.8],
    [29.6, -84.5],
    [30.7, -84.0],
    [31.35, -83.8]
  ],
  [
    [30.2, -97.8],
    [31.8, -97.8],
    [31.8, -80.7],
    [30.95, -80.7],
    [30.55, -82.8],
    [30.4, -84.6],
    [29.9, -86.5],
    [29.55, -89.0],
    [29.3, -92.0],
    [29.2, -95.4],
    [29.6, -97.2],
    [30.2, -97.8]
  ]
];

const INSHORE_WATER_POLYGONS: Array<[number, number][]> = [
  // Pamlico + Albemarle Sound (approximate envelope)
  [
    [36.55, -76.55],
    [36.42, -75.95],
    [36.08, -75.68],
    [35.70, -75.56],
    [35.26, -75.57],
    [35.02, -75.72],
    [34.96, -76.20],
    [35.10, -76.75],
    [35.55, -76.95],
    [36.15, -76.90],
    [36.55, -76.55]
  ]
];

const ATLANTIC_COAST_MIN_LON: Array<[number, number]> = [
  [30, -81.5], [31, -81.4], [32, -80.9], [33, -79.2], [34, -77.9],
  [35, -76.5], [36, -75.8], [37, -75.7], [38, -75.0], [39, -74.4],
  [40, -74.0], [41, -72.6], [42, -70.8], [43, -70.3], [44, -68.6], [45, -67.0],
];

function atlanticCoastMinLon(latitude: number): number | null {
  if (latitude < 30 || latitude > 45) { return null; }
  for (let i = 0; i < ATLANTIC_COAST_MIN_LON.length - 1; i++) {
    const lo = ATLANTIC_COAST_MIN_LON[i]!;
    const hi = ATLANTIC_COAST_MIN_LON[i + 1]!;
    if (latitude >= lo[0] && latitude <= hi[0]) {
      const t = (latitude - lo[0]) / (hi[0] - lo[0]);
      return lo[1] + t * (hi[1] - lo[1]);
    }
  }
  return null;
}

function pointInPolygon(point: GeoPoint, polygon: [number, number][]) {
  let inside = false;

  for (let index = 0, j = polygon.length - 1; index < polygon.length; j = index, index += 1) {
    const start = polygon[index];
    const end = polygon[j];
    if (!start || !end) {
      continue;
    }

    const xi = start[1];
    const yi = start[0];
    const xj = end[1];
    const yj = end[0];
    const intersects = ((yi > point.latitude) !== (yj > point.latitude))
      && (point.longitude < ((xj - xi) * (point.latitude - yi)) / ((yj - yi) || Number.EPSILON) + xi);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function isLikelyLand(point: GeoPoint) {
  if (LAND_POLYGONS.some((polygon) => pointInPolygon(point, polygon))) {
    return true;
  }
  if (point.longitude >= -85 && point.longitude <= -64) {
    const minLon = atlanticCoastMinLon(point.latitude);
    if (minLon !== null && point.longitude < minLon) {
      return true;
    }
  }
  return false;
}

function isLikelyInshoreWater(point: GeoPoint) {
  return INSHORE_WATER_POLYGONS.some((polygon) => pointInPolygon(point, polygon));
}

function isLikelyNearshoreInvalid(point: GeoPoint) {
  return isLikelyLand(point) || isLikelyInshoreWater(point);
}

function pushPointOffshore(point: GeoPoint, anchors: Array<{ latitude: number; longitude: number }>) {
  if (!isLikelyNearshoreInvalid(point)) {
    return point;
  }

  const anchor = anchors
    .filter((entry) => !isLikelyNearshoreInvalid({ latitude: entry.latitude, longitude: entry.longitude }))
    .map((entry) => ({
      ...entry,
      distance: Math.hypot(entry.latitude - point.latitude, entry.longitude - point.longitude)
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (anchor) {
    return {
      latitude: anchor.latitude,
      longitude: anchor.longitude
    };
  }

  const coastLon = atlanticCoastMinLon(point.latitude);
  if (coastLon !== null) {
    const lngPerNm = 1 / (60 * Math.max(0.1, Math.cos((point.latitude * Math.PI) / 180)));
    return {
      latitude: point.latitude,
      longitude: coastLon + (15 * lngPerNm)
    };
  }

  return point;
}

function minOffshoreNmForSpecies(species: string) {
  const normalized = species.trim().toLowerCase();
  return SPECIES_MIN_OFFSHORE_NM[normalized] ?? 12;
}

function offshoreDistanceFromAtlanticCoastNm(point: GeoPoint): number | null {
  const minLon = atlanticCoastMinLon(point.latitude);
  if (minLon === null) {
    return null;
  }

  const lngPerNm = 1 / (60 * Math.max(0.1, Math.cos((point.latitude * Math.PI) / 180)));
  return Math.max(0, (point.longitude - minLon) / lngPerNm);
}

function enforceSpeciesOffshoreBuffer(point: GeoPoint, species: string, anchors: Array<{ latitude: number; longitude: number }>) {
  const pushed = pushPointOffshore(point, anchors);
  const requiredNm = minOffshoreNmForSpecies(species);
  const offshoreNm = offshoreDistanceFromAtlanticCoastNm(pushed);

  if (offshoreNm === null || offshoreNm >= requiredNm) {
    return pushed;
  }

  const coastLon = atlanticCoastMinLon(pushed.latitude);
  if (coastLon === null) {
    return pushed;
  }

  const lngPerNm = 1 / (60 * Math.max(0.1, Math.cos((pushed.latitude * Math.PI) / 180)));
  return {
    latitude: pushed.latitude,
    longitude: coastLon + (requiredNm * lngPerNm)
  };
}

function buildMarineFronts(centerLat: number, centerLng: number, species: string) {
  const speciesIndex = pelagicSpecies.indexOf(species) >= 0 ? pelagicSpecies.indexOf(species) : 0;

  const makeRing = (radiusNm: number, amplitude: number, phase: number, skew: number, rotation: number) => {
    const points: [number, number][] = [];
    const steps = 30;

    for (let index = 0; index <= steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2 + rotation;
      const radialWave = amplitude * Math.sin(angle * 2.5 + phase) + (amplitude * 0.55 * Math.cos(angle * 1.6 + phase * 0.7));
      const latOffset = (Math.cos(angle) * (radiusNm + radialWave)) / 60;
      const lngOffset = (Math.sin(angle) * (radiusNm * skew + radialWave * 0.85)) / 60;
      points.push([centerLat + latOffset, centerLng + lngOffset] as [number, number]);
    }

    return points;
  };

  return [
    {
      id: "sst-front",
      label: "SST front",
      color: "#ffb45c",
      points: makeRing(16 + speciesIndex * 1.4, 2.8, 0.8, 1.15, 0.25),
      weight: 3,
      opacity: 0.9,
      dashArray: ""
    },
    {
      id: "chl-front",
      label: "Plankton front",
      color: "#82ffb3",
      points: makeRing(18 + speciesIndex * 1.2, 3.3, 1.8, 1.32, 1.2),
      weight: 2.5,
      opacity: 0.8,
      dashArray: "8 8"
    },
    {
      id: "eddy-shoulder",
      label: "Eddy / convergence",
      color: "#7bd6ff",
      points: makeRing(22 + speciesIndex * 1.5, 4.4, 2.8, 1.45, 2.1),
      weight: 2,
      opacity: 0.72,
      dashArray: "3 7"
    }
  ];
}

type FishingMapPrefs = {
  mapDateFilter: "all" | "7d" | "30d" | "90d";
  viewMode: FishingMapViewMode;
  basemap: FishingBasemap;
  overlayOpacity: number;
  overlays: Record<OceanOverlayId, boolean>;
};

function BrandGlyph({ logoPath, className }: { logoPath: string; className: string }) {
  return <img src={assetUrl(logoPath)} alt="" className={className} loading="lazy" decoding="async" />;
}

function FishingMapViewport({ points, currentPosition }: { points: FishingMapPoint[]; currentPosition: { latitude: number; longitude: number } | null }) {
  const map = useMap();
  const hasInitializedRef = useRef(false);
  const userMovedRef = useRef(false);
  const lastCenteredPositionRef = useRef<{ latitude: number; longitude: number } | null>(null);

  useMapEvents({
    dragstart: () => {
      userMovedRef.current = true;
    },
    zoomstart: () => {
      userMovedRef.current = true;
    }
  });

  useEffect(() => {
    if (currentPosition) {
      const last = lastCenteredPositionRef.current;
      const movedEnough = !last || Math.hypot(last.latitude - currentPosition.latitude, last.longitude - currentPosition.longitude) >= 0.0012;
      const shouldCenterOnVessel = !hasInitializedRef.current || (!userMovedRef.current && movedEnough);

      if (shouldCenterOnVessel) {
        map.setView([currentPosition.latitude, currentPosition.longitude], 8, { animate: false });
        hasInitializedRef.current = true;
        lastCenteredPositionRef.current = { latitude: currentPosition.latitude, longitude: currentPosition.longitude };
      }

      return;
    }

    if (hasInitializedRef.current || userMovedRef.current) {
      return;
    }

    if (points.length === 0) {
      return;
    }

    if (points.length === 1) {
      const singlePoint = points[0];
      if (!singlePoint) {
        return;
      }

      map.setView([singlePoint.mapLatitude, singlePoint.mapLongitude], 8, { animate: false });
      hasInitializedRef.current = true;
      return;
    }

    const latitudes = points.map((point) => point.mapLatitude);
    const longitudes = points.map((point) => point.mapLongitude);
    const minLat = Math.min(...latitudes) - 0.15;
    const maxLat = Math.max(...latitudes) + 0.15;
    const minLng = Math.min(...longitudes) - 0.15;
    const maxLng = Math.max(...longitudes) + 0.15;

    map.fitBounds([[minLat, minLng], [maxLat, maxLng]], {
      animate: false,
      padding: [24, 24]
    });
    hasInitializedRef.current = true;
  }, [currentPosition, map, points]);

  return null;
}

function FishingIntelViewport({ circles, currentPosition }: { circles: FishMappingCircle[]; currentPosition: { latitude: number; longitude: number } | null }) {
  const map = useMap();
  const hasFittedRef = useRef(false);
  const lastCountRef = useRef(0);
  const userMovedRef = useRef(false);

  useMapEvents({
    dragstart: () => {
      userMovedRef.current = true;
    },
    zoomstart: () => {
      userMovedRef.current = true;
    }
  });

  useEffect(() => {
    if (currentPosition) {
      return;
    }

    if (circles.length === 0) {
      lastCountRef.current = 0;
      return;
    }

    const shouldFit = !hasFittedRef.current
      || (!userMovedRef.current && circles.length > lastCountRef.current);
    if (!shouldFit) {
      return;
    }

    hasFittedRef.current = true;
    lastCountRef.current = circles.length;
    const lats = circles.map((c) => c.latitude);
    const lngs = circles.map((c) => c.longitude);
    const pad = 0.8;
    map.fitBounds(
      [[Math.min(...lats) - pad, Math.min(...lngs) - pad], [Math.max(...lats) + pad, Math.max(...lngs) + pad]],
      { animate: true, padding: [48, 48], maxZoom: 10 }
    );
  }, [circles, currentPosition, map]);

  return null;
}

function clusterFishingPoints(points: FishingMapPoint[], zoom: number): FishingMapCluster[] {
  const bucketSize = zoom <= 5 ? 1.2 : zoom <= 7 ? 0.55 : zoom <= 9 ? 0.22 : 0.11;
  const buckets = new Map<string, FishingMapPoint[]>();

  points.forEach((point) => {
    const latBucket = Math.floor(point.mapLatitude / bucketSize);
    const lngBucket = Math.floor(point.mapLongitude / bucketSize);
    const key = `${latBucket}:${lngBucket}`;
    const existing = buckets.get(key) ?? [];
    existing.push(point);
    buckets.set(key, existing);
  });

  return Array.from(buckets.entries()).map(([id, bucket]) => {
    const latitude = bucket.reduce((sum, point) => sum + point.mapLatitude, 0) / bucket.length;
    const longitude = bucket.reduce((sum, point) => sum + point.mapLongitude, 0) / bucket.length;

    return {
      id,
      mapLatitude: latitude,
      mapLongitude: longitude,
      points: bucket
    };
  });
}

function FishingMapLayer({ points, viewMode }: { points: FishingMapPoint[]; viewMode: FishingMapViewMode }) {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());
  const [bounds, setBounds] = useState(() => map.getBounds());

  useMapEvents({
    zoomend: () => {
      setZoom(map.getZoom());
      setBounds(map.getBounds());
    },
    moveend: () => {
      setBounds(map.getBounds());
    }
  });

  const visiblePoints = useMemo(() => {
    return points.filter((point) => bounds.contains([point.mapLatitude, point.mapLongitude]));
  }, [bounds, points]);

  const clusters = useMemo(() => clusterFishingPoints(visiblePoints, zoom), [visiblePoints, zoom]);

  if (viewMode === "heatmap") {
    return (
      <>
        {visiblePoints.map((point) => (
          <Circle
            key={`heat-${point.id}`}
            center={[point.mapLatitude, point.mapLongitude]}
            radius={5400}
            pathOptions={{
              color: "transparent",
              fillColor: point.color,
              fillOpacity: 0.18
            }}
          />
        ))}
        {visiblePoints.map((point) => (
          <CircleMarker
            key={`heat-center-${point.id}`}
            center={[point.mapLatitude, point.mapLongitude]}
            radius={3.5}
            pathOptions={{
              color: "rgba(255, 255, 255, 0.7)",
              weight: 1,
              fillColor: point.color,
              fillOpacity: 0.92
            }}
          >
            <Popup>
              <div className="fishing-map-popup">
                <strong>{point.species}</strong>
                <span>{point.lureName}</span>
                {point.fishSizeInches ? <span>{point.fishSizeInches.toFixed(1)} in</span> : null}
                <span>{point.locationLabel}</span>
                <small>{new Date(point.timestamp).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</small>
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </>
    );
  }

  if (viewMode === "points") {
    return (
      <>
        {visiblePoints.map((point) => (
          <CircleMarker
            key={point.id}
            center={[point.mapLatitude, point.mapLongitude]}
            radius={7}
            pathOptions={{
              color: "rgba(255, 255, 255, 0.85)",
              weight: 1,
              fillColor: point.color,
              fillOpacity: 0.88
            }}
          >
            <Popup>
              <div className="fishing-map-popup">
                <strong>{point.species}</strong>
                <span>{point.lureName}</span>
                {point.fishSizeInches ? <span>{point.fishSizeInches.toFixed(1)} in</span> : null}
                <span>{point.locationLabel}</span>
                <small>{new Date(point.timestamp).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</small>
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </>
    );
  }

  return (
    <>
      {clusters.map((cluster) => {
        if (cluster.points.length === 1) {
          const point = cluster.points[0];
          if (!point) {
            return null;
          }

          return (
            <CircleMarker
              key={point.id}
              center={[point.mapLatitude, point.mapLongitude]}
              radius={7}
              pathOptions={{
                color: "rgba(255, 255, 255, 0.85)",
                weight: 1,
                fillColor: point.color,
                fillOpacity: 0.88
              }}
            >
              <Popup>
                <div className="fishing-map-popup">
                  <strong>{point.species}</strong>
                  <span>{point.lureName}</span>
                  {point.fishSizeInches ? <span>{point.fishSizeInches.toFixed(1)} in</span> : null}
                  <span>{point.locationLabel}</span>
                  <small>{new Date(point.timestamp).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</small>
                </div>
              </Popup>
            </CircleMarker>
          );
        }

        const radius = Math.min(20, 8 + Math.log2(cluster.points.length) * 4);
        const speciesCounts = new Map<string, number>();
        cluster.points.forEach((point) => {
          speciesCounts.set(point.species, (speciesCounts.get(point.species) ?? 0) + 1);
        });
        const dominantSpecies = [...speciesCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Mixed";

        return (
          <CircleMarker
            key={`cluster-${cluster.id}`}
            center={[cluster.mapLatitude, cluster.mapLongitude]}
            radius={radius}
            pathOptions={{
              color: "rgba(0, 18, 26, 0.95)",
              weight: 2,
              fillColor: "#00c0c0",
              fillOpacity: 0.82
            }}
          >
            <Popup>
              <div className="fishing-map-popup">
                <strong>{cluster.points.length} catches in this pocket</strong>
                <span>Dominant: {dominantSpecies}</span>
                <small>{cluster.points.slice(0, 4).map((point) => point.lureName).join(", ")}</small>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}
    </>
  );
}

function FishingMapBoundsReporter({
  onBoundsChange
}: {
  onBoundsChange: (bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }) => void;
}) {
  const map = useMapEvents({
    moveend: () => {
      const bounds = map.getBounds();
      onBoundsChange({
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast()
      });
    },
    zoomend: () => {
      const bounds = map.getBounds();
      onBoundsChange({
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast()
      });
    }
  });

  useEffect(() => {
    const bounds = map.getBounds();
    onBoundsChange({
      minLat: bounds.getSouth(),
      maxLat: bounds.getNorth(),
      minLng: bounds.getWest(),
      maxLng: bounds.getEast()
    });
  }, [map, onBoundsChange]);

  return null;
}

function FishingMapZoomReporter({
  onZoomChange
}: {
  onZoomChange: (zoom: number) => void;
}) {
  const map = useMapEvents({
    zoomend: () => {
      onZoomChange(map.getZoom());
    }
  });

  useEffect(() => {
    onZoomChange(map.getZoom());
  }, [map, onZoomChange]);

  return null;
}

function MapCenterReporter({
  onCenterChange
}: {
  onCenterChange: (center: [number, number]) => void;
}) {
  const map = useMapEvents({
    moveend: () => {
      const center = map.getCenter();
      onCenterChange([center.lat, center.lng]);
    },
    zoomend: () => {
      const center = map.getCenter();
      onCenterChange([center.lat, center.lng]);
    }
  });

  useEffect(() => {
    const center = map.getCenter();
    onCenterChange([center.lat, center.lng]);
  }, [map, onCenterChange]);

  return null;
}

function HomePortConfigMapInteractions({
  onPick,
  onCenterChange
}: {
  onPick: (position: { latitude: number; longitude: number }) => void;
  onCenterChange: (center: [number, number]) => void;
}) {
  const map = useMapEvents({
    click: (event) => {
      onPick({ latitude: event.latlng.lat, longitude: event.latlng.lng });
    },
    moveend: () => {
      const center = map.getCenter();
      onCenterChange([center.lat, center.lng]);
    },
    zoomend: () => {
      const center = map.getCenter();
      onCenterChange([center.lat, center.lng]);
    }
  });

  useEffect(() => {
    const center = map.getCenter();
    onCenterChange([center.lat, center.lng]);
  }, [map, onCenterChange]);

  return null;
}

function FishingMapRuntimeGuard() {
  const map = useMap();

  useEffect(() => {
    let cancelled = false;

    const settle = () => {
      map.invalidateSize(false);
    };

    const timers = [80, 240, 640, 1400, 2600, 4200].map((delay) => window.setTimeout(() => {
      if (!cancelled) {
        settle();
      }
    }, delay));

    map.whenReady(() => {
      if (!cancelled) {
        settle();
      }
    });

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [map]);

  return null;
}

function WeatherRadarRuntimeGuard({ center }: { center: [number, number] }) {
  const map = useMap();
  const hasInitializedRef = useRef(false);
  const userMovedRef = useRef(false);

  useMapEvents({
    dragstart: () => {
      userMovedRef.current = true;
    },
    zoomstart: () => {
      userMovedRef.current = true;
    }
  });

  useEffect(() => {
    if (!hasInitializedRef.current) {
      map.setView(center, map.getZoom(), { animate: false });
      hasInitializedRef.current = true;
    } else if (!userMovedRef.current) {
      const current = map.getCenter();
      const movedEnough = Math.hypot(current.lat - center[0], current.lng - center[1]) >= 0.002;
      if (movedEnough) {
        map.setView(center, map.getZoom(), { animate: false });
      }
    }

    map.invalidateSize(false);
  }, [center, map]);

  useEffect(() => {
    let cancelled = false;
    const settle = () => {
      if (!cancelled) {
        map.invalidateSize(false);
      }
    };

    const timers = [90, 260, 700, 1500].map((delay) => window.setTimeout(settle, delay));
    const onResize = () => settle();
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", onResize);
    };
  }, [map]);

  return null;
}

function TripRouteViewport({
  routePoints,
  currentPosition
}: {
  routePoints: [number, number][];
  currentPosition: { latitude: number; longitude: number } | null;
}) {
  const map = useMap();
  const hasInitializedRef = useRef(false);
  const userMovedRef = useRef(false);

  useMapEvents({
    dragstart: () => {
      userMovedRef.current = true;
    },
    zoomstart: () => {
      userMovedRef.current = true;
    }
  });

  useEffect(() => {
    if (userMovedRef.current) {
      return;
    }

    if (routePoints.length > 1) {
      const latitudes = routePoints.map((point) => point[0]);
      const longitudes = routePoints.map((point) => point[1]);
      map.fitBounds(
        [[Math.min(...latitudes), Math.min(...longitudes)], [Math.max(...latitudes), Math.max(...longitudes)]],
        { animate: false, padding: [28, 28], maxZoom: 14 }
      );
      hasInitializedRef.current = true;
      return;
    }

    if (routePoints.length === 1) {
      const point = routePoints[0];
      if (point) {
        map.setView(point, 11, { animate: false });
        hasInitializedRef.current = true;
      }
      return;
    }

    if (currentPosition && !hasInitializedRef.current) {
      map.setView([currentPosition.latitude, currentPosition.longitude], 8, { animate: false });
      hasInitializedRef.current = true;
    }
  }, [currentPosition, map, routePoints]);

  return null;
}

function buildOceanOverlayUrl(source: OceanTileOverlayId, date: string) {
  return `/api/ocean/tiles/${source}/{z}/{x}/{y}.png?date=${encodeURIComponent(date)}`;
}

function readFishingMapPrefs(): FishingMapPrefs {
  const defaults: FishingMapPrefs = {
    mapDateFilter: "7d",
    viewMode: "clusters",
    basemap: "nautical",
    overlayOpacity: 34,
    overlays: {
      sst: false,
      chlorophyll: false,
      currents: false,
      contours: true,
      fronts: false
    }
  };

  const raw = window.localStorage.getItem(FISHING_MAP_PREFS_STORAGE_KEY);
  if (!raw) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<FishingMapPrefs>;
    const parsedOverlays = {
      sst: typeof parsed.overlays?.sst === "boolean" ? parsed.overlays.sst : defaults.overlays.sst,
      chlorophyll: false,
      currents: typeof parsed.overlays?.currents === "boolean" ? parsed.overlays.currents : defaults.overlays.currents,
      contours: typeof parsed.overlays?.contours === "boolean" ? parsed.overlays.contours : defaults.overlays.contours,
      fronts: typeof parsed.overlays?.fronts === "boolean" ? parsed.overlays.fronts : defaults.overlays.fronts
    };

    const enabledCount = [
      parsedOverlays.sst,
      parsedOverlays.chlorophyll,
      parsedOverlays.currents,
      parsedOverlays.contours,
      parsedOverlays.fronts
    ].filter(Boolean).length;

    const useCleanedOverlays = enabledCount >= 4;
    const isLegacyGrainyBlend = parsedOverlays.sst
      && parsedOverlays.contours
      && !parsedOverlays.chlorophyll
      && !parsedOverlays.currents
      && !parsedOverlays.fronts
      && typeof parsed.overlayOpacity === "number"
      && parsed.overlayOpacity >= 30;
    const normalizedOverlays = useCleanedOverlays || isLegacyGrainyBlend
      ? defaults.overlays
      : parsedOverlays;

    return {
      mapDateFilter: parsed.mapDateFilter === "all" || parsed.mapDateFilter === "7d" || parsed.mapDateFilter === "30d" || parsed.mapDateFilter === "90d"
        ? parsed.mapDateFilter
        : defaults.mapDateFilter,
      viewMode: parsed.viewMode === "clusters" || parsed.viewMode === "heatmap" || parsed.viewMode === "points"
        ? parsed.viewMode
        : defaults.viewMode,
      basemap: parsed.basemap === "nautical" || parsed.basemap === "standard" || parsed.basemap === "satellite"
        ? parsed.basemap
        : defaults.basemap,
      overlayOpacity: typeof parsed.overlayOpacity === "number" && parsed.overlayOpacity >= 15 && parsed.overlayOpacity <= 95
        ? ((useCleanedOverlays || isLegacyGrainyBlend) ? Math.min(parsed.overlayOpacity, 34) : parsed.overlayOpacity)
        : defaults.overlayOpacity,
      overlays: normalizedOverlays
    };
  } catch {
    return defaults;
  }
}

function buoyTempColor(waterTempC: number | null) {
  if (waterTempC === null) {
    return "#9fb7ca";
  }

  const waterTempF = (waterTempC * 9 / 5) + 32;
  if (waterTempF < 65) {
    return "#52a5ff";
  }

  if (waterTempF < 73) {
    return "#00c0c0";
  }

  if (waterTempF < 79) {
    return "#6ad8a2";
  }

  if (waterTempF < 84) {
    return "#e0b060";
  }

  return "#ff8f70";
}

function dateWindowMsForFilter(filter: "all" | "7d" | "30d" | "90d") {
  return {
    all: Number.POSITIVE_INFINITY,
    "7d": 1000 * 60 * 60 * 24 * 7,
    "30d": 1000 * 60 * 60 * 24 * 30,
    "90d": 1000 * 60 * 60 * 24 * 90
  }[filter];
}

function readFishingCatches(): FishingCatch[] {
  const stored = window.localStorage.getItem(FISHING_LOG_STORAGE_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as FishingCatch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readHomeTileLayout(): HomeTileId[] {
  const stored = window.localStorage.getItem(HOME_TILE_LAYOUT_STORAGE_KEY);
  if (!stored) {
    return DEFAULT_HOME_TILE_LAYOUT;
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== DEFAULT_HOME_TILE_LAYOUT.length) {
      return DEFAULT_HOME_TILE_LAYOUT;
    }

    const normalized = parsed.every((id) => typeof id === "string" && HOME_TILE_IDS.includes(id as HomeTileId));
    if (!normalized) {
      return DEFAULT_HOME_TILE_LAYOUT;
    }

    return parsed as HomeTileId[];
  } catch {
    return DEFAULT_HOME_TILE_LAYOUT;
  }
}

function readCustomBaitPresets(): BaitPreset[] {
  const stored = window.localStorage.getItem(CUSTOM_BAIT_PRESETS_STORAGE_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const validTypes = BAIT_TYPE_FILTERS.filter((value) => value !== "All types");
    const validColors = BAIT_COLOR_FILTERS.filter((value) => value !== "All colors");

    return parsed
      .filter((item): item is { id: string; name: string; type: string; color: string; profile: string } => {
        if (!item || typeof item !== "object") {
          return false;
        }

        const candidate = item as Record<string, unknown>;
        return typeof candidate.id === "string"
          && typeof candidate.name === "string"
          && typeof candidate.type === "string"
          && typeof candidate.color === "string"
          && typeof candidate.profile === "string";
      })
      .filter((item) => validTypes.includes(item.type as BaitType) && validColors.includes(item.color as BaitColor))
      .map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type as BaitType,
        color: item.color as BaitColor,
        profile: item.profile,
        custom: true
      }));
  } catch {
    return [];
  }
}

const navItems = [
  { id: "home", label: "Home", detail: "Overview" },
  { id: "streaming", label: "Video", detail: "Video apps" },
  { id: "music", label: "Music", detail: "Audio apps" },
  { id: "camera", label: "Night Vision", detail: "Live feed" },
  { id: "weather", label: "Weather", detail: "Forecasts" },
  { id: "fishing", label: "Fishing", detail: "Logs and intel" },
  { id: "vessel", label: "Vessel", detail: "Engines and status" },
  { id: "trips", label: "Trips", detail: "Tracks and summaries" },
  { id: "more", label: "Settings", detail: "System, audio, updates" }
];

const streamingTargets: LaunchTarget[] = [
  {
    id: "youtube",
    name: "YouTube",
    subtitle: "Lean-back feed, live channels, and boat-night playback.",
    launchUrl: "https://www.youtube.com/tv",
    launchLabel: "YouTube",
    accent: "aqua",
    tileClass: "stream-app-tile--youtube",
    logoPath: "/logos/youtube.svg"
  },
  {
    id: "youtube-tv",
    name: "YouTube TV",
    subtitle: "Sports, news, and live TV in a kiosk-style view.",
    launchUrl: "https://tv.youtube.com/",
    launchLabel: "YouTube TV",
    accent: "gold",
    tileClass: "stream-app-tile--youtube-tv",
    logoPath: "/logos/youtube-tv.svg"
  },
  {
    id: "netflix",
    name: "Netflix",
    subtitle: "Streaming entertainment and movie night while at anchor.",
    launchUrl: "https://www.netflix.com/login",
    launchLabel: "Netflix",
    accent: "aqua",
    tileClass: "stream-app-tile--netflix",
    logoPath: "/logos/netflix.svg"
  },
  {
    id: "browser",
    name: "Firefox",
    subtitle: "Open a general web browser for weather, marina sites, and quick browsing.",
    launchUrl: "https://www.google.com",
    launchLabel: "Firefox",
    accent: "gold",
    tileClass: "stream-app-tile--browser",
    logoPath: "/logos/firefox.svg"
  },
  {
    id: "paramount",
    name: "Paramount+",
    subtitle: "Sports, shows, and live entertainment on the bridge display.",
    launchUrl: "https://www.paramountplus.com",
    launchLabel: "Paramount+",
    accent: "gold",
    tileClass: "stream-app-tile--paramount",
    logoPath: "/logos/paramount.svg"
  },
  {
    id: "peacock",
    name: "Peacock",
    subtitle: "News, live events, and on-demand entertainment while the crew is underway.",
    launchUrl: "https://www.peacocktv.com",
    launchLabel: "Peacock",
    accent: "aqua",
    tileClass: "stream-app-tile--peacock",
    logoPath: "/logos/peacock.svg"
  },
  {
    id: "disney",
    name: "Disney+",
    subtitle: "Family viewing and back-to-back streaming for downtime between runs.",
    launchUrl: "https://www.disneyplus.com",
    launchLabel: "Disney+",
    accent: "gold",
    tileClass: "stream-app-tile--disney",
    logoPath: "/logos/disney.svg"
  }
];

const musicTargets: LaunchTarget[] = [
  {
    id: "spotify",
    name: "Spotify",
    subtitle: "Music, playlists, and background audio for the helm.",
    launchUrl: "https://open.spotify.com",
    launchLabel: "Spotify",
    logoPath: "/logos/spotify.svg"
  },
  {
    id: "siriusxm",
    name: "SiriusXM",
    subtitle: "Live channels, talk, sports, and audio coverage on the water.",
    launchUrl: "https://www.siriusxm.com/",
    launchLabel: "SiriusXM",
    logoPath: "/logos/siriusxm.svg"
  },
  {
    id: "pandora",
    name: "Pandora",
    subtitle: "Radio stations and curated playlists for a relaxed dockside vibe.",
    launchUrl: "https://www.pandora.com/",
    launchLabel: "Pandora",
    logoPath: "/logos/pandora.svg"
  }
];

function findLaunchTargetById(appId: string): LaunchTarget | null {
  const normalized = appId.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return [...streamingTargets, ...musicTargets].find((target) => target.id === normalized) ?? null;
}

function formatSystemClock(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(new Date(iso));
}

function parseFirstNumber(value: string): number | null {
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultLauncherState(): LauncherState {
  return {
    appId: "",
    name: "",
    subtitle: "",
    runtime: "Bridge",
    status: "Idle",
    message: "No app launched yet.",
    launchMethod: "App bridge",
    startedAt: new Date().toISOString()
  };
}

function defaultRemoteAccessStatus(): RemoteAccessStatus {
  return {
    mode: "tailscale",
    label: "Remote tunnel",
    viewUrl: "",
    troubleshootUrl: "",
    status: "Unknown",
    connected: false,
    configured: false,
    lastCheckedAt: new Date().toISOString(),
    lastAction: "Idle",
    lastOutput: null,
    commands: {
      statusConfigured: false,
      startConfigured: false,
      stopConfigured: false,
      restartConfigured: false
    },
    notes: "Remote access status not loaded yet."
  };
}

function defaultRemoteUpdateStatus(): RemoteUpdateStatus {
  return {
    configured: false,
    running: false,
    command: "",
    lastRunAt: null,
    lastFinishedAt: null,
    lastSuccess: null,
    lastOutput: null,
    lastError: null,
    notes: "Remote update status not loaded yet."
  };
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return "Not available";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function geoDistanceNm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 0.539957;
}

function geoBearingLabel(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = Math.PI / 180;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  const deg = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16] ?? "?";
}

function interpolatePoint(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + ((b[0] - a[0]) * t), a[1] + ((b[1] - a[1]) * t)];
}

function offsetPointByNm(point: [number, number], eastNm: number, northNm: number): [number, number] {
  const lat = point[0];
  const latOffset = northNm / 60;
  const lngOffset = eastNm / (60 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lat + latOffset, point[1] + lngOffset];
}

function directionAngleRad(a: [number, number], b: [number, number]) {
  const avgLat = (a[0] + b[0]) / 2;
  const east = (b[1] - a[1]) * Math.max(0.1, Math.cos((avgLat * Math.PI) / 180));
  const north = b[0] - a[0];
  return Math.atan2(north, east);
}

export function App() {
  const initialFishingMapPrefs = readFishingMapPrefs();
  const remoteMode = isRemoteModeUrl();
  const remoteAccessUrl = typeof window === "undefined" ? REMOTE_ACCESS_PATH : `${window.location.origin}${REMOTE_ACCESS_PATH}`;
  const signalKAdminUrl = typeof window === "undefined" ? "/admin/#/dashboard" : `${window.location.origin}/admin/#/dashboard`;
  const compactSettingsTabStyle = {
    minHeight: "30px",
    padding: "4px 8px",
    fontSize: "0.72rem",
    letterSpacing: "0.05em"
  };
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [online, setOnline] = useState(true);
  const [selectedAppId, setSelectedAppId] = useState("streaming");
  const [selectedStreamId, setSelectedStreamId] = useState("youtube");
  const [selectedMusicId, setSelectedMusicId] = useState("spotify");
  const [nowLabel, setNowLabel] = useState("Loading clock...");
  const [bluetoothState, setBluetoothState] = useState<BluetoothState>({
    status: "Bluetooth not configured",
    device: "Vessel stereo",
    audioRoute: "Auto reconnect enabled",
    connected: false,
    ready: false,
    config: {
      pairConfigured: false,
      reconnectConfigured: false,
      routeConfigured: false,
      disconnectConfigured: false,
      statusConfigured: false,
      missingCommands: [
        "PALMER_LOU_BT_PAIR_COMMAND",
        "PALMER_LOU_BT_RECONNECT_COMMAND",
        "PALMER_LOU_BT_ROUTE_COMMAND",
        "PALMER_LOU_BT_DISCONNECT_COMMAND",
        "PALMER_LOU_BT_STATUS_COMMAND"
      ]
    },
    lastAction: "Idle",
    updatedAt: new Date().toISOString(),
    lastError: "Bluetooth commands are not fully configured"
  });
  const [launcherState, setLauncherState] = useState<LauncherState>(() => defaultLauncherState());
  const [launching, setLaunching] = useState(false);
  const [killingLaunchedApp, setKillingLaunchedApp] = useState(false);
  const [restoringLaunchedApp, setRestoringLaunchedApp] = useState(false);
  const [lastRestorableAppId, setLastRestorableAppId] = useState("");
  const [showRuntimePanel, setShowRuntimePanel] = useState(false);
  const [selectedNavId, setSelectedNavId] = useState("home");
  const lastTouchNavSelectionRef = useRef<{ id: string; at: number } | null>(null);
  const [settingsSubview, setSettingsSubview] = useState<SettingsSubview>("wifi");
  const [fishingSubview, setFishingSubview] = useState<FishingSubview>("map");
  const [fishingMapMode, setFishingMapMode] = useState<FishingMapMode>("navigate");
  const [fishingCatches, setFishingCatches] = useState<FishingCatch[]>(() => readFishingCatches());
  const [quickSpecies, setQuickSpecies] = useState("Yellowfin");
  const [selectedBaitTypeFilter, setSelectedBaitTypeFilter] = useState<(typeof BAIT_TYPE_FILTERS)[number]>("All types");
  const [selectedBaitColorFilter, setSelectedBaitColorFilter] = useState<(typeof BAIT_COLOR_FILTERS)[number]>("All colors");
  const [selectedBaitId, setSelectedBaitId] = useState(BAIT_PRESETS[0]?.id ?? "live-menhaden");
  const [customBaitPresets, setCustomBaitPresets] = useState<BaitPreset[]>(() => readCustomBaitPresets());
  const [vesselPosition, setVesselPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  const [browserGeoLocation, setBrowserGeoLocation] = useState<[number, number] | null>(null);
  const [lastKnownVesselPosition, setLastKnownVesselPosition] = useState<{ latitude: number; longitude: number } | null>(() => readLastVesselPosition());
  const [customBaitName, setCustomBaitName] = useState("");
  const [customBaitType, setCustomBaitType] = useState<BaitType>("Live bait");
  const [customBaitColor, setCustomBaitColor] = useState<BaitColor>("Natural");
  const [customBaitProfile, setCustomBaitProfile] = useState("");
  const [quickLureType, setQuickLureType] = useState<BaitType>("Live bait");
  const [quickLureColor, setQuickLureColor] = useState<BaitColor>("Natural");
  const [quickFishSizeInches, setQuickFishSizeInches] = useState("");
  const [catchLocation, setCatchLocation] = useState({ latitude: null as number | null, longitude: null as number | null, label: "GPS not locked" });
  const [loggingCatch, setLoggingCatch] = useState(false);
  const [fishingMapSpeciesFilter, setFishingMapSpeciesFilter] = useState("All fish");
  const [fishingMapLureFilter, setFishingMapLureFilter] = useState("All lures");
  const [fishingMapDateFilter, setFishingMapDateFilter] = useState<"all" | "7d" | "30d" | "90d">(initialFishingMapPrefs.mapDateFilter);
  const [fishingMapViewMode, setFishingMapViewMode] = useState<FishingMapViewMode>(initialFishingMapPrefs.viewMode);
  const [fishingBasemap, setFishingBasemap] = useState<FishingBasemap>(initialFishingMapPrefs.basemap);
  const [fishingMapOverlayOpacity, setFishingMapOverlayOpacity] = useState(initialFishingMapPrefs.overlayOpacity);
  const [enabledOceanOverlays, setEnabledOceanOverlays] = useState<Record<OceanOverlayId, boolean>>(initialFishingMapPrefs.overlays);
  const [showSpeciesHotspots, setShowSpeciesHotspots] = useState(false);
  const [selectedFishCircleId, setSelectedFishCircleId] = useState<string | null>(null);
  const [fishingMapBounds, setFishingMapBounds] = useState<{ minLat: number; maxLat: number; minLng: number; maxLng: number } | null>(null);
  const [showFishingMapSettings, setShowFishingMapSettings] = useState(false);
  const [fishingMapFullscreen, setFishingMapFullscreen] = useState(false);
  const [fishingMapRenderNonce, setFishingMapRenderNonce] = useState(0);
  const [fishingMapZoom, setFishingMapZoom] = useState(7);
  const [speciesVisibility, setSpeciesVisibility] = useState<Record<string, boolean>>(() => {
    const defaults: Record<string, boolean> = {};
    pelagicSpecies.forEach((species) => {
      defaults[species] = true;
    });
    return defaults;
  });
  const [oceanBuoys, setOceanBuoys] = useState<OceanBuoyObservation[]>([]);
  const [loadingOceanBuoys, setLoadingOceanBuoys] = useState(false);
  const [oceanCurrentVectors, setOceanCurrentVectors] = useState<OceanCurrentVector[]>(() => readCachedOceanCurrentVectors());
  const [loadingOceanCurrentVectors, setLoadingOceanCurrentVectors] = useState(false);
  const [weatherRadarFullscreen, setWeatherRadarFullscreen] = useState(false);
  const [stormRadarTileUrl, setStormRadarTileUrl] = useState<string | null>(null);
  const [stormRadarPreviousTileUrl, setStormRadarPreviousTileUrl] = useState<string | null>(null);
  const [stormRadarTimeline, setStormRadarTimeline] = useState<Array<{
    kind: "past" | "nowcast" | "future";
    observedAt: string | null;
    tileUrlTemplate: string;
  }>>([]);
  const [stormRadarPlaybackIndex, setStormRadarPlaybackIndex] = useState(0);
  const [stormRadarPlaying, setStormRadarPlaying] = useState(false);
  const [weatherMapRenderNonce, setWeatherMapRenderNonce] = useState(0);
  const [tripMapRenderNonce, setTripMapRenderNonce] = useState(0);
  const [weatherMapCenter, setWeatherMapCenter] = useState<[number, number] | null>(null);
  const [tripMapCenter, setTripMapCenter] = useState<[number, number] | null>(null);
  const [stormRadarFrameLabel, setStormRadarFrameLabel] = useState<string | null>(null);
  const [loadingStormRadar, setLoadingStormRadar] = useState(false);
  const [mapHeadingMode, setMapHeadingMode] = useState<MapHeadingMode>("north");
  const [tripMapFollowRecent, setTripMapFollowRecent] = useState(false);
  const [signalKForecastCards, setSignalKForecastCards] = useState<WeatherForecastCard[] | null>(null);
  const [signalKForecastSource, setSignalKForecastSource] = useState<string | null>(null);
  const [lastTripSyncAt, setLastTripSyncAt] = useState<string | null>(null);
  const [speciesIntel, setSpeciesIntel] = useState<AllSpeciesIntelResponse | null>(null);
  const [loadingSpeciesIntel, setLoadingSpeciesIntel] = useState(false);
  const [expandedSpeciesIntel, setExpandedSpeciesIntel] = useState<string | null>(null);
  const [advisorSpecies, setAdvisorSpecies] = useState("Auto (map species)");
  const [fishingAdvisor, setFishingAdvisor] = useState<FishingAdvisorResponse | null>(null);
  const [runningFishingAdvisor, setRunningFishingAdvisor] = useState(false);
  const [fishingAdvisorError, setFishingAdvisorError] = useState<string | null>(null);
  const [bluetoothDiagnostics, setBluetoothDiagnostics] = useState<BluetoothDiagnostics | null>(null);
  const [runningBluetoothDiagnostics, setRunningBluetoothDiagnostics] = useState(false);
  const [btScanResults, setBtScanResults] = useState<Array<{ mac: string; name: string }>>([]);
  const [btScanning, setBtScanning] = useState(false);
  const [runningBtWorkflowId, setRunningBtWorkflowId] = useState<string | null>(null);
  const [remoteAccessStatus, setRemoteAccessStatus] = useState<RemoteAccessStatus>(() => defaultRemoteAccessStatus());
  const [remoteUpdateStatus, setRemoteUpdateStatus] = useState<RemoteUpdateStatus>(() => defaultRemoteUpdateStatus());
  const [wifiNetworks, setWifiNetworks] = useState<WifiNetwork[]>([]);
  const [wifiScanning, setWifiScanning] = useState(false);
  const [wifiHasManualScan, setWifiHasManualScan] = useState(false);
  const [wifiJoining, setWifiJoining] = useState<string | null>(null);
  const [wifiDisconnecting, setWifiDisconnecting] = useState(false);
  const [wifiJoinDialog, setWifiJoinDialog] = useState<{ ssid: string; security: string } | null>(null);
  const [wifiJoinPassword, setWifiJoinPassword] = useState("");
  const [wifiStatus, setWifiStatus] = useState<string | null>(null);
  const [runningRemoteTunnelAction, setRunningRemoteTunnelAction] = useState<"start" | "stop" | "restart" | "status" | null>(null);
  const [runningRemoteUpdate, setRunningRemoteUpdate] = useState(false);
  const [remoteOpsError, setRemoteOpsError] = useState<string | null>(null);
  const [runningRemoteControlAction, setRunningRemoteControlAction] = useState<RemoteControlAction | null>(null);
  const [remoteControlStatus, setRemoteControlStatus] = useState("Remote controls ready");
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [keyboardShift, setKeyboardShift] = useState(false);
  const [remoteHapticsEnabled] = useState(() => readRemoteHapticsEnabled());
  const [trackpadSensitivity, setTrackpadSensitivity] = useState<TrackpadSensitivity>(() => readTrackpadSensitivity());
  const [trendBaseTime] = useState(() => Date.now());
  const [depthTempTrend, setDepthTempTrend] = useState<Array<{ timestamp: string; depthFeet: number | null; waterTempF: number | null }>>([]);
  const [homeTileLayout, setHomeTileLayout] = useState<HomeTileId[]>(() => readHomeTileLayout());
  const [editingHomeTiles, setEditingHomeTiles] = useState(false);
  const [tripHistory, setTripHistory] = useState<TripDescriptor[]>(() => readStoredTrips());
  const [tripSession, setTripSession] = useState<TripLog | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [homePortConfig, setHomePortConfig] = useState(() => readHomePortConfig());
  const [myVesselMapCenter, setMyVesselMapCenter] = useState<[number, number] | null>(null);
  const homePortPoint = useMemo(() => {
    if (typeof homePortConfig.latitude === "number"
      && typeof homePortConfig.longitude === "number"
      && Number.isFinite(homePortConfig.latitude)
      && Number.isFinite(homePortConfig.longitude)) {
      return {
        latitude: homePortConfig.latitude,
        longitude: homePortConfig.longitude
      };
    }

    return null;
  }, [homePortConfig.latitude, homePortConfig.longitude]);
  const homePortRadiusNm = Math.min(Math.max(homePortConfig.radiusNm, 0.05), 2.5);
  const homePortLabel = toHomePortLabel(homePortPoint);
  const [tripMapFullscreen, setTripMapFullscreen] = useState(false);
  const [tripControlMessage, setTripControlMessage] = useState<string | null>(null);
  const [vesselSubview, setVesselSubview] = useState<VesselSubview>("systems");
  const [bilgeBuddyFullscreen, setBilgeBuddyFullscreen] = useState(false);
  const activeTripRef = useRef<TripLog | null>(null);
  const stormRadarTileUrlRef = useRef<string | null>(null);
  const stormRadarPlayingRef = useRef(false);
  const stormRadarPlaybackIndexRef = useRef(0);
  const remoteControlQueueRef = useRef<Promise<void>>(Promise.resolve());
  const remoteHoldActionRef = useRef<RemoteControlAction | null>(null);
  const remoteHoldDelayTimerRef = useRef<number | null>(null);
  const remoteHoldIntervalTimerRef = useRef<number | null>(null);
  const trackpadPointerIdRef = useRef<number | null>(null);
  const trackpadLastPointRef = useRef<TrackpadPoint | null>(null);
  const trackpadAccumulatorRef = useRef<TrackpadPoint>({ x: 0, y: 0 });
  const trackpadGestureRef = useRef<{ startedAt: number; movedPx: number }>({ startedAt: 0, movedPx: 0 });
  const trackpadMoveQueueRef = useRef<TrackpadPoint>({ x: 0, y: 0 });
  const trackpadMoveSendingRef = useRef(false);
  const lastTripSampleRef = useRef<{ atMs: number; latitude: number; longitude: number } | null>(null);
  const activeSummary = summary ?? fallbackSummary;

  const vibrateRemote = (pattern: number | number[]) => {
    if (!remoteMode || !remoteHapticsEnabled || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      return;
    }

    navigator.vibrate(pattern);
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(REMOTE_HAPTICS_ENABLED_STORAGE_KEY, remoteHapticsEnabled ? "1" : "0");
  }, [remoteHapticsEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(REMOTE_TRACKPAD_SENSITIVITY_STORAGE_KEY, trackpadSensitivity);
  }, [trackpadSensitivity]);

  useEffect(() => {
    if (!vesselPosition || typeof window === "undefined") {
      return;
    }

    setLastKnownVesselPosition(vesselPosition);
    window.localStorage.setItem(LAST_VESSEL_POSITION_STORAGE_KEY, JSON.stringify({
      latitude: vesselPosition.latitude,
      longitude: vesselPosition.longitude,
      updatedAt: new Date().toISOString()
    }));
  }, [vesselPosition]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.documentElement.classList.toggle("remote-mode", remoteMode);
    document.body.classList.toggle("remote-mode", remoteMode);

    return () => {
      document.documentElement.classList.remove("remote-mode");
      document.body.classList.remove("remote-mode");
    };
  }, [remoteMode]);

  useEffect(() => {
    return () => {
      if (typeof window === "undefined") {
        return;
      }

      if (remoteHoldDelayTimerRef.current !== null) {
        window.clearTimeout(remoteHoldDelayTimerRef.current);
      }

      if (remoteHoldIntervalTimerRef.current !== null) {
        window.clearInterval(remoteHoldIntervalTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const shouldShowLauncherOverlay = launcherState.appId.length > 0
      && (launcherState.status === "Launched" || launcherState.status === "Ready in app bridge")
      && selectedNavId !== "home"
      && launcherState.runtime !== "Native app process";
    setShowRuntimePanel(shouldShowLauncherOverlay);
  }, [launcherState.appId, launcherState.runtime, launcherState.status, selectedNavId]);

  useEffect(() => {
    if (!remoteMode || typeof document === "undefined" || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      return;
    }

    const onRemoteControlPress = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const interactive = target.closest("button, a, [role='button'], [role='tab'], input[type='range']");
      if (!interactive) {
        return;
      }

      const className = (interactive.getAttribute("class") ?? "").toLowerCase();
      const label = (interactive.getAttribute("aria-label") ?? interactive.textContent ?? "").toLowerCase();

      if (/disconnect|stop|remove|reset|failed|error/.test(label)) {
        navigator.vibrate([24, 34, 24]);
        return;
      }

      if (
        /launch|open|start|apply|restart|connect|pair|reconnect|route|scan|run|ok|confirm/.test(label)
        || className.includes("theme-toggle--primary")
      ) {
        navigator.vibrate([14, 24, 14]);
        return;
      }

      navigator.vibrate(10);
    };

    document.addEventListener("click", onRemoteControlPress, true);

    return () => {
      document.removeEventListener("click", onRemoteControlPress, true);
    };
  }, [remoteMode]);

  const toTripDescriptor = (trip: TripLog): TripDescriptor => ({
    id: trip.id,
    title: trip.title,
    detail: `${trip.distanceNm.toFixed(2)} NM logged from ${new Date(trip.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    tag: trip.tag,
    distanceNm: trip.distanceNm,
    startedAt: trip.startedAt,
    endedAt: trip.endedAt,
    maxSpeedKnots: trip.maxSpeedKnots,
    averageSpeedKnots: trip.averageSpeedKnots,
    averageDepthFeet: trip.averageDepthFeet,
    averageWaterTempF: trip.averageWaterTempF,
    maxRpmTotal: trip.maxRpmTotal,
    averageRpmTotal: trip.averageRpmTotal,
    maxEngineTempF: trip.maxEngineTempF,
    averageEngineTempF: trip.averageEngineTempF,
    averageFuelBurnGph: trip.averageFuelBurnGph,
    breadcrumbs: trip.breadcrumbs,
    origin: "local"
  });

  function buildTripTelemetrySnapshot() {
    const toFiniteOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const toStringOrNull = (value: unknown) => (typeof value === "string" && value.trim().length > 0 ? value : null);

    const speedKnots = Number.parseFloat((activeSummary?.metrics.find((metric) => metric.label === "Speed")?.value ?? "0")) || null;
    const headingDegrees = Number.parseFloat((activeSummary?.metrics.find((metric) => metric.label === "Heading")?.value ?? "0")) || null;
    const depthFeet = Number.parseFloat((activeSummary?.metrics.find((metric) => metric.label === "Depth")?.value ?? "0")) || null;
    const waterTempF = activeSummary?.weather.waterTemp && activeSummary.weather.waterTemp.includes("F")
      ? Number.parseFloat(activeSummary.weather.waterTemp)
      : null;

    const portEngine = activeSummary?.engines.find((engine) => engine.label.toLowerCase().includes("port"));
    const centerEngine = activeSummary?.engines.find((engine) => engine.label.toLowerCase().includes("center"));
    const starboardEngine = activeSummary?.engines.find((engine) => engine.label.toLowerCase().includes("starboard"));
    const validEngines = (activeSummary?.engines ?? []).filter((engine) => Number.isFinite(engine.rpm));
    const engineRpmTotal = validEngines.length > 0
      ? validEngines.reduce((sum, engine) => sum + engine.rpm, 0)
      : null;

    const engineTemps = validEngines
      .map((engine) => engine.tempF)
      .filter((value) => Number.isFinite(value));

    const engineTempAvgF = engineTemps.length > 0
      ? Number((engineTemps.reduce((sum, value) => sum + value, 0) / engineTemps.length).toFixed(1))
      : null;

    const engineTempMaxF = engineTemps.length > 0
      ? Math.max(...engineTemps)
      : null;

    const fuelBurnValues = validEngines
      .map((engine) => engine.gph)
      .filter((value) => Number.isFinite(value));

    const fuelBurnGph = fuelBurnValues.length > 0
      ? Number(fuelBurnValues.reduce((sum, value) => sum + value, 0).toFixed(1))
      : null;

    const voltageValues = validEngines
      .map((engine) => engine.voltage)
      .filter((value) => Number.isFinite(value));

    const engineVoltageAvg = voltageValues.length > 0
      ? Number((voltageValues.reduce((sum, value) => sum + value, 0) / voltageValues.length).toFixed(2))
      : null;

    const engineSnapshots: EngineBreadcrumbSnapshot[] = (activeSummary?.engines ?? []).map((engine) => {
      const extended = engine as typeof engine & {
        oilPressurePsi?: unknown;
        oilTempF?: unknown;
        coolantTempF?: unknown;
        trimPercent?: unknown;
        loadPercent?: unknown;
        boostPsi?: unknown;
        alternatorVoltage?: unknown;
        hours?: unknown;
        gear?: unknown;
      };

      return {
        label: engine.label,
        rpm: toFiniteOrNull(engine.rpm),
        gph: toFiniteOrNull(engine.gph),
        tempF: toFiniteOrNull(engine.tempF),
        voltage: toFiniteOrNull(engine.voltage),
        oilPressurePsi: toFiniteOrNull(extended.oilPressurePsi),
        oilTempF: toFiniteOrNull(extended.oilTempF),
        coolantTempF: toFiniteOrNull(extended.coolantTempF),
        trimPercent: toFiniteOrNull(extended.trimPercent),
        loadPercent: toFiniteOrNull(extended.loadPercent),
        boostPsi: toFiniteOrNull(extended.boostPsi),
        alternatorVoltage: toFiniteOrNull(extended.alternatorVoltage),
        hours: toFiniteOrNull(extended.hours),
        gear: toStringOrNull(extended.gear)
      };
    });

    return {
      speedKnots,
      headingDegrees,
      depthFeet,
      waterTempF,
      engineRpmTotal,
      engineTempAvgF,
      engineTempMaxF,
      fuelBurnGph,
      engineVoltageAvg,
      portRpm: portEngine?.rpm ?? null,
      centerRpm: centerEngine?.rpm ?? null,
      starboardRpm: starboardEngine?.rpm ?? null,
      engineSnapshots,
      wind: activeSummary?.weather.wind ?? "Unknown",
      barometer: activeSummary?.weather.barometer ?? "Unknown",
      networkStatus: activeSummary?.connectivity.network ?? "Unknown",
      source: activeSummary?.connectivity.nmea ?? "Live route"
    };
  }

  function startTripSession() {
    if (activeTripRef.current) {
      setTripControlMessage("Trip already running");
      return;
    }

    const beginTripAtPoint = (point: { latitude: number; longitude: number }) => {
      const telemetry = buildTripTelemetrySnapshot();

      const nextTrip = startTripLog({
        latitude: point.latitude,
        longitude: point.longitude,
        speedKnots: telemetry.speedKnots,
        headingDegrees: telemetry.headingDegrees,
        depthFeet: telemetry.depthFeet,
        waterTempF: telemetry.waterTempF,
        engineRpmTotal: telemetry.engineRpmTotal,
        engineTempAvgF: telemetry.engineTempAvgF,
        engineTempMaxF: telemetry.engineTempMaxF,
        fuelBurnGph: telemetry.fuelBurnGph,
        engineVoltageAvg: telemetry.engineVoltageAvg,
        portRpm: telemetry.portRpm,
        centerRpm: telemetry.centerRpm,
        starboardRpm: telemetry.starboardRpm,
        engineSnapshots: telemetry.engineSnapshots,
        wind: telemetry.wind,
        barometer: telemetry.barometer,
        networkStatus: telemetry.networkStatus,
        source: telemetry.source
      });

      activeTripRef.current = nextTrip;
      setTripSession(nextTrip);
      setSelectedTripId(nextTrip.id);
      setTripHistory((current) => [toTripDescriptor(nextTrip), ...current]);
      setTripControlMessage(`Trip started at ${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`);
    };

    const chartCenterFallback = tripMapCenter
      ? { latitude: tripMapCenter[0], longitude: tripMapCenter[1] }
      : weatherMapCenter
        ? { latitude: weatherMapCenter[0], longitude: weatherMapCenter[1] }
        : fishingMapViewportCenter
          ? { latitude: fishingMapViewportCenter[0], longitude: fishingMapViewportCenter[1] }
          : fishingMapCenter
            ? { latitude: fishingMapCenter[0], longitude: fishingMapCenter[1] }
          : null;

    const point = preferredMapPosition;
    if (point) {
      beginTripAtPoint(point);
      return;
    }

    if (!navigator.geolocation) {
      if (chartCenterFallback) {
        beginTripAtPoint(chartCenterFallback);
        setTripControlMessage("Trip started from chart center (live GPS/NMEA unavailable)");
        return;
      }

      setTripControlMessage("Cannot start trip: position unavailable");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fallbackPoint = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };

        setBrowserGeoLocation([fallbackPoint.latitude, fallbackPoint.longitude]);
        setVesselPosition(fallbackPoint);
        beginTripAtPoint(fallbackPoint);
      },
      () => {
        if (chartCenterFallback) {
          beginTripAtPoint(chartCenterFallback);
          setTripControlMessage("Trip started from chart center (browser geolocation unavailable)");
          return;
        }

        setTripControlMessage("Cannot start trip: live position unavailable (GPS/NMEA and browser geolocation not available)");
      }
    );
  }

  function canAutoEndTripAtHome(trip: TripLog | null) {
    if (!trip) {
      return false;
    }

    if (trip.breadcrumbs.length < 3) {
      return false;
    }

    if (trip.distanceNm < 0.05) {
      return false;
    }

    const startedAtMs = Date.parse(trip.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return false;
    }

    return Date.now() - startedAtMs >= 120000;
  }

  function finishTripAtHome(radiusNm?: number) {
    if (!activeTripRef.current || !vesselPosition || !homePortPoint) {
      return;
    }

    const safeRadius = radiusNm ?? homePortRadiusNm;
    const atHome = shouldEndTripAtHome(homePortPoint.latitude, homePortPoint.longitude, vesselPosition.latitude, vesselPosition.longitude, safeRadius);
    if (!atHome) {
      return;
    }

    stopTripSession();
  }

  function stopTripSession() {
    if (!activeTripRef.current) {
      return;
    }

    const finalized = finalizeTripLog(activeTripRef.current);
    activeTripRef.current = null;
    setTripSession(null);
    setSelectedTripId(finalized.id);
    setTripHistory((current) => [toTripDescriptor(finalized), ...current.filter((trip) => trip.id !== finalized.id)]);
    setTripControlMessage("Trip stopped and saved");
  }

  function deleteSavedTrip(tripId: string) {
    if (!tripId) {
      return;
    }

    const selected = tripHistory.find((trip) => trip.id === tripId);
    if (selected && (selected.origin ?? "local") !== "local") {
      setTripControlMessage("Cruise Report trips are read-only in this view.");
      return;
    }

    if (tripSession?.id === tripId) {
      setTripControlMessage("Stop the active trip before deleting it.");
      return;
    }

    setTripHistory((current) => current.filter((trip) => trip.id !== tripId));
    setSelectedTripId((current) => (current === tripId ? (tripSession?.id ?? null) : current));
    setTripControlMessage("Saved trip deleted");
  }

  const appendActiveTripSample = useCallback((position: { latitude: number; longitude: number }) => {
    if (!activeTripRef.current) {
      return;
    }

    const nowMs = Date.now();
    const lastSample = lastTripSampleRef.current;
    if (lastSample) {
      const elapsedMs = nowMs - lastSample.atMs;
      const movementDelta = Math.hypot(position.latitude - lastSample.latitude, position.longitude - lastSample.longitude);
      if (elapsedMs < 2500 && movementDelta < 0.00003) {
        return;
      }
    }

    const telemetry = buildTripTelemetrySnapshot();

    const updatedTrip = appendTripBreadcrumb(activeTripRef.current, {
      latitude: position.latitude,
      longitude: position.longitude,
      speedKnots: telemetry.speedKnots,
      headingDegrees: telemetry.headingDegrees,
      depthFeet: telemetry.depthFeet,
      waterTempF: telemetry.waterTempF,
      engineRpmTotal: telemetry.engineRpmTotal,
      engineTempAvgF: telemetry.engineTempAvgF,
      engineTempMaxF: telemetry.engineTempMaxF,
      fuelBurnGph: telemetry.fuelBurnGph,
      engineVoltageAvg: telemetry.engineVoltageAvg,
      portRpm: telemetry.portRpm,
      centerRpm: telemetry.centerRpm,
      starboardRpm: telemetry.starboardRpm,
      engineSnapshots: telemetry.engineSnapshots,
      wind: telemetry.wind,
      barometer: telemetry.barometer,
      networkStatus: telemetry.networkStatus,
      source: telemetry.source
    });

    lastTripSampleRef.current = {
      atMs: nowMs,
      latitude: position.latitude,
      longitude: position.longitude
    };

    activeTripRef.current = updatedTrip;
    setTripSession(updatedTrip);
    setSelectedTripId(updatedTrip.id);
    setTripHistory((current) => [
      toTripDescriptor(updatedTrip),
      ...current.filter((trip) => trip.id !== updatedTrip.id)
    ]);

    if (canAutoEndTripAtHome(updatedTrip)
      && homePortPoint
      && shouldEndTripAtHome(homePortPoint.latitude, homePortPoint.longitude, position.latitude, position.longitude, homePortRadiusNm)) {
      finishTripAtHome(homePortRadiusNm);
    }
  }, [activeSummary, homePortPoint, homePortRadiusNm]);

  useEffect(() => {
    window.localStorage.setItem(FISHING_LOG_STORAGE_KEY, JSON.stringify(fishingCatches));
  }, [fishingCatches]);

  useEffect(() => {
    window.localStorage.setItem(HOME_TILE_LAYOUT_STORAGE_KEY, JSON.stringify(homeTileLayout));
  }, [homeTileLayout]);

  useEffect(() => {
    let active = true;

    const hasCoordinates = (value: { latitude: number | null; longitude: number | null }) => {
      return typeof value.latitude === "number"
        && Number.isFinite(value.latitude)
        && typeof value.longitude === "number"
        && Number.isFinite(value.longitude);
    };

    void loadHomePortConfig()
      .then((remoteConfig) => {
        if (!active) {
          return;
        }

        setHomePortConfig((current) => {
          const currentHasCoordinates = hasCoordinates(current);
          const remoteHasCoordinates = hasCoordinates(remoteConfig);

          if (currentHasCoordinates && !remoteHasCoordinates) {
            return current;
          }

          if (!currentHasCoordinates && !remoteHasCoordinates) {
            const nextRadius = Number.isFinite(remoteConfig.radiusNm)
              ? Math.min(Math.max(remoteConfig.radiusNm, 0.05), 2.5)
              : current.radiusNm;
            return nextRadius === current.radiusNm ? current : { ...current, radiusNm: nextRadius };
          }

          return {
            latitude: remoteHasCoordinates ? remoteConfig.latitude : current.latitude,
            longitude: remoteHasCoordinates ? remoteConfig.longitude : current.longitude,
            radiusNm: Number.isFinite(remoteConfig.radiusNm)
              ? Math.min(Math.max(remoteConfig.radiusNm, 0.05), 2.5)
              : current.radiusNm
          };
        });
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(HOME_PORT_CONFIG_STORAGE_KEY, JSON.stringify(homePortConfig));
    void saveHomePortConfig(homePortConfig).catch(() => undefined);
  }, [homePortConfig]);

  useEffect(() => {
    window.localStorage.setItem(CUSTOM_BAIT_PRESETS_STORAGE_KEY, JSON.stringify(customBaitPresets));
  }, [customBaitPresets]);

  useEffect(() => {
    writeStoredTrips(tripHistory);
  }, [tripHistory]);

  useEffect(() => {
    if (!selectedTripId) {
      return;
    }

    const hasMatch = tripHistory.some((trip) => trip.id === selectedTripId);
    if (!hasMatch && (!tripSession || tripSession.id !== selectedTripId)) {
      setSelectedTripId(null);
    }
  }, [selectedTripId, tripHistory, tripSession]);

  useEffect(() => {
    const prefs: FishingMapPrefs = {
      mapDateFilter: fishingMapDateFilter,
      viewMode: fishingMapViewMode,
      basemap: fishingBasemap,
      overlayOpacity: fishingMapOverlayOpacity,
      overlays: enabledOceanOverlays
    };

    window.localStorage.setItem(FISHING_MAP_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  }, [enabledOceanOverlays, fishingBasemap, fishingMapDateFilter, fishingMapOverlayOpacity, fishingMapViewMode]);

  useEffect(() => {
    let active = true;

    loadSystemTime()
      .then((time) => {
        if (!active) {
          return;
        }

        setNowLabel(time.label);
      })
      .catch(() => {
        if (!active) {
          return;
        }

        const fallbackIso = new Date().toISOString();
        setNowLabel(formatSystemClock(fallbackIso));
      });

    const timer = window.setInterval(() => {
      const nextIso = new Date().toISOString();
      setNowLabel(formatSystemClock(nextIso));
    }, 1000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    const refreshTrips = () => {
      loadTrips()
        .then((backendTrips) => {
          if (!active || backendTrips.length === 0) {
            return;
          }

          const normalizedBackendTrips = backendTrips
            .map((trip) => ({
              ...trip,
              origin: "cruisereport" as const,
              tag: trip.tag || "Cruise report"
            }))
            .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

          setTripHistory((current) => {
            const localOnlyTrips = current.filter((trip) => (trip.origin ?? "local") !== "cruisereport");
            const merged = [...normalizedBackendTrips];

            for (const localTrip of localOnlyTrips) {
              if (!merged.some((entry) => entry.id === localTrip.id)) {
                merged.push(localTrip);
              }
            }

            return merged.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
          });

          setLastTripSyncAt(new Date().toISOString());
        })
        .catch(() => {
          // Keep local trips when backend trips are unavailable.
        });
    };

    refreshTrips();
    const timer = window.setInterval(refreshTrips, 90_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    const refreshForecast = () => {
      loadWeatherForecast()
        .then((payload) => {
          if (!active) {
            return;
          }

          if (payload.available && payload.cards.length > 0) {
            setSignalKForecastCards(payload.cards);
            setSignalKForecastSource(payload.source);
            return;
          }

          setSignalKForecastCards(null);
          setSignalKForecastSource(payload.source);
        })
        .catch(() => {
          if (!active) {
            return;
          }

          setSignalKForecastCards(null);
        });
    };

    refreshForecast();
    const timer = window.setInterval(refreshForecast, 5 * 60_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let initialized = false;

    const refreshSummary = () => {
      loadSummary()
        .then((data) => {
          if (!active) {
            return;
          }

          setSummary(data);
          const telemetryPosition = data.vesselPosition;
          if (telemetryPosition && Number.isFinite(telemetryPosition.latitude) && Number.isFinite(telemetryPosition.longitude)) {
            setVesselPosition({ latitude: telemetryPosition.latitude, longitude: telemetryPosition.longitude });
          }
          setOnline(true);

          if (!initialized) {
            initialized = true;
            setSelectedAppId((current) => (data.apps.some((app) => app.id === current) ? current : data.apps[0]?.id ?? "streaming"));
          }
        })
        .catch(() => {
          if (!active) {
            return;
          }

          setOnline(false);
          if (!initialized) {
            initialized = true;
            setSummary(fallbackSummary);
            setSelectedAppId("streaming");
          }
        });
    };

    refreshSummary();
    const timer = window.setInterval(refreshSummary, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const nextPoint = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };

        const telemetryPosition = activeSummary?.vesselPosition;
        const hasTelemetryPosition = Boolean(
          telemetryPosition
          && Number.isFinite(telemetryPosition.latitude)
          && Number.isFinite(telemetryPosition.longitude)
        );
        const effectivePoint = hasTelemetryPosition && telemetryPosition
          ? { latitude: telemetryPosition.latitude, longitude: telemetryPosition.longitude }
          : nextPoint;

        setBrowserGeoLocation([nextPoint.latitude, nextPoint.longitude]);

        // Keep telemetry/NMEA as the source of truth when available.
        setVesselPosition(effectivePoint);
      },
      () => {
        // Keep prior telemetry position; do not force a synthetic fallback location.
        setVesselPosition((current) => current);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 15000,
        timeout: 10000
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [activeSummary]);

  useEffect(() => {
    if (!vesselPosition || !activeTripRef.current) {
      return;
    }

    appendActiveTripSample(vesselPosition);
  }, [appendActiveTripSample, vesselPosition]);

  useEffect(() => {
    if (activeTripRef.current || !vesselPosition) {
      return;
    }

    const speedMetric = activeSummary?.metrics.find((metric) => metric.label.toLowerCase().includes("speed"));
    const speedValue = speedMetric ? Number.parseFloat(speedMetric.value) : Number.NaN;

    if (Number.isFinite(speedValue) && speedValue > 1.5) {
      startTripSession();
    }
  }, [activeSummary, vesselPosition]);

  useEffect(() => {
    if (!activeTripRef.current || !vesselPosition) {
      return;
    }

    if (!canAutoEndTripAtHome(activeTripRef.current)) {
      return;
    }

    if (!homePortPoint) {
      return;
    }

    if (shouldEndTripAtHome(homePortPoint.latitude, homePortPoint.longitude, vesselPosition.latitude, vesselPosition.longitude, homePortRadiusNm)) {
      stopTripSession();
    }
  }, [activeSummary, vesselPosition, homePortPoint, homePortRadiusNm]);

  useEffect(() => {
    let active = true;

    loadLauncherState()
      .then((state) => {
        if (!active) {
          return;
        }

        setLauncherState(state);
        const restorableTarget = findLaunchTargetById(state.appId);
        if (restorableTarget) {
          setLastRestorableAppId(restorableTarget.id);
        }
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setLauncherState(defaultLauncherState());
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!remoteMode) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadLauncherState()
        .then((state) => {
          setLauncherState(state);
          const restorableTarget = findLaunchTargetById(state.appId);
          if (restorableTarget) {
            setLastRestorableAppId(restorableTarget.id);
          }
        })
        .catch(() => undefined);
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [remoteMode]);

  useEffect(() => {
    let active = true;

    loadBluetoothState()
      .then((state) => {
        if (!active) {
          return;
        }

        setBluetoothState(state);
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setBluetoothState((current) => ({ ...current, lastError: "Bluetooth status unavailable" }));
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (selectedNavId !== "more") {
      setSettingsSubview("wifi");
      return;
    }

    let active = true;

    Promise.all([loadRemoteAccessStatus(), loadRemoteUpdateStatus()])
      .then(([accessStatus, updateStatus]) => {
        if (!active) {
          return;
        }

        setRemoteAccessStatus(accessStatus);
        setRemoteUpdateStatus(updateStatus);
        setRemoteOpsError(null);
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setRemoteOpsError("Remote operations status unavailable");
      });

    return () => {
      active = false;
    };
  }, [selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "more") {
      return;
    }

    let cancelled = false;
    const refreshBluetooth = () => {
      loadBluetoothState()
        .then((state) => {
          if (!cancelled) {
            setBluetoothState(state);
          }
        })
        .catch(() => undefined);
    };

    refreshBluetooth();
    const pollTimer = window.setInterval(refreshBluetooth, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
  }, [selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "more" || settingsSubview !== "wifi") {
      return;
    }

    let cancelled = false;

    const refreshWifi = () => {
      loadWifiNetworks()
        .then((result) => {
          if (!cancelled) {
            setWifiNetworks((current) => {
              if (result.networks.length === 0 && current.some((network) => network.connected)) {
                return current;
              }

              return result.networks;
            });
          }
        })
        .catch(() => undefined);
    };

    refreshWifi();
    const timer = window.setInterval(refreshWifi, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedNavId, settingsSubview]);

  useEffect(() => {
    if (selectedNavId !== "more" || settingsSubview !== "wifi") {
      setWifiHasManualScan(false);
    }
  }, [selectedNavId, settingsSubview]);

  const nmeaStatus = activeSummary.connectivity?.nmea ?? "NMEA status unavailable";
  // Only report online when data is actually flowing — "waiting for PGNs" is not connected.
  const nmeaOnline = online && /via Signal K|NMEA serial bridge/i.test(nmeaStatus);
  const selectedStream = useMemo(() => {
    return streamingTargets.find((target) => target.id === selectedStreamId) ?? streamingTargets[0] ?? {
      id: "youtube",
      name: "YouTube",
      subtitle: "Lean-back feed",
      launchUrl: "https://www.youtube.com/tv",
      launchLabel: "YouTube",
      logoPath: "/logos/youtube.svg"
    };
  }, [selectedStreamId]);

  const selectedMusic = useMemo(() => {
    return musicTargets.find((target) => target.id === selectedMusicId) ?? musicTargets[0] ?? {
      id: "spotify",
      name: "Spotify",
      subtitle: "Music",
      launchUrl: "https://open.spotify.com",
      launchLabel: "Spotify",
      logoPath: "/logos/spotify.svg"
    };
  }, [selectedMusicId]);

  const selectedNav = useMemo(() => navItems.find((item) => item.id === selectedNavId) ?? navItems[0] ?? {
    id: "home",
    label: "Home",
    detail: "Overview"
  }, [selectedNavId]);

  const selectedNavApp = useMemo(() => {
    if (selectedNavId === "home") {
      return null;
    }

    return activeSummary.apps.find((app) => app.id === selectedNavId) ?? null;
  }, [activeSummary.apps, selectedNavId]);

  const homeInstruments = useMemo(() => {
    const speedMetric = activeSummary.metrics.find((metric) => metric.label.toLowerCase().includes("speed"));
    const depthMetric = activeSummary.metrics.find((metric) => metric.label.toLowerCase().includes("depth"));
    const headingMetric = activeSummary.metrics.find((metric) => {
      const label = metric.label.toLowerCase();
      return label.includes("heading") || label.includes("course") || label.includes("cog");
    });

    let speedKnots: number | null = null;
    if (speedMetric) {
      const value = parseFirstNumber(speedMetric.value);
      if (value !== null) {
        const unit = speedMetric.unit.toLowerCase();
        if (unit.includes("kt")) {
          speedKnots = value;
        } else if (unit.includes("mph")) {
          speedKnots = value / 1.15078;
        }
      }
    }

    let depthFeet: number | null = null;
    if (depthMetric) {
      const value = parseFirstNumber(depthMetric.value);
      if (value !== null) {
        const unit = depthMetric.unit.toLowerCase();
        if (unit.includes("ft")) {
          depthFeet = value;
        } else if (unit.includes("fath")) {
          depthFeet = value * 6;
        }
      }
    }

    let headingDegrees: number | null = null;
    if (headingMetric) {
      const value = parseFirstNumber(headingMetric.value);
      if (value !== null) {
        headingDegrees = ((Math.round(value) % 360) + 360) % 360;
      }
    }

    return {
      speedKnots,
      speedMph: speedKnots === null ? null : speedKnots * 1.15078,
      headingDegrees,
      depthFeet,
      depthFathoms: depthFeet === null ? null : depthFeet / 6
    };
  }, [activeSummary.metrics]);

  const waterTempF = useMemo(() => parseFirstNumber(activeSummary.weather.waterTemp), [activeSummary.weather.waterTemp]);

  useEffect(() => {
    const pushSample = () => {
      setDepthTempTrend((current) => {
        const nextSample = {
          timestamp: new Date().toISOString(),
          depthFeet: homeInstruments.depthFeet,
          waterTempF
        };

        const last = current.at(-1);
        if (last && last.depthFeet === nextSample.depthFeet && last.waterTempF === nextSample.waterTempF) {
          return current;
        }

        return [...current, nextSample].slice(-24);
      });
    };

    pushSample();
    const timer = window.setInterval(pushSample, 15000);

    return () => {
      window.clearInterval(timer);
    };
  }, [homeInstruments.depthFeet, waterTempF]);

  const renderedDepthTempTrend = useMemo(() => {
    if (depthTempTrend.length >= 2) {
      return depthTempTrend;
    }

    return Array.from({ length: 12 }, (_, index) => ({
      timestamp: new Date(trendBaseTime - (11 - index) * 120000).toISOString(),
      depthFeet: homeInstruments.depthFeet,
      waterTempF
    }));
  }, [depthTempTrend, homeInstruments.depthFeet, trendBaseTime, waterTempF]);

  const weatherWindValue = useMemo(() => parseFirstNumber(activeSummary.weather.wind), [activeSummary.weather.wind]);
  const weatherBarometerValue = useMemo(() => parseFirstNumber(activeSummary.weather.barometer), [activeSummary.weather.barometer]);
  const seaStateLabel = useMemo(() => {
    if (weatherWindValue === null) {
      return "Sea state unknown";
    }

    if (weatherWindValue < 10) {
      return "Calm to light chop";
    }

    if (weatherWindValue < 18) {
      return "Moderate chop";
    }

    if (weatherWindValue < 25) {
      return "Heavy chop";
    }

    return "Rough conditions likely";
  }, [weatherWindValue]);

  const homeTileCatalog = useMemo(() => {
    return [
      {
        id: "speed" as HomeTileId,
        label: "Speed",
        primary: homeInstruments.speedKnots === null ? "--" : `${homeInstruments.speedKnots.toFixed(1)} kt`,
        secondary: homeInstruments.speedMph === null ? "--" : `${homeInstruments.speedMph.toFixed(1)} mph`
      },
      {
        id: "heading" as HomeTileId,
        label: "Heading",
        primary: homeInstruments.headingDegrees === null ? "---" : `${homeInstruments.headingDegrees.toString().padStart(3, "0")}°`,
        secondary: homeInstruments.headingDegrees === null ? "No COG feed" : "Magnetic"
      },
      {
        id: "depth" as HomeTileId,
        label: "Depth",
        primary: homeInstruments.depthFeet === null ? "--" : `${homeInstruments.depthFeet.toFixed(0)} ft`,
        secondary: homeInstruments.depthFathoms === null ? "--" : `${homeInstruments.depthFathoms.toFixed(1)} fath`
      },
      {
        id: "water-temp" as HomeTileId,
        label: "Water temp",
        primary: waterTempF === null ? "--" : `${waterTempF.toFixed(1)} F`,
        secondary: activeSummary.weather.wind
      },
      {
        id: "clock" as HomeTileId,
        label: "Clock",
        primary: nowLabel,
        secondary: `${activeSummary.system.uptime} uptime`
      },
      {
        id: "connection" as HomeTileId,
        label: "Connection",
        primary: activeSummary.connectivity.network,
        secondary: bluetoothState.status
      },
      {
        id: "camera" as HomeTileId,
        label: "Camera",
        primary: activeSummary.camera.status,
        secondary: `${activeSummary.camera.bufferMinutes} min buffer`
      },
      {
        id: "tide" as HomeTileId,
        label: "Tide",
        primary: activeSummary.weather.tide,
        secondary: activeSummary.harbor
      },
      {
        id: "barometer" as HomeTileId,
        label: "Barometer",
        primary: activeSummary.weather.barometer,
        secondary: activeSummary.weather.wind
      },
      {
        id: "bluetooth" as HomeTileId,
        label: "Bluetooth",
        primary: bluetoothState.connected ? "Connected" : "Not connected",
        secondary: bluetoothState.device
      }
    ];
  }, [
    activeSummary.camera.bufferMinutes,
    activeSummary.camera.status,
    activeSummary.connectivity.network,
    activeSummary.harbor,
    activeSummary.system.uptime,
    activeSummary.weather.barometer,
    activeSummary.weather.tide,
    activeSummary.weather.wind,
    bluetoothState.connected,
    bluetoothState.device,
    bluetoothState.status,
    homeInstruments.depthFathoms,
    homeInstruments.depthFeet,
    homeInstruments.headingDegrees,
    homeInstruments.speedKnots,
    homeInstruments.speedMph,
    nowLabel,
    waterTempF
  ]);

  const homeTilesById = useMemo(() => {
    return new Map(homeTileCatalog.map((tile) => [tile.id, tile]));
  }, [homeTileCatalog]);

  const configuredHomeTiles = useMemo(() => {
    return homeTileLayout.map((id, index) => {
      const tile = homeTilesById.get(id) ?? homeTileCatalog[index % homeTileCatalog.length] ?? homeTileCatalog[0]!;
      return tile;
    });
  }, [homeTileCatalog, homeTileLayout, homeTilesById]);

  const combinedBaitPresets = useMemo(() => {
    return [...customBaitPresets, ...BAIT_PRESETS];
  }, [customBaitPresets]);

  const filteredBaitPresets = useMemo(() => {
    return combinedBaitPresets.filter((bait) => {
      const typePass = selectedBaitTypeFilter === "All types" || bait.type === selectedBaitTypeFilter;
      const colorPass = selectedBaitColorFilter === "All colors" || bait.color === selectedBaitColorFilter;
      return typePass && colorPass;
    });
  }, [combinedBaitPresets, selectedBaitColorFilter, selectedBaitTypeFilter]);

  const selectedBait = useMemo(() => {
    return combinedBaitPresets.find((bait) => bait.id === selectedBaitId) ?? combinedBaitPresets[0] ?? BAIT_PRESETS[0];
  }, [combinedBaitPresets, selectedBaitId]);

  useEffect(() => {
    if (combinedBaitPresets.length === 0) {
      return;
    }

    const selectedExists = combinedBaitPresets.some((bait) => bait.id === selectedBaitId);
    if (!selectedExists) {
      setSelectedBaitId(combinedBaitPresets[0]?.id ?? "live-menhaden");
    }
  }, [combinedBaitPresets, selectedBaitId]);

  function saveCustomBaitPreset() {
    const normalizedName = customBaitName.trim();
    const normalizedProfile = customBaitProfile.trim();

    if (!normalizedName || !normalizedProfile) {
      return;
    }

    const existing = customBaitPresets.find((bait) => {
      return bait.name.toLowerCase() === normalizedName.toLowerCase()
        && bait.type === customBaitType
        && bait.color === customBaitColor
        && bait.profile.toLowerCase() === normalizedProfile.toLowerCase();
    });

    if (existing) {
      setSelectedBaitId(existing.id);
      return;
    }

    const nextPreset: BaitPreset = {
      id: `custom-${Date.now()}`,
      name: normalizedName,
      type: customBaitType,
      color: customBaitColor,
      profile: normalizedProfile,
      custom: true
    };

    setCustomBaitPresets((current) => [nextPreset, ...current]);
    setSelectedBaitId(nextPreset.id);
    setSelectedBaitTypeFilter("All types");
    setSelectedBaitColorFilter("All colors");
    setCustomBaitName("");
    setCustomBaitProfile("");
  }

  function deleteCustomBaitPreset(id: string) {
    setCustomBaitPresets((current) => current.filter((bait) => bait.id !== id));
  }

  function setHomeTileForSlot(slotIndex: number, nextId: HomeTileId) {
    setHomeTileLayout((current) => {
      if (current[slotIndex] === nextId) {
        return current;
      }

      const next = [...current];
      const existingIndex = next.indexOf(nextId);

      if (existingIndex >= 0) {
        const currentId = next[slotIndex] ?? nextId;
        next[slotIndex] = nextId;
        next[existingIndex] = currentId;
      } else {
        next[slotIndex] = nextId;
      }

      return next;
    });
  }

  const fishSpeciesOptions = useMemo(() => {
    const species = new Set(fishingCatches.map((catchItem) => catchItem.species));
    return ["All fish", ...Array.from(species).sort()];
  }, [fishingCatches]);

  const lureOptions = useMemo(() => {
    const lures = new Set(
      fishingCatches
        .map((catchItem) => {
          if (catchItem.lureType) {
            return catchItem.lureColor ? `${catchItem.lureType} | ${catchItem.lureColor}` : catchItem.lureType;
          }
          const baitName = catchItem.bait.split(" (")[0]?.trim();
          return baitName && baitName.length > 0 ? baitName : "Unknown lure";
        })
        .filter((bait) => bait !== "")
    );

    return ["All lures", ...Array.from(lures).sort()];
  }, [fishingCatches]);

  const fishingMapFilteredCatches = useMemo(() => {
    const now = Date.now();
    const windowMs = dateWindowMsForFilter(fishingMapDateFilter);

    return fishingCatches.filter((catchItem) => {
      const dateOk = now - new Date(catchItem.timestamp).getTime() <= windowMs;
      const speciesOk = fishingMapSpeciesFilter === "All fish" || catchItem.species === fishingMapSpeciesFilter;
      const lureName = catchItem.lureType
        ? (catchItem.lureColor ? `${catchItem.lureType} | ${catchItem.lureColor}` : catchItem.lureType)
        : (catchItem.bait.split(" (")[0]?.trim() ?? "Unknown lure");
      const lureOk = fishingMapLureFilter === "All lures" || lureName === fishingMapLureFilter;
      return dateOk && speciesOk && lureOk;
    });
  }, [fishingCatches, fishingMapDateFilter, fishingMapLureFilter, fishingMapSpeciesFilter]);

  const fishingMapPoints = useMemo(() => {
    const palette = ["#00c0c0", "#6ad8a2", "#e0b060", "#ff8f70", "#9ec5ff"] as const;

    return fishingMapFilteredCatches.map((catchItem, index) => {
      const mapLatitude = catchItem.latitude ?? 27.8 + ((index % 5) * 0.34);
      const mapLongitude = catchItem.longitude ?? -84.6 + ((index % 7) * 0.28);
      const lureName = catchItem.lureType
        ? (catchItem.lureColor ? `${catchItem.lureType} | ${catchItem.lureColor}` : catchItem.lureType)
        : (catchItem.bait.split(" (")[0]?.trim() || "Unknown lure");

      return {
        ...catchItem,
        mapLatitude,
        mapLongitude,
        lureName,
        color: palette[index % palette.length] ?? "#00c0c0"
      };
    }).filter((point) => !isLikelyLand({ latitude: point.mapLatitude, longitude: point.mapLongitude }));
  }, [fishingMapFilteredCatches]);

  const telemetryVesselPosition = useMemo<{ latitude: number; longitude: number } | null>(() => {
    const telemetryPosition = summary?.vesselPosition;
    if (telemetryPosition && Number.isFinite(telemetryPosition.latitude) && Number.isFinite(telemetryPosition.longitude)) {
      return { latitude: telemetryPosition.latitude, longitude: telemetryPosition.longitude };
    }

    return null;
  }, [summary?.vesselPosition]);

  const preferredMapPosition = useMemo<{ latitude: number; longitude: number } | null>(() => {
    if (telemetryVesselPosition) {
      return telemetryVesselPosition;
    }

    if (vesselPosition) {
      return vesselPosition;
    }

    if (browserGeoLocation) {
      return { latitude: browserGeoLocation[0], longitude: browserGeoLocation[1] };
    }

    if (lastKnownVesselPosition) {
      return lastKnownVesselPosition;
    }

    return null;
  }, [telemetryVesselPosition, vesselPosition, browserGeoLocation, lastKnownVesselPosition]);

  const preferredMapPositionSource = useMemo(() => {
    if (telemetryVesselPosition) {
      return "NMEA";
    }

    if (vesselPosition) {
      return "Device GPS";
    }

    if (browserGeoLocation) {
      return "Browser geolocation";
    }

    if (lastKnownVesselPosition) {
      return "Last known vessel";
    }

    return "Default";
  }, [telemetryVesselPosition, vesselPosition, browserGeoLocation, lastKnownVesselPosition]);

  const myVesselHomePortMapCenter = useMemo<[number, number]>(() => {
    if (homePortPoint) {
      return [homePortPoint.latitude, homePortPoint.longitude];
    }

    if (preferredMapPosition) {
      return [preferredMapPosition.latitude, preferredMapPosition.longitude];
    }

    return [34.72, -76.67];
  }, [homePortPoint, preferredMapPosition]);

  const fishingMapCenter = useMemo<[number, number]>(() => {
    if (preferredMapPosition) {
      return [preferredMapPosition.latitude, preferredMapPosition.longitude];
    }

    return [34.72, -76.67];
  }, [preferredMapPosition]);

  const mapRecentCenterPosition = useMemo<{ latitude: number; longitude: number } | null>(() => {
    if (!preferredMapPosition) {
      return null;
    }

    if (mapHeadingMode === "course" && homeInstruments.headingDegrees !== null) {
      return projectPointByCourse(
        preferredMapPosition.latitude,
        preferredMapPosition.longitude,
        homeInstruments.headingDegrees,
        0.55
      );
    }

    return preferredMapPosition;
  }, [preferredMapPosition, mapHeadingMode, homeInstruments.headingDegrees]);

  const oceanOverlayOpacity = fishingMapOverlayOpacity / 100;
  const oceanRasterAttenuation = fishingMapZoom >= 12
    ? 0.16
    : fishingMapZoom >= 10
      ? 0.22
      : fishingMapZoom >= 8
        ? 0.3
        : fishingMapZoom >= 6
          ? 0.45
        : 1;
  const oceanRasterSoftened = oceanRasterAttenuation < 0.99;
  const sstOverlayOpacity = Math.min(0.34, oceanOverlayOpacity * oceanRasterAttenuation);
  const chlorophyllOverlayOpacity = Math.min(0.24, oceanOverlayOpacity * oceanRasterAttenuation * 0.8);
  const showSstRaster = enabledOceanOverlays.sst;
  const showChlorophyllRaster = enabledOceanOverlays.chlorophyll && !enabledOceanOverlays.sst;
  const showFishingMapDiagnostics = fishingMapMode === "hunt" || showFishingMapSettings;
  const advisorSpeciesOptions = useMemo(() => ["Auto (map species)", ...pelagicSpecies], []);
  const displayedBuoys = useMemo(() => {
    return [...oceanBuoys]
      .sort((a, b) => {
        const distanceA = Math.hypot(a.latitude - fishingMapCenter[0], a.longitude - fishingMapCenter[1]);
        const distanceB = Math.hypot(b.latitude - fishingMapCenter[0], b.longitude - fishingMapCenter[1]);
        return distanceA - distanceB;
      })
      .slice(0, 12);
  }, [fishingMapCenter, oceanBuoys]);

  const latestBuoyObservationLabel = useMemo(() => {
    if (oceanBuoys.length === 0) {
      return "No buoy sample";
    }

    const newestTimestamp = oceanBuoys.reduce((latest, buoy) => {
      const next = new Date(buoy.observedAt).getTime();
      return Number.isNaN(next) ? latest : Math.max(latest, next);
    }, 0);

    if (!newestTimestamp) {
      return "No buoy sample";
    }

    return new Date(newestTimestamp).toLocaleString();
  }, [oceanBuoys]);

  const nearbyMarineBuoys = useMemo(() => {
    return displayedBuoys.filter((buoy) => !isLikelyLand({ latitude: buoy.latitude, longitude: buoy.longitude }));
  }, [displayedBuoys]);

  const nearestWaveBuoy = useMemo(() => {
    return nearbyMarineBuoys.find((buoy) => buoy.waveHeightM !== null) ?? null;
  }, [nearbyMarineBuoys]);

  const currentWaveFeet = useMemo(() => {
    if (!nearestWaveBuoy || nearestWaveBuoy.waveHeightM === null) {
      return null;
    }

    return nearestWaveBuoy.waveHeightM * 3.28084;
  }, [nearestWaveBuoy]);

  const peakWaveFeet = useMemo(() => {
    const values = nearbyMarineBuoys
      .map((buoy) => buoy.waveHeightM)
      .filter((value): value is number => value !== null)
      .map((value) => value * 3.28084);

    if (values.length === 0) {
      return null;
    }

    return Math.max(...values);
  }, [nearbyMarineBuoys]);

  const avgBuoyWindKnots = useMemo(() => {
    const values = nearbyMarineBuoys
      .map((buoy) => buoy.windSpeedMps)
      .filter((value): value is number => value !== null)
      .map((value) => value * 1.94384);

    if (values.length === 0) {
      return null;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [nearbyMarineBuoys]);

  const buoyPressureTrend = useMemo(() => {
    const timeline = nearbyMarineBuoys
      .map((buoy) => ({
        pressure: buoy.pressureHpa,
        observedAt: new Date(buoy.observedAt).getTime()
      }))
      .filter((entry) => entry.pressure !== null && Number.isFinite(entry.observedAt))
      .sort((a, b) => a.observedAt - b.observedAt);

    if (timeline.length < 2) {
      return {
        label: "Steady",
        delta: null as number | null
      };
    }

    const splitIndex = Math.max(1, Math.floor(timeline.length / 2));
    const older = timeline.slice(0, splitIndex);
    const newer = timeline.slice(splitIndex);

    if (older.length === 0 || newer.length === 0) {
      return {
        label: "Steady",
        delta: null as number | null
      };
    }

    const oldAvg = older.reduce((sum, entry) => sum + (entry.pressure ?? 0), 0) / older.length;
    const newAvg = newer.reduce((sum, entry) => sum + (entry.pressure ?? 0), 0) / newer.length;
    const delta = newAvg - oldAvg;

    if (delta <= -1.5) {
      return { label: "Falling", delta };
    }

    if (delta >= 1.5) {
      return { label: "Rising", delta };
    }

    return { label: "Steady", delta };
  }, [nearbyMarineBuoys]);

  const weatherForecastCards = useMemo(() => {
    if (signalKForecastCards && signalKForecastCards.length > 0) {
      return signalKForecastCards.map((card) => ({
        label: card.label,
        wind: card.windKnots,
        wave: card.waveFeet,
        outlook: card.outlook
      }));
    }

    const baseWind = avgBuoyWindKnots ?? weatherWindValue ?? 12;
    const baseWave = currentWaveFeet ?? peakWaveFeet ?? 3.5;
    const pressurePush = buoyPressureTrend.label === "Falling"
      ? 1
      : buoyPressureTrend.label === "Rising"
        ? -1
        : 0;

    const buildCard = (label: string, hourOffset: number) => {
      const wind = Math.max(0, baseWind + (pressurePush * (hourOffset / 6)) + (hourOffset === 12 ? 1 : 0));
      const wave = Math.max(0.5, baseWave + ((wind - baseWind) * 0.14));

      let outlook = "Stable marine run";
      if (wave >= 6.5 || wind >= 24) {
        outlook = "Hazardous run window";
      } else if (wave >= 4.5 || wind >= 18) {
        outlook = "Bumpy offshore legs";
      } else if (wave <= 2.5 && wind <= 12) {
        outlook = "Clean travel window";
      }

      return {
        label,
        wind,
        wave,
        outlook
      };
    };

    return [
      buildCard("Now", 0),
      buildCard("+6h", 6),
      buildCard("+12h", 12)
    ];
  }, [avgBuoyWindKnots, buoyPressureTrend.label, currentWaveFeet, peakWaveFeet, signalKForecastCards, weatherWindValue]);

  useEffect(() => {
    stormRadarTileUrlRef.current = stormRadarTileUrl;
  }, [stormRadarTileUrl]);

  useEffect(() => {
    stormRadarPlayingRef.current = stormRadarPlaying;
  }, [stormRadarPlaying]);

  useEffect(() => {
    stormRadarPlaybackIndexRef.current = stormRadarPlaybackIndex;
  }, [stormRadarPlaybackIndex]);

  useEffect(() => {
    if (selectedNavId !== "weather") {
      return;
    }

    let active = true;
    const refreshRadarFrame = async (initial: boolean) => {
      if (initial) {
        setLoadingStormRadar(true);
      }

      try {
        const payload = await loadStormRadarFrame();
        if (!active) {
          return;
        }

        if (!payload.available || !payload.tileUrlTemplate) {
          setStormRadarFrameLabel(stormRadarTileUrlRef.current ? "Radar feed delayed (showing last good frame)" : "Radar feed unavailable");
          return;
        }

        const timeline = (payload.timeline ?? []).filter((frame) => typeof frame.tileUrlTemplate === "string" && frame.tileUrlTemplate.length > 0);
        setStormRadarTimeline(timeline);

        if (timeline.length > 0) {
          if (stormRadarPlayingRef.current) {
            const nextIndex = Math.max(0, Math.min(stormRadarPlaybackIndexRef.current, timeline.length - 1));
            setStormRadarPlaybackIndex(nextIndex);
            return;
          }

          let lastObservedIndex = -1;
          for (let index = timeline.length - 1; index >= 0; index -= 1) {
            if (timeline[index]?.kind === "past") {
              lastObservedIndex = index;
              break;
            }
          }

          const selectedIndex = lastObservedIndex >= 0 ? lastObservedIndex : (timeline.length - 1);
          setStormRadarPlaybackIndex(selectedIndex);
          setStormRadarPreviousTileUrl(null);
          setStormRadarTileUrl(timeline[selectedIndex]?.tileUrlTemplate ?? payload.tileUrlTemplate);
          setStormRadarFrameLabel(
            timeline[selectedIndex]?.observedAt
              ? new Date(timeline[selectedIndex].observedAt as string).toLocaleString()
              : (
                timeline[selectedIndex]?.kind === "future"
                  ? "Forecast frame"
                  : timeline[selectedIndex]?.kind === "nowcast"
                    ? "Nowcast frame"
                    : "Live frame"
              )
          );
          return;
        }

        setStormRadarPreviousTileUrl(null);
        setStormRadarTileUrl(payload.tileUrlTemplate);
        setStormRadarFrameLabel(
          payload.observedAt
            ? new Date(payload.observedAt).toLocaleString()
            : "Live frame"
        );
      } catch {
        if (!active) {
          return;
        }

        setStormRadarFrameLabel(stormRadarTileUrlRef.current ? "Radar sync issue (showing last good frame)" : "Radar feed unavailable");
      } finally {
        if (active && initial) {
          setLoadingStormRadar(false);
        }
      }
    };

    void refreshRadarFrame(true);
    const intervalId = window.setInterval(() => {
      void refreshRadarFrame(false);
    }, 90000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "weather") {
      setStormRadarPlaying(false);
      setStormRadarPreviousTileUrl(null);
    }
  }, [selectedNavId]);

  useEffect(() => {
    if (!stormRadarPlaying || stormRadarTimeline.length < 2 || selectedNavId !== "weather") {
      return;
    }

    const timer = window.setInterval(() => {
      setStormRadarPlaybackIndex((current) => {
        if (stormRadarTimeline.length === 0) {
          return 0;
        }

        const next = current + 1;
        if (next >= stormRadarTimeline.length) {
          window.setTimeout(() => setStormRadarPlaying(false), 0);
          return stormRadarTimeline.length - 1;
        }

        return next;
      });
    }, 2200);

    return () => {
      window.clearInterval(timer);
    };
  }, [selectedNavId, stormRadarPlaying, stormRadarTimeline]);

  useEffect(() => {
    if (stormRadarTimeline.length === 0) {
      return;
    }

    const frame = stormRadarTimeline[Math.max(0, Math.min(stormRadarPlaybackIndex, stormRadarTimeline.length - 1))];
    if (!frame) {
      return;
    }

    if (frame.tileUrlTemplate !== stormRadarTileUrlRef.current) {
      setStormRadarPreviousTileUrl(stormRadarPlaying ? stormRadarTileUrlRef.current : null);
      setStormRadarTileUrl(frame.tileUrlTemplate);
    }

    setStormRadarFrameLabel(
      frame.observedAt
        ? `${new Date(frame.observedAt).toLocaleString()}${frame.kind === "future" ? " (forecast)" : frame.kind === "nowcast" ? " (nowcast)" : ""}`
        : (frame.kind === "future" ? "Forecast frame" : frame.kind === "nowcast" ? "Nowcast frame" : "Live frame")
    );
  }, [stormRadarPlaybackIndex, stormRadarTimeline, stormRadarPlaying]);

  const canPlaybackRadar = stormRadarTimeline.length > 1;

  const toggleStormRadarPlayback = () => {
    if (!canPlaybackRadar) {
      return;
    }

    setStormRadarPlaying((current) => {
      if (current) {
        return false;
      }

      setStormRadarPreviousTileUrl(null);
      setStormRadarPlaybackIndex(0);
      return true;
    });
  };

  const stepStormRadarFrame = (delta: -1 | 1) => {
    if (stormRadarTimeline.length === 0) {
      return;
    }

    setStormRadarPlaying(false);
    setStormRadarPlaybackIndex((current) => {
      const next = current + delta;
      if (next < 0) {
        return 0;
      }
      if (next >= stormRadarTimeline.length) {
        return stormRadarTimeline.length - 1;
      }
      return next;
    });
  };

  const allFishMappingCircles = useMemo<FishMappingCircle[]>(() => {
    // When species intel is available use its independently-scored per-species locations
    if (speciesIntel && speciesIntel.species.length > 0) {
      const now = Date.now();
      const windowMs = dateWindowMsForFilter(fishingMapDateFilter);
      const recentCatches = fishingCatches.filter((c) => now - new Date(c.timestamp).getTime() <= windowMs);
      const refLat = vesselPosition?.latitude ?? fishingMapCenter[0];
      const refLng = vesselPosition?.longitude ?? fishingMapCenter[1];

      const rankedEntries = speciesIntel.species
        .filter((entry) => entry.bestLatitude !== null && entry.bestLongitude !== null)
        .map((entry) => {
          const distanceNm = geoDistanceNm(refLat, refLng, entry.bestLatitude as number, entry.bestLongitude as number);
          const distancePenalty = Math.min(42, distanceNm / 20);
          const operationalScore = (entry.recommended ? 10 : 0) + entry.score - distancePenalty;
          return { entry, distanceNm, operationalScore };
        })
        .sort((a, b) => b.operationalScore - a.operationalScore);

      const nearbyEntries = rankedEntries.filter((item) => item.distanceNm <= 780);
      const visibleEntries = (nearbyEntries.length >= 4 ? nearbyEntries : rankedEntries)
        .slice(0, 6)
        .map((item) => item.entry);

      const mappedCircles: FishMappingCircle[] = visibleEntries.map((entry) => {
        if (entry.bestLatitude === null || entry.bestLongitude === null) {
          return null;
        }

        const profile: SpeciesFishProfile = SPECIES_FISHMAP_PROFILES[entry.species] ?? {
          temperatureRangeF: entry.temperatureRangeF,
          chlorophyllSignal: entry.currentSignal,
          currentSignal: entry.currentSignal,
          depthBand: entry.depthBand,
          color: entry.color
        };

        const hardenedCenter = enforceSpeciesOffshoreBuffer(
          { latitude: entry.bestLatitude, longitude: entry.bestLongitude },
          entry.species,
          oceanBuoys.map((buoy) => ({ latitude: buoy.latitude, longitude: buoy.longitude }))
        );

        return {
          id: `fish-map-${entry.species.toLowerCase().replace(/\s+/g, "-")}`,
          species: entry.species,
          latitude: hardenedCenter.latitude,
          longitude: hardenedCenter.longitude,
          radiusNm: entry.radiusNm,
          score: entry.score,
          confidence: entry.confidence,
          profile,
          supportingCount: recentCatches.filter((c) => c.species === entry.species).length,
          points: entry.points
        };
      }).filter((c): c is FishMappingCircle => c !== null);

      const buoyAnchors = oceanBuoys.map((buoy) => ({ latitude: buoy.latitude, longitude: buoy.longitude }));
      const scoutCircles: FishMappingCircle[] = [];

      mappedCircles.forEach((circle) => {
        const circleDistanceNm = geoDistanceNm(refLat, refLng, circle.latitude, circle.longitude);
        if (circle.score < 50 || circleDistanceNm > 820) {
          return;
        }

        const speciesSeed = circle.species.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
        const baseAngle = (speciesSeed % 360) * (Math.PI / 180);
        const scoutRadiusNm = Math.max(2.4, Math.min(4.2, circle.radiusNm * 0.52));
        const offsetDistanceNm = Math.max(10, circle.radiusNm * 1.9);
        const side = speciesSeed % 2 === 0 ? 1 : -1;
        const bearingAngle = baseAngle + (side * Math.PI * 0.42);
        const eastOffsetNm = Math.cos(bearingAngle) * offsetDistanceNm;
        const northOffsetNm = Math.sin(bearingAngle) * offsetDistanceNm;
        const rawPoint = offsetPointByNm([circle.latitude, circle.longitude], eastOffsetNm, northOffsetNm);
        const offshorePoint = enforceSpeciesOffshoreBuffer(
          { latitude: rawPoint[0], longitude: rawPoint[1] },
          circle.species,
          buoyAnchors
        );

        if (isLikelyNearshoreInvalid(offshorePoint)) {
          return;
        }

        const requiredOffshoreNm = minOffshoreNmForSpecies(circle.species);
        const offshoreNm = offshoreDistanceFromAtlanticCoastNm(offshorePoint);
        if (offshoreNm !== null && offshoreNm < requiredOffshoreNm) {
          return;
        }

        scoutCircles.push({
          id: `${circle.id}-scout`,
          species: circle.species,
          latitude: offshorePoint.latitude,
          longitude: offshorePoint.longitude,
          radiusNm: scoutRadiusNm,
          score: Math.max(24, circle.score - 14),
          confidence: "low",
          profile: circle.profile,
          supportingCount: circle.supportingCount,
          points: buildSpeciesCoveragePolygon(offshorePoint.latitude, offshorePoint.longitude, scoutRadiusNm, circle.species)
        });
      });

      return [...mappedCircles, ...scoutCircles].sort((a, b) => b.score - a.score);
    }

    // Fallback: original logic when intel not loaded
    const now = Date.now();
    const windowMs = dateWindowMsForFilter(fishingMapDateFilter);
    const recentCatches = fishingCatches.filter((catchItem) => now - new Date(catchItem.timestamp).getTime() <= windowMs);
    const marineBuoys = oceanBuoys.filter((buoy) => !isLikelyNearshoreInvalid({ latitude: buoy.latitude, longitude: buoy.longitude }));
    const signalFronts = fishingAdvisor?.oceanSignals?.fronts ?? [];
    const buoyAnchors = marineBuoys.map((buoy) => ({ latitude: buoy.latitude, longitude: buoy.longitude }));

    const circleResults: FishMappingCircle[] = [];

    pelagicSpecies.forEach((species) => {
      const profile = (SPECIES_FISHMAP_PROFILES[species] ?? SPECIES_FISHMAP_PROFILES.Tuna) as SpeciesFishProfile;
      const frontPreference = SPECIES_FRONT_PREFERENCE[species] ?? { sst: 1, convergence: 1 };
      const speciesCatches = recentCatches.filter((catchItem) => catchItem.species === species);
      const geoCatches = speciesCatches.filter((catchItem) => {
        if (catchItem.latitude === null || catchItem.longitude === null) {
          return false;
        }

        return !isLikelyNearshoreInvalid({ latitude: catchItem.latitude, longitude: catchItem.longitude });
      });

      const rankedFronts = signalFronts
        .map((front) => {
          const weight = front.kind === "sst" ? frontPreference.sst : frontPreference.convergence;
          return { front, weightedScore: front.score * weight };
        })
        .sort((a, b) => b.weightedScore - a.weightedScore);

      const topFront = rankedFronts[0]?.front;

      if (geoCatches.length === 0 && marineBuoys.length === 0 && !topFront) {
        return;
      }

      let latitude: number;
      let longitude: number;

      if (geoCatches.length > 0) {
        latitude = geoCatches.reduce((sum, catchItem) => sum + (catchItem.latitude as number), 0) / geoCatches.length;
        longitude = geoCatches.reduce((sum, catchItem) => sum + (catchItem.longitude as number), 0) / geoCatches.length;
      } else if (marineBuoys.length > 0) {
        const targetTemp = (profile.temperatureRangeF.min + profile.temperatureRangeF.max) / 2;
        const buoyCandidate = marineBuoys
          .filter((buoy) => buoy.waterTempC !== null)
          .map((buoy) => ({ buoy, delta: Math.abs((((buoy.waterTempC as number) * 9) / 5 + 32) - targetTemp) }))
          .sort((a, b) => a.delta - b.delta)[0]?.buoy;

        latitude = buoyCandidate?.latitude ?? fishingMapCenter[0] + ((pelagicSpecies.indexOf(species) - 3) * 0.18);
        longitude = buoyCandidate?.longitude ?? fishingMapCenter[1] + ((pelagicSpecies.indexOf(species) - 3) * 0.22);
      } else if (topFront) {
        latitude = topFront.midpoint.latitude;
        longitude = topFront.midpoint.longitude;
      } else {
        return;
      }

      const offshoreCenter = enforceSpeciesOffshoreBuffer({ latitude, longitude }, species, buoyAnchors);
      if (isLikelyNearshoreInvalid(offshoreCenter)) {
        return;
      }

      const requiredOffshoreNm = minOffshoreNmForSpecies(species);
      const offshoreNm = offshoreDistanceFromAtlanticCoastNm(offshoreCenter);
      if (offshoreNm !== null && offshoreNm < requiredOffshoreNm) {
        return;
      }

      const frontSignal = topFront ? Math.min(1, topFront.score / 100) : 0.24;
      const historySignal = Math.min(1, speciesCatches.length / 5);
      const offshoreSignal = offshoreNm === null
        ? 0.55
        : Math.min(1, offshoreNm / Math.max(requiredOffshoreNm * 1.4, requiredOffshoreNm + 10));

      const score = Math.round(32 + ((frontSignal * 0.45) + (historySignal * 0.35) + (offshoreSignal * 0.2)) * 52);
      if (score < 52) {
        return;
      }

      const confidence: "high" | "medium" | "low" = score >= 74 ? "high" : score >= 60 ? "medium" : "low";
      const baseRadiusNm = 8;
      const shoreSafeRadius = offshoreNm === null
        ? baseRadiusNm
        : Math.max(3.2, Math.min(baseRadiusNm, Math.max(3.2, offshoreNm - (requiredOffshoreNm * 0.45))));
      const extendedRadius = Number(shoreSafeRadius.toFixed(1));

      circleResults.push({
        id: `fish-map-${species.toLowerCase().replace(/\s+/g, "-")}`,
        species,
        latitude: offshoreCenter.latitude,
        longitude: offshoreCenter.longitude,
        radiusNm: extendedRadius,
        score,
        confidence,
        profile,
        supportingCount: speciesCatches.length,
        points: buildSpeciesCoveragePolygon(offshoreCenter.latitude, offshoreCenter.longitude, extendedRadius, species).map((point) => {
          const adjusted = pushPointOffshore({ latitude: point[0], longitude: point[1] }, buoyAnchors);
          return [adjusted.latitude, adjusted.longitude] as [number, number];
        })
      });
    });

    return circleResults;
  }, [fishingAdvisor, fishingCatches, fishingMapCenter, fishingMapDateFilter, oceanBuoys, speciesIntel]);

  const fishMappingCircles = useMemo(() => {
    return allFishMappingCircles.filter((circle) => speciesVisibility[circle.species] !== false);
  }, [allFishMappingCircles, speciesVisibility]);
  const fishLegendCircles = useMemo(() => {
    const refLat = vesselPosition?.latitude ?? fishingMapCenter[0];
    const refLng = vesselPosition?.longitude ?? fishingMapCenter[1];

    return [...fishMappingCircles]
      .sort((a, b) => {
        const aScout = a.id.includes("-scout") ? 1 : 0;
        const bScout = b.id.includes("-scout") ? 1 : 0;
        if (aScout !== bScout) {
          return aScout - bScout;
        }

        const aDist = geoDistanceNm(refLat, refLng, a.latitude, a.longitude);
        const bDist = geoDistanceNm(refLat, refLng, b.latitude, b.longitude);
        if (Math.abs(aDist - bDist) > 12) {
          return aDist - bDist;
        }

        return b.score - a.score;
      })
      .slice(0, 10);
  }, [fishMappingCircles, fishingMapCenter, vesselPosition]);

  useEffect(() => {
    if (selectedNavId !== "fishing" || allFishMappingCircles.length === 0) {
      return;
    }

    setSpeciesVisibility((current) => {
      const visibleCount = allFishMappingCircles.filter((circle) => current[circle.species] !== false).length;
      if (visibleCount >= 3) {
        return current;
      }

      const next = { ...current };
      allFishMappingCircles.forEach((circle) => {
        next[circle.species] = true;
      });
      return next;
    });
  }, [allFishMappingCircles, selectedNavId]);

  const selectedFishCircle = useMemo(() => {
    if (!fishMappingCircles.length) {
      return null;
    }

    if (selectedFishCircleId) {
      return fishMappingCircles.find((circle) => circle.id === selectedFishCircleId) ?? fishMappingCircles[0];
    }

    return fishMappingCircles[0];
  }, [fishMappingCircles, selectedFishCircleId]);

  const speciesIntelByName = useMemo(() => {
    return new Map((speciesIntel?.species ?? []).map((entry) => [entry.species, entry] as const));
  }, [speciesIntel]);

  const realtimeOceanOverlayDate = useMemo(() => {
    return new Date().toISOString().slice(0, 10);
  }, [nowLabel]);

  const currentEddyZones = useMemo(() => {
    const vectors = oceanCurrentVectors
      .filter((vector) => Number.isFinite(vector.speedKnots) && Number.isFinite(vector.directionDegrees))
      .map((vector) => {
        const angleRad = (vector.directionDegrees * Math.PI) / 180;
        return {
          latitude: vector.latitude,
          longitude: vector.longitude,
          speedKnots: vector.speedKnots,
          uEast: Math.sin(angleRad) * vector.speedKnots,
          vNorth: Math.cos(angleRad) * vector.speedKnots
        };
      });

    if (vectors.length < 9) {
      return [] as Array<{
        id: string;
        latitude: number;
        longitude: number;
        radiusNm: number;
        confidence: "high" | "medium" | "low";
        score: number;
        rotation: "clockwise" | "counter-clockwise";
        sampleCount: number;
        meanSpeedKnots: number;
      }>;
    }

    const candidates: Array<{
      id: string;
      latitude: number;
      longitude: number;
      radiusNm: number;
      confidence: "high" | "medium" | "low";
      score: number;
      rotation: "clockwise" | "counter-clockwise";
      sampleCount: number;
      meanSpeedKnots: number;
    }> = [];

    vectors.forEach((center, centerIndex) => {
      const neighbors = vectors
        .map((vector, vectorIndex) => {
          if (vectorIndex === centerIndex) {
            return null;
          }

          const distanceNm = geoDistanceNm(center.latitude, center.longitude, vector.latitude, vector.longitude);
          if (distanceNm < 3.5 || distanceNm > 22) {
            return null;
          }

          const avgLat = (center.latitude + vector.latitude) / 2;
          const east = (vector.longitude - center.longitude) * Math.max(0.1, Math.cos((avgLat * Math.PI) / 180));
          const north = vector.latitude - center.latitude;
          const radialMag = Math.hypot(east, north);
          if (radialMag < 1e-6) {
            return null;
          }

          const radialEast = east / radialMag;
          const radialNorth = north / radialMag;
          const tangentEast = radialNorth;
          const tangentNorth = -radialEast;

          const tangential = (vector.uEast * tangentEast) + (vector.vNorth * tangentNorth);
          const radial = (vector.uEast * radialEast) + (vector.vNorth * radialNorth);

          return {
            distanceNm,
            tangential,
            radial,
            speedKnots: vector.speedKnots
          };
        })
        .filter((entry): entry is { distanceNm: number; tangential: number; radial: number; speedKnots: number } => entry !== null);

      if (neighbors.length < 9) {
        return;
      }

      const tangentialAbs = neighbors.reduce((sum, entry) => sum + Math.abs(entry.tangential), 0);
      if (tangentialAbs < 0.6) {
        return;
      }

      const signedTangential = neighbors.reduce((sum, entry) => sum + entry.tangential, 0);
      const radialAbs = neighbors.reduce((sum, entry) => sum + Math.abs(entry.radial), 0);
      const avgSpeedKnots = neighbors.reduce((sum, entry) => sum + entry.speedKnots, 0) / neighbors.length;

      const coherence = Math.abs(signedTangential) / tangentialAbs;
      const swirlStrength = (tangentialAbs / neighbors.length);
      const swirlStrengthFit = Math.min(1, swirlStrength / 1.3);
      const coverageFit = Math.min(1, neighbors.length / 14);
      const rotationalFit = 1 - Math.min(1, radialAbs / Math.max(0.01, tangentialAbs));

      const score01 = (coherence * 0.42)
        + (swirlStrengthFit * 0.28)
        + (coverageFit * 0.2)
        + (rotationalFit * 0.1);

      if (score01 < 0.66) {
        return;
      }

      const sortedDistances = [...neighbors].map((entry) => entry.distanceNm).sort((a, b) => a - b);
      const medianDistance = sortedDistances[Math.floor(sortedDistances.length / 2)] ?? 9;
      const radiusNm = Math.max(1.6, Math.min(5.4, medianDistance * 0.34));
      const score = Math.round(score01 * 100);
      const confidence: "high" | "medium" | "low" = score >= 78 ? "high" : score >= 64 ? "medium" : "low";

      candidates.push({
        id: `eddy-live-${centerIndex}`,
        latitude: center.latitude,
        longitude: center.longitude,
        radiusNm,
        confidence,
        score,
        rotation: signedTangential >= 0 ? "clockwise" : "counter-clockwise",
        sampleCount: neighbors.length,
        meanSpeedKnots: avgSpeedKnots
      });
    });

    const selected: typeof candidates = [];
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    sorted.forEach((candidate) => {
      if (selected.length >= 8) {
        return;
      }

      const tooClose = selected.some((existing) => {
        const distanceNm = geoDistanceNm(candidate.latitude, candidate.longitude, existing.latitude, existing.longitude);
        const guardNm = Math.max(10, Math.min(candidate.radiusNm, existing.radiusNm) * 1.2);
        return distanceNm < guardNm;
      });

      if (!tooClose) {
        selected.push(candidate);
      }
    });

    return selected;
  }, [oceanCurrentVectors]);

  const tacticalCurrentArrows = useMemo(() => {
    if (oceanCurrentVectors.length === 0) {
      return [] as Array<{
        id: string;
        shaft: [number, number][];
        left: [number, number][];
        right: [number, number][];
        opacity: number;
      }>;
    }

    const bounds = fishingMapBounds ?? {
      minLat: fishingMapCenter[0] - 3,
      maxLat: fishingMapCenter[0] + 3,
      minLng: fishingMapCenter[1] - 4,
      maxLng: fishingMapCenter[1] + 4
    };

    const anchors = oceanCurrentVectors
      .filter((vector) => Number.isFinite(vector.speedKnots) && Number.isFinite(vector.directionDegrees))
      .map((vector) => {
        const bearingRad = (vector.directionDegrees * Math.PI) / 180;
        return {
          latitude: vector.latitude,
          longitude: vector.longitude,
          uEast: Math.sin(bearingRad) * vector.speedKnots,
          vNorth: Math.cos(bearingRad) * vector.speedKnots
        };
      });

    if (anchors.length === 0) {
      return [] as Array<{
        id: string;
        shaft: [number, number][];
        left: [number, number][];
        right: [number, number][];
        opacity: number;
      }>;
    }

    const latSpan = Math.max(0.2, bounds.maxLat - bounds.minLat);
    const lngSpan = Math.max(0.2, bounds.maxLng - bounds.minLng);
    const aspect = Math.max(0.7, Math.min(2.8, lngSpan / latSpan));
    const rows = Math.max(6, Math.min(14, Math.round(Math.sqrt(168 / aspect))));
    const cols = Math.max(8, Math.min(22, Math.round(rows * aspect * 1.35)));
    const influenceRadiusNm = Math.max(70, Math.min(190, Math.hypot(latSpan * 60, lngSpan * 60) * 0.36));

    const arrows: Array<{
      id: string;
      shaft: [number, number][];
      left: [number, number][];
      right: [number, number][];
      opacity: number;
    }> = [];

    for (let r = 0; r < rows; r += 1) {
      const lat = bounds.minLat + ((r + 0.5) / rows) * (bounds.maxLat - bounds.minLat);
      for (let c = 0; c < cols; c += 1) {
        const lng = bounds.minLng + ((c + 0.5) / cols) * (bounds.maxLng - bounds.minLng);

        const neighbors = anchors
          .map((anchor) => ({
            anchor,
            distanceNm: geoDistanceNm(lat, lng, anchor.latitude, anchor.longitude)
          }))
          .filter((entry) => entry.distanceNm <= influenceRadiusNm)
          .sort((a, b) => a.distanceNm - b.distanceNm)
          .slice(0, 8);

        if (neighbors.length < 2) {
          continue;
        }

        let u = 0;
        let v = 0;
        let weightSum = 0;
        neighbors.forEach((entry) => {
          const w = 1 / Math.max(2.5, entry.distanceNm * entry.distanceNm);
          u += entry.anchor.uEast * w;
          v += entry.anchor.vNorth * w;
          weightSum += w;
        });

        if (weightSum <= 0) {
          continue;
        }

        u /= weightSum;
        v /= weightSum;
        const speedKnots = Math.hypot(u, v);
        if (speedKnots <= 0.02) {
          continue;
        }

        const lengthNm = Math.max(0.9, Math.min(3.9, 0.92 + (speedKnots * 1.08)));
        const tail: [number, number] = [lat, lng];
        const tip = offsetPointByNm(tail, u * lengthNm, v * lengthNm);
        const headLen = Math.max(0.3, lengthNm * 0.34);
        const angle = Math.atan2(v, u);
        const left = offsetPointByNm(tip, Math.cos(angle + 2.58) * headLen, Math.sin(angle + 2.58) * headLen);
        const right = offsetPointByNm(tip, Math.cos(angle - 2.58) * headLen, Math.sin(angle - 2.58) * headLen);

        arrows.push({
          id: `flow-field-${r}-${c}`,
          shaft: [tail, tip],
          left: [tip, left],
          right: [tip, right],
          opacity: Math.max(0.46, Math.min(0.9, 0.52 + (speedKnots * 0.24)))
        });
      }
    }

    return arrows;
  }, [fishingMapBounds, fishingMapCenter, oceanCurrentVectors]);

  const mapDataAvailable = typeof navigator !== "undefined" ? navigator.onLine : true;
  const tacticalMapFallback = !mapDataAvailable;
  const noBuoySignalCoverage = oceanBuoys.length === 0;
  const noCurrentVectorCoverage = (enabledOceanOverlays.currents || enabledOceanOverlays.fronts)
    && !loadingOceanCurrentVectors
    && tacticalCurrentArrows.length === 0;
  const hasCachedCurrentVectors = oceanCurrentVectors.length > 0;
  const mapFallbackActive = tacticalMapFallback;

  useEffect(() => {
    if (fishMappingCircles.length === 0) {
      if (selectedFishCircleId !== null) {
        setSelectedFishCircleId(null);
      }
      return;
    }

    if (!selectedFishCircleId || !fishMappingCircles.some((circle) => circle.id === selectedFishCircleId)) {
      const firstCircle = fishMappingCircles[0];
      if (firstCircle) {
        setSelectedFishCircleId(firstCircle.id);
      }
    }
  }, [fishMappingCircles, selectedFishCircleId]);

  function setAllSpeciesVisibility(visible: boolean) {
    setSpeciesVisibility((current) => {
      const next = { ...current };
      pelagicSpecies.forEach((species) => {
        next[species] = visible;
      });
      return next;
    });
  }

  function toggleSpeciesVisibility(species: string, nextValue?: boolean) {
    setSpeciesVisibility((current) => ({
      ...current,
      [species]: typeof nextValue === "boolean" ? nextValue : !current[species]
    }));
  }

  useEffect(() => {
    if (selectedNavId !== "fishing" && selectedNavId !== "weather") {
      return;
    }

    const bounds = fishingMapBounds ?? {
      minLat: fishingMapCenter[0] - 3,
      maxLat: fishingMapCenter[0] + 3,
      minLng: fishingMapCenter[1] - 4,
      maxLng: fishingMapCenter[1] + 4
    };

    let active = true;
    setLoadingOceanBuoys(true);

    loadOceanBuoys({ ...bounds, limit: 72 })
      .then((result) => {
        if (!active) {
          return;
        }

        setOceanBuoys(result.buoys);
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setOceanBuoys([]);
      })
      .finally(() => {
        if (active) {
          setLoadingOceanBuoys(false);
        }
      });

    return () => {
      active = false;
    };
  }, [fishingMapBounds, fishingMapCenter, selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "fishing" || fishingSubview !== "map" || (!enabledOceanOverlays.currents && !enabledOceanOverlays.fronts)) {
      setLoadingOceanCurrentVectors(false);
      return;
    }

    const bounds = fishingMapBounds ?? {
      minLat: fishingMapCenter[0] - 3,
      maxLat: fishingMapCenter[0] + 3,
      minLng: fishingMapCenter[1] - 4,
      maxLng: fishingMapCenter[1] + 4
    };

    let active = true;
    setLoadingOceanCurrentVectors(true);

    loadOceanCurrentVectors({ ...bounds, limit: 42 })
      .then((result) => {
        if (!active) {
          return;
        }

        setOceanCurrentVectors((current) => {
          if (result.vectors.length > 0) {
            return result.vectors;
          }

          return current;
        });
      })
      .catch(() => {
        if (!active) {
          return;
        }

        // Keep last known vectors on intermittent network/provider failures.
      })
      .finally(() => {
        if (active) {
          setLoadingOceanCurrentVectors(false);
        }
      });

    return () => {
      active = false;
    };
  }, [enabledOceanOverlays.currents, enabledOceanOverlays.fronts, fishingMapBounds, fishingMapCenter, fishingSubview, selectedNavId]);

  useEffect(() => {
    if (typeof window === "undefined" || oceanCurrentVectors.length === 0) {
      return;
    }

    window.localStorage.setItem(OCEAN_CURRENT_VECTOR_CACHE_STORAGE_KEY, JSON.stringify(oceanCurrentVectors));
  }, [oceanCurrentVectors]);

  useEffect(() => {
    if (selectedNavId !== "weather") {
      setWeatherRadarFullscreen(false);
    }
  }, [selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "trips") {
      setTripMapFullscreen(false);
    }
  }, [selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "fishing" || fishingSubview !== "map") {
      setFishingMapFullscreen(false);
    }
  }, [fishingSubview, selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "vessel" || vesselSubview !== "bilgebuddy") {
      setBilgeBuddyFullscreen(false);
    }
  }, [selectedNavId, vesselSubview]);

  useEffect(() => {
    if (selectedNavId !== "fishing") {
      return;
    }

    setFishingMapRenderNonce((current) => current + 1);
  }, [selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "fishing" || fishingSubview !== "map") {
      return;
    }

    // Leaflet needs a fresh size pass when the map shell jumps to fullscreen.
    setFishingMapRenderNonce((current) => current + 1);
  }, [fishingMapFullscreen, fishingSubview, selectedNavId]);

  useEffect(() => {
    if (selectedNavId === "fishing") {
      setFishingSubview("map");
      setFishingMapMode("navigate");
      setShowFishingMapSettings(false);
    }
  }, [selectedNavId]);

  useEffect(() => {
    if (fishingSubview !== "map") {
      setShowFishingMapSettings(false);
    }
  }, [fishingSubview]);

  // Request browser geolocation once when the user first opens any map-heavy page.
  useEffect(() => {
    const needsGeoPage = selectedNavId === "fishing" || selectedNavId === "weather" || selectedNavId === "trips";
    if (!needsGeoPage || browserGeoLocation !== null || preferredMapPosition || !navigator.geolocation) {
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setBrowserGeoLocation([pos.coords.latitude, pos.coords.longitude]),
      () => {}
    );
  }, [selectedNavId, browserGeoLocation, preferredMapPosition]);

  // Load independent per-species intelligence whenever buoys or map center changes
  useEffect(() => {
    if (selectedNavId !== "fishing") {
      return;
    }

    let active = true;
    setLoadingSpeciesIntel(true);

    loadSpeciesIntel({
      catches: fishingCatches.map((c) => ({
        species: c.species,
        bait: c.bait,
        timestamp: c.timestamp,
        latitude: c.latitude,
        longitude: c.longitude
      })),
      buoys: oceanBuoys,
      referenceLatitude: fishingMapCenter[0],
      referenceLongitude: fishingMapCenter[1],
      maxRadiusNm: 1600
    })
      .then((result) => {
        if (!active) {
          return;
        }

        setSpeciesIntel(result);
      })
      .catch(() => {
        if (!active) {
          return;
        }
      })
      .finally(() => {
        if (active) {
          setLoadingSpeciesIntel(false);
        }
      });

    return () => {
      active = false;
    };
  }, [fishingCatches, fishingMapCenter, oceanBuoys, selectedNavId]);

  useEffect(() => {
    if (selectedNavId !== "fishing") {
      return;
    }

    const species = selectedFishCircle?.species
      ?? (advisorSpecies === "Auto (map species)" && fishingMapSpeciesFilter !== "All fish"
        ? fishingMapSpeciesFilter
        : advisorSpecies === "Auto (map species)"
          ? quickSpecies
          : advisorSpecies);

    let active = true;
    setRunningFishingAdvisor(true);

    requestFishingAdvisor({
      species,
      catches: fishingMapFilteredCatches.map((catchItem) => ({
        species: catchItem.species,
        bait: catchItem.bait,
        timestamp: catchItem.timestamp,
        latitude: catchItem.latitude,
        longitude: catchItem.longitude
      })),
      buoys: oceanBuoys,
      referenceLatitude: fishingMapCenter[0],
      referenceLongitude: fishingMapCenter[1],
      maxRadiusNm: 1400
    })
      .then((result) => {
        if (!active) {
          return;
        }

        setFishingAdvisor(result);
        setFishingAdvisorError(null);
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setFishingAdvisorError("Fishing advisor unavailable");
      })
      .finally(() => {
        if (active) {
          setRunningFishingAdvisor(false);
        }
      });

    return () => {
      active = false;
    };
  }, [advisorSpecies, fishingMapFilteredCatches, fishingMapSpeciesFilter, oceanBuoys, quickSpecies, selectedFishCircle, selectedNavId]);

  const fishingReport = useMemo(() => {
    if (fishingCatches.length === 0) {
      return {
        headline: "No logged pelagic bites yet",
        summary: "Quick log your first catch to start building an offshore pattern report based on species, bait, and conditions.",
        suggestions: [
          "Start with a quick species tap and auto-location log.",
          "Pair each log with bait and a photo so the report becomes more valuable over time.",
          "Use the water temp and wind values from the weather tile to compare conditions."
        ],
        strongestPattern: "No history yet"
      };
    }

    const speciesCounts = new Map<string, number>();
    const baitCounts = new Map<string, number>();

    fishingCatches.forEach((catchItem) => {
      speciesCounts.set(catchItem.species, (speciesCounts.get(catchItem.species) ?? 0) + 1);
      baitCounts.set(catchItem.bait, (baitCounts.get(catchItem.bait) ?? 0) + 1);
    });

    const strongestSpeciesEntry = [...speciesCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["No species", 0] as const;
    const strongestBaitEntry = [...baitCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["No bait", 0] as const;
    const mostRecent = fishingCatches[0] ?? null;

    return {
      headline: `${strongestSpeciesEntry[0]} is your strongest offshore pattern`,
      summary: `${strongestSpeciesEntry[0]} has been your most-logged pelagic species, with ${strongestBaitEntry[0]} leading your bait pattern. Keep your next drift or troll in the same window as ${mostRecent ? new Date(mostRecent.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "your last log"} when the water and wind are similar to current conditions.`,
      suggestions: [
        `Focus on ${strongestSpeciesEntry[0]} when conditions stay near ${activeSummary.weather.waterTemp} and ${activeSummary.weather.wind}.`,
        `Keep ${strongestBaitEntry[0]} ready near your best offshore lanes and structure edges.`,
        "Compare the last few catches to the tide and current before moving to a new patch."
      ],
      strongestPattern: `${strongestSpeciesEntry[0]} + ${strongestBaitEntry[0]}`
    };
  }, [activeSummary.weather.waterTemp, activeSummary.weather.wind, fishingCatches]);

  async function captureCurrentLocation(): Promise<{ latitude: number | null; longitude: number | null; label: string }> {
    if (!navigator.geolocation) {
      return { latitude: null, longitude: null, label: "GPS unavailable" };
    }

    return await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const latitude = position.coords.latitude;
          const longitude = position.coords.longitude;
          resolve({
            latitude,
            longitude,
            label: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
          });
        },
        () => {
          resolve({ latitude: null, longitude: null, label: "GPS fix unavailable" });
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    });
  }

  async function logQuickCatch() {
    setLoggingCatch(true);
    const location = await captureCurrentLocation();
    setCatchLocation(location);
    const parsedSize = Number.parseFloat(quickFishSizeInches);
    const fishSizeInches = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : null;
    const baitLabel = `${quickLureType} | ${quickLureColor}`;

    const record: FishingCatch = {
      id: `${Date.now()}`,
      species: quickSpecies,
      bait: baitLabel,
      lureType: quickLureType,
      lureColor: quickLureColor,
      fishSizeInches,
      notes: "Quick log from Palmer Lou shell.",
      timestamp: new Date().toISOString(),
      latitude: location.latitude,
      longitude: location.longitude,
      locationLabel: location.label,
      photo: null
    };

    setFishingCatches((current) => [record, ...current].slice(0, 12));
    setFishingMapDateFilter("all");
    setFishingMapSpeciesFilter("All fish");
    setFishingMapLureFilter("All lures");
    setFishingSubview("map");
    setQuickFishSizeInches("");
    setCatchLocation({ latitude: null, longitude: null, label: "GPS not locked" });
    setLoggingCatch(false);
  }

  async function refreshUpdateStatus() {
    try {
      const update = await loadVersionStatus();
      setSummary((current) => (current ? { ...current, update } : current));
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }

  async function launchAppTarget(target: LaunchTarget, section: "streaming" | "music") {
    if (section === "streaming") {
      setSelectedStreamId(target.id);
    } else {
      setSelectedMusicId(target.id);
    }

    setSelectedAppId(section);
    setLaunching(true);

    try {
      if (bluetoothState.config.routeConfigured && bluetoothState.connected) {
        // Fire-and-forget audio routing; do not block launch on it
        void sendBluetoothAction("route-audio").catch(() => undefined);
      }
      const launchState = await sendLaunchRequest({
        appId: target.id,
        name: target.name,
        launchUrl: target.launchUrl,
        launchLabel: target.launchLabel,
        requestSource: remoteMode ? "remote" : "kiosk"
      });
      setLauncherState(launchState);
      setLastRestorableAppId(target.id);
      if (remoteMode) {
        const launchBlocked = launchState.runtime === "Blocked" || launchState.status === "Launch command required";
        vibrateRemote(launchBlocked ? [40, 40, 40] : [16, 30, 16]);
      }
      setOnline(true);
    } catch {
      if (!remoteMode) {
        setLauncherState((current) => ({
          ...current,
          appId: target.id,
          name: target.name,
          subtitle: target.launchLabel,
          runtime: "Touchscreen launcher",
          status: "Launch request failed",
          message: `${target.name} could not be launched on the touchscreen host. Check launcher command configuration and backend connectivity.`,
          launchMethod: "Touchscreen request",
          startedAt: new Date().toISOString()
        }));
      } else {
        setLauncherState((current) => ({
          ...current,
          appId: target.id,
          name: target.name,
          subtitle: target.launchLabel,
          runtime: "Remote",
          status: "Launch request failed",
          message: `${target.name} could not be launched on the touchscreen host. Check backend reachability and launch command configuration.`,
          launchMethod: "Remote request",
          startedAt: new Date().toISOString()
        }));
        vibrateRemote([40, 40, 40]);
      }
      setOnline(false);
    } finally {
      setLaunching(false);
    }
  }

  async function handleBluetoothAction(action: "pair" | "reconnect" | "route-audio" | "disconnect") {
    setSelectedAppId("bluetooth");
    try {
      const state = await sendBluetoothAction(action);
      setBluetoothState(state);
      setOnline(true);
    } catch {
      setBluetoothState((current) => ({
        ...current,
        lastAction: action,
        lastError: "Bluetooth command failed locally"
      }));
      setOnline(false);
    }
  }

  async function handleBluetoothScan() {
    setBtScanning(true);
    setBtScanResults([]);
    try {
      const result = await scanBluetoothDevices();
      setBtScanResults(result.devices);
    } catch {
      setBtScanResults([]);
    } finally {
      setBtScanning(false);
    }
  }

  async function handleSetBtDevice(mac: string, name: string) {
    setRunningBtWorkflowId(mac);
    try {
      const paired = await sendBluetoothAction("pair", { mac, name });
      setBluetoothState(paired);

      if (paired.connected && paired.config.routeConfigured) {
        const routed = await sendBluetoothAction("route-audio").catch(() => paired);
        setBluetoothState(routed);
      }

      const refreshed = await loadBluetoothState();
      setBluetoothState(refreshed);
      setBtScanResults([]);
      setOnline(true);
    } catch {
      const refreshed = await loadBluetoothState().catch(() => null);
      if (refreshed) { setBluetoothState(refreshed); }
      setOnline(false);
    } finally {
      setRunningBtWorkflowId(null);
    }
  }

  async function handleForgetBtDevice() {
    setRunningBtWorkflowId("forget-active");
    try {
      const state = await sendBluetoothAction("disconnect");
      setBluetoothState(state);
      const refreshed = await loadBluetoothState();
      setBluetoothState(refreshed);
      setOnline(true);
    } catch {
      const refreshed = await loadBluetoothState().catch(() => null);
      if (refreshed) {
        setBluetoothState(refreshed);
      }
      setOnline(false);
    } finally {
      setRunningBtWorkflowId(null);
    }
  }

  async function handleBluetoothDiagnostics() {
    setRunningBluetoothDiagnostics(true);

    try {
      const diagnostics = await runBluetoothDiagnostics();
      setBluetoothDiagnostics(diagnostics);
      const latestState = await loadBluetoothState();
      setBluetoothState(latestState);
      setOnline(true);
    } catch {
      setBluetoothDiagnostics({
        checkedAt: new Date().toISOString(),
        ready: false,
        checks: [
          {
            id: "diagnostics-call",
            ok: false,
            detail: "Failed to run Bluetooth diagnostics"
          }
        ]
      });
      setOnline(false);
    } finally {
      setRunningBluetoothDiagnostics(false);
    }
  }

  async function handleWifiScan() {
    setWifiScanning(true);
    setWifiStatus(null);
    setWifiHasManualScan(true);
    try {
      const result = await loadWifiNetworks(true);
      setWifiNetworks((current) => {
        if (result.networks.length === 0 && current.some((network) => network.connected)) {
          return current;
        }

        return result.networks;
      });
      setOnline(true);
    } catch {
      setWifiStatus("Wi‑Fi scan unavailable");
      setOnline(false);
    } finally {
      setWifiScanning(false);
    }
  }

  async function handleWifiJoin(ssid: string, password?: string) {
    setWifiJoining(ssid);
    setWifiStatus(null);
    try {
      const cleanedPassword = password?.trim() ?? "";
      const result = await joinWifiNetwork(ssid, cleanedPassword || undefined);
      setWifiStatus(result.message);
      const refreshed = await loadWifiNetworks().catch(() => null);
      if (refreshed) {
        setWifiNetworks(refreshed.networks);
      } else if (result.connected) {
        setWifiNetworks((current) => current.map((network) => ({
          ...network,
          connected: network.ssid === ssid
        })));
      }
      setOnline(result.success);
    } catch {
      setWifiStatus("Unable to connect to this Wi‑Fi network");
      setOnline(false);
    } finally {
      setWifiJoining(null);
    }
  }

  async function handleWifiJoinClick(network: WifiNetwork) {
    if (network.connected) {
      await handleWifiJoin(network.ssid);
      return;
    }

    setWifiJoinPassword("");
    setWifiJoinDialog({ ssid: network.ssid, security: network.security });
  }

  async function submitWifiJoinDialog() {
    if (!wifiJoinDialog) {
      return;
    }

    const target = wifiJoinDialog;
    setWifiJoinDialog(null);
    await handleWifiJoin(target.ssid, wifiJoinPassword);
  }

  async function handleWifiDisconnect() {
    setWifiDisconnecting(true);
    setWifiStatus(null);
    const connectedSsid = wifiNetworks.find((network) => network.connected)?.ssid;

    try {
      const result = await disconnectWifiNetwork(connectedSsid);
      setWifiStatus(result.message);
      const refreshed = await loadWifiNetworks();
      setWifiNetworks(refreshed.networks);
      setOnline(result.success);
    } catch {
      setWifiStatus("Unable to disconnect from the current Wi‑Fi network");
      setOnline(false);
    } finally {
      setWifiDisconnecting(false);
    }
  }

  async function refreshRemoteOpsStatus() {
    try {
      const [accessStatus, updateStatus] = await Promise.all([loadRemoteAccessStatus(), loadRemoteUpdateStatus()]);
      setRemoteAccessStatus(accessStatus);
      setRemoteUpdateStatus(updateStatus);
      setRemoteOpsError(null);
      setOnline(true);
    } catch {
      setRemoteOpsError("Remote operations status unavailable");
      setOnline(false);
    }
  }

  async function handleRemoteTunnelAction(action: "start" | "stop" | "restart" | "status") {
    setRunningRemoteTunnelAction(action);

    try {
      const status = await sendRemoteTunnelAction(action);
      setRemoteAccessStatus(status);
      setRemoteOpsError(null);
      setOnline(true);
    } catch {
      setRemoteOpsError("Failed to run remote tunnel action");
      setOnline(false);
    } finally {
      setRunningRemoteTunnelAction(null);
    }
  }

  async function handleRunRemoteUpdate() {
    setRunningRemoteUpdate(true);

    try {
      const status = await runRemoteUpdateApply();
      setRemoteUpdateStatus(status);
      setRemoteOpsError(null);
      setOnline(true);
      await refreshUpdateStatus();
    } catch {
      setRemoteOpsError("Failed to run remote update command");
      setOnline(false);
    } finally {
      setRunningRemoteUpdate(false);
    }
  }

  function applyFishingMapPreset(preset: "search" | "temp-edge" | "structure" | "currents") {
    if (preset === "search") {
      setFishingBasemap("nautical");
      setFishingMapViewMode("clusters");
      setFishingMapOverlayOpacity(34);
      setEnabledOceanOverlays({ sst: false, chlorophyll: false, currents: false, contours: true, fronts: false });
      return;
    }

    if (preset === "temp-edge") {
      setFishingBasemap("standard");
      setFishingMapViewMode("heatmap");
      setFishingMapOverlayOpacity(24);
      setEnabledOceanOverlays({ sst: true, chlorophyll: false, currents: true, contours: false, fronts: false });
      return;
    }

    if (preset === "structure") {
      setFishingBasemap("nautical");
      setFishingMapViewMode("points");
      setFishingMapOverlayOpacity(46);
      setEnabledOceanOverlays({ sst: false, chlorophyll: false, currents: false, contours: true, fronts: false });
      return;
    }

    setFishingBasemap("standard");
    setFishingMapViewMode("clusters");
    setFishingMapOverlayOpacity(34);
    setEnabledOceanOverlays({ sst: false, chlorophyll: false, currents: true, contours: false, fronts: false });
  }

  function applySpeciesFishingPreset(species: string) {
    const profile = (SPECIES_FISHMAP_PROFILES[species] ?? SPECIES_FISHMAP_PROFILES.Tuna) as SpeciesFishProfile;
    const frontPreference = SPECIES_FRONT_PREFERENCE[species] ?? { sst: 1, convergence: 1 };

    setFishingMapSpeciesFilter(species);
    setAdvisorSpecies(species);
    setFishingBasemap("nautical");
    setFishingMapViewMode("clusters");
    setFishingMapOverlayOpacity(32);
    setEnabledOceanOverlays({
      sst: false,
      chlorophyll: false,
      currents: frontPreference.convergence >= 1.05,
      contours: true,
      fronts: false
    });

    const matchingCircle = fishMappingCircles.find((circle) => circle.species === species);
    if (matchingCircle) {
      setSelectedFishCircleId(matchingCircle.id);
    }
  }

  function applyFishingMapMode(mode: FishingMapMode) {
    setFishingMapMode(mode);
    setShowFishingMapSettings(false);

    if (mode === "navigate") {
      setShowSpeciesHotspots(false);
      setFishingMapOverlayOpacity((current) => Math.min(current, 26));
      setEnabledOceanOverlays((current) => ({
        ...current,
        sst: false,
        chlorophyll: false,
        currents: true,
        contours: true,
        fronts: false
      }));
      return;
    }

    setShowSpeciesHotspots(true);
    setFishingMapOverlayOpacity((current) => Math.max(current, 28));
    setEnabledOceanOverlays((current) => ({
      ...current,
      sst: false,
      chlorophyll: false,
      currents: true,
      contours: true,
      fronts: true
    }));
  }

  function centerFishingMapOnBoat() {
    const boatPosition = mapRecentCenterPosition;

    if (boatPosition) {
      setFishingMapRenderNonce((current) => current + 1);
      return;
    }

    if (!navigator.geolocation) {
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextCenter: [number, number] = [position.coords.latitude, position.coords.longitude];
        setBrowserGeoLocation(nextCenter);
        setFishingMapRenderNonce((current) => current + 1);
      },
      () => {}
    );
  }

  const fishingMapViewportCenter = useMemo<[number, number] | null>(() => {
    if (!fishingMapBounds) {
      return null;
    }

    return [
      (fishingMapBounds.minLat + fishingMapBounds.maxLat) / 2,
      (fishingMapBounds.minLng + fishingMapBounds.maxLng) / 2
    ];
  }, [fishingMapBounds]);

  const isCenterNearRecentTarget = useCallback((center: [number, number] | null, thresholdDeg = 0.0025) => {
    if (!mapRecentCenterPosition || !center) {
      return false;
    }

    return Math.hypot(center[0] - mapRecentCenterPosition.latitude, center[1] - mapRecentCenterPosition.longitude) <= thresholdDeg;
  }, [mapRecentCenterPosition]);

  const shouldShowTripCenterButton = Boolean(mapRecentCenterPosition) && !isCenterNearRecentTarget(tripMapCenter);

  useEffect(() => {
    if (selectedNavId !== "trips") {
      return;
    }

    if (selectedTripId) {
      setTripMapFollowRecent(false);
    }
  }, [selectedNavId, selectedTripId]);

  function centerWeatherMapOnBoat() {
    if (mapRecentCenterPosition) {
      setWeatherMapRenderNonce((current) => current + 1);
      return;
    }

    if (!navigator.geolocation) {
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setBrowserGeoLocation([position.coords.latitude, position.coords.longitude]);
        setWeatherMapRenderNonce((current) => current + 1);
      },
      () => {}
    );
  }

  function centerTripMapOnBoat() {
    if (mapRecentCenterPosition) {
      setTripMapFollowRecent(true);
      setTripMapRenderNonce((current) => current + 1);
      return;
    }

    if (!navigator.geolocation) {
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setBrowserGeoLocation([position.coords.latitude, position.coords.longitude]);
        setTripMapFollowRecent(true);
        setTripMapRenderNonce((current) => current + 1);
      },
      () => {}
    );
  }

  function setMapModeNorth(recenter: "weather" | "trips" | "fishing" | "homeport") {
    setMapHeadingMode("north");

    if (recenter === "weather") {
      setWeatherMapRenderNonce((current) => current + 1);
      return;
    }

    if (recenter === "trips") {
      setTripMapFollowRecent(true);
      setTripMapRenderNonce((current) => current + 1);
      return;
    }

    if (recenter === "fishing") {
      setFishingMapRenderNonce((current) => current + 1);
    }
  }

  function setMapModeCourse(recenter: "weather" | "trips" | "fishing" | "homeport") {
    setMapHeadingMode("course");

    if (recenter === "weather") {
      setWeatherMapRenderNonce((current) => current + 1);
      return;
    }

    if (recenter === "trips") {
      setTripMapFollowRecent(true);
      setTripMapRenderNonce((current) => current + 1);
      return;
    }

    if (recenter === "fishing") {
      setFishingMapRenderNonce((current) => current + 1);
    }
  }

  function toggleTripMapHeadingMode() {
    if (mapHeadingMode === "north") {
      setMapModeCourse("trips");
      return;
    }

    setMapModeNorth("trips");
  }

  async function executeRemoteControl(
    action: RemoteControlAction,
    repeat = 1,
    options: { suppressFeedback?: boolean; suppressBusyIndicator?: boolean } = {}
  ) {
    if (!options.suppressBusyIndicator) {
      setRunningRemoteControlAction(action);
    }

    try {
      if (action === "home") {
        const homeState = await sendReturnHomeRequest();
        setLauncherState(homeState);
        if (!options.suppressFeedback) {
          setRemoteControlStatus("HOME returned to Palmer Lou");
          vibrateRemote([10, 20, 10]);
        }
        return;
      }

      const result = await sendRemoteControlAction(action, repeat, launcherState.appId);
      if (!options.suppressFeedback) {
        setRemoteControlStatus(result.success ? `${result.action.toUpperCase()} sent to touchscreen` : `${result.action.toUpperCase()} failed`);
        vibrateRemote(result.success ? [10, 20, 10] : [36, 36, 36]);
      }
    } catch {
      if (!options.suppressFeedback) {
        setRemoteControlStatus(`${action.toUpperCase()} failed`);
        vibrateRemote([36, 36, 36]);
      }
    } finally {
      if (!options.suppressBusyIndicator) {
        setRunningRemoteControlAction(null);
      }
    }
  }

  function handleRemoteControl(action: RemoteControlAction, repeat = 1) {
    const run = async () => {
      await executeRemoteControl(action, repeat);
    };

    remoteControlQueueRef.current = remoteControlQueueRef.current
      .catch(() => undefined)
      .then(run);

    return remoteControlQueueRef.current;
  }

  function clearRemoteHoldTimers() {
    if (typeof window === "undefined") {
      return;
    }

    if (remoteHoldDelayTimerRef.current !== null) {
      window.clearTimeout(remoteHoldDelayTimerRef.current);
      remoteHoldDelayTimerRef.current = null;
    }

    if (remoteHoldIntervalTimerRef.current !== null) {
      window.clearInterval(remoteHoldIntervalTimerRef.current);
      remoteHoldIntervalTimerRef.current = null;
    }
  }

  function beginRemoteHold(action: RemoteControlAction) {
    if (typeof window === "undefined") {
      return;
    }

    if (remoteHoldActionRef.current === action) {
      return;
    }

    clearRemoteHoldTimers();
    remoteHoldActionRef.current = action;
    void handleRemoteControl(action);

    remoteHoldDelayTimerRef.current = window.setTimeout(() => {
      if (remoteHoldActionRef.current !== action) {
        return;
      }

      remoteHoldIntervalTimerRef.current = window.setInterval(() => {
        if (remoteHoldActionRef.current !== action) {
          return;
        }

        void handleRemoteControl(action);
      }, REMOTE_HOLD_REPEAT_MS);
    }, REMOTE_HOLD_INITIAL_DELAY_MS);
  }

  function endRemoteHold() {
    remoteHoldActionRef.current = null;
    clearRemoteHoldTimers();
  }

  function makeHoldHandlers(action: RemoteControlAction) {
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        beginRemoteHold(action);
      },
      onPointerUp: () => {
        endRemoteHold();
      },
      onPointerLeave: () => {
        endRemoteHold();
      },
      onPointerCancel: () => {
        endRemoteHold();
      },
      onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
        // Keyboard-triggered click has detail 0; keep it accessible.
        if (event.detail === 0) {
          void handleRemoteControl(action);
        }
      }
    };
  }

  function resetTrackpadGesture() {
    trackpadPointerIdRef.current = null;
    trackpadLastPointRef.current = null;
    trackpadAccumulatorRef.current = { x: 0, y: 0 };
    trackpadGestureRef.current = { startedAt: 0, movedPx: 0 };
    trackpadMoveQueueRef.current = { x: 0, y: 0 };
  }

  function flushTrackpadMoveQueue() {
    if (trackpadMoveSendingRef.current) {
      return;
    }

    const pending = trackpadMoveQueueRef.current;
    if (pending.x === 0 && pending.y === 0) {
      return;
    }

    let action: RemoteControlAction;
    let repeats: number;

    if (Math.abs(pending.x) >= Math.abs(pending.y)) {
      action = pending.x >= 0 ? "right" : "left";
      repeats = Math.max(1, Math.min(8, Math.abs(pending.x)));
      pending.x += (pending.x > 0 ? -1 : 1) * repeats;
    } else {
      action = pending.y >= 0 ? "down" : "up";
      repeats = Math.max(1, Math.min(8, Math.abs(pending.y)));
      pending.y += (pending.y > 0 ? -1 : 1) * repeats;
    }

    trackpadMoveSendingRef.current = true;
    void executeRemoteControl(action, repeats, { suppressFeedback: true, suppressBusyIndicator: true })
      .finally(() => {
        trackpadMoveSendingRef.current = false;
        flushTrackpadMoveQueue();
      });
  }

  function queueTrackpadMove(action: RemoteControlAction, repeats: number) {
    const boundedRepeats = Math.max(1, Math.min(8, Math.floor(repeats)));
    const pending = trackpadMoveQueueRef.current;

    if (action === "right") {
      pending.x += boundedRepeats;
    } else if (action === "left") {
      pending.x -= boundedRepeats;
    } else if (action === "down") {
      pending.y += boundedRepeats;
    } else if (action === "up") {
      pending.y -= boundedRepeats;
    }

    // Avoid runaway queues during long drags on high-latency links.
    pending.x = Math.max(-140, Math.min(140, pending.x));
    pending.y = Math.max(-140, Math.min(140, pending.y));

    flushTrackpadMoveQueue();
  }

  function dispatchTrackpadFromAccumulator() {
    const dragStepPx = trackpadSensitivity === "fine"
      ? Math.round(REMOTE_TRACKPAD_DRAG_STEP_PX * 1.45)
      : trackpadSensitivity === "fast"
        ? Math.round(REMOTE_TRACKPAD_DRAG_STEP_PX * 0.58)
        : REMOTE_TRACKPAD_DRAG_STEP_PX;

    const current = trackpadAccumulatorRef.current;
    const xSteps = Math.floor(Math.abs(current.x) / dragStepPx);
    const ySteps = Math.floor(Math.abs(current.y) / dragStepPx);

    if (xSteps > 0) {
      const horizontalAction: RemoteControlAction = current.x > 0 ? "right" : "left";
      const repeats = Math.max(1, Math.min(8, xSteps));
      current.x += (current.x > 0 ? -1 : 1) * repeats * dragStepPx;
      queueTrackpadMove(horizontalAction, repeats);
    }

    if (ySteps > 0) {
      const verticalAction: RemoteControlAction = current.y > 0 ? "down" : "up";
      const repeats = Math.max(1, Math.min(8, ySteps));
      current.y += (current.y > 0 ? -1 : 1) * repeats * dragStepPx;
      queueTrackpadMove(verticalAction, repeats);
    }
  }

  function cycleTrackpadSensitivity() {
    setTrackpadSensitivity((current) => {
      if (current === "fine") {
        return "normal";
      }

      if (current === "normal") {
        return "fast";
      }

      return "fine";
    });
  }

  function handleTrackpadPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some synthetic/test pointer events do not support capture.
    }
    trackpadPointerIdRef.current = event.pointerId;
    trackpadLastPointRef.current = { x: event.clientX, y: event.clientY };
    trackpadAccumulatorRef.current = { x: 0, y: 0 };
    trackpadGestureRef.current = { startedAt: Date.now(), movedPx: 0 };
  }

  function handleTrackpadPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (trackpadPointerIdRef.current !== event.pointerId) {
      return;
    }

    const last = trackpadLastPointRef.current;
    if (!last) {
      return;
    }

    event.preventDefault();
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    trackpadLastPointRef.current = { x: event.clientX, y: event.clientY };
    trackpadGestureRef.current.movedPx += Math.hypot(dx, dy);
    trackpadAccumulatorRef.current = {
      x: trackpadAccumulatorRef.current.x + dx,
      y: trackpadAccumulatorRef.current.y + dy
    };
    dispatchTrackpadFromAccumulator();
  }

  function handleTrackpadPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (trackpadPointerIdRef.current !== event.pointerId) {
      return;
    }

    event.preventDefault();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore capture release errors when capture was never acquired.
    }

    const durationMs = Date.now() - trackpadGestureRef.current.startedAt;
    const movedPx = trackpadGestureRef.current.movedPx;
    const shouldClick = durationMs <= REMOTE_TRACKPAD_TAP_MAX_MS && movedPx <= REMOTE_TRACKPAD_TAP_MAX_TRAVEL_PX;
    resetTrackpadGesture();

    if (shouldClick) {
      void handleRemoteControl("select");
    }
  }

  function handleTrackpadPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (trackpadPointerIdRef.current !== event.pointerId) {
      return;
    }

    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore capture release errors when capture was never acquired.
    }

    resetTrackpadGesture();
  }

  async function handleRemoteType(text: string) {
    try {
      await sendRemoteTypeRequest(text);
      vibrateRemote([8]);
    } catch {
      vibrateRemote([36, 36]);
    }
  }

  function renderRemoteControlPad() {
    if (!remoteMode) {
      return null;
    }

    const KB_ROWS = [
      ["q","w","e","r","t","y","u","i","o","p"],
      ["a","s","d","f","g","h","j","k","l"],
      ["z","x","c","v","b","n","m"]
    ];

    return (
      <section className="panel remote-control-panel" aria-label="Touchscreen remote controls">
        <div className="remote-control-panel__header">
          <p className="panel__eyebrow">Touchscreen remote</p>
          <strong>{remoteControlStatus}</strong>
        </div>

        <div className="remote-control-grid" role="group" aria-label="Directional and media controls">
          <button type="button" className="theme-toggle remote-btn remote-btn--ghost" onClick={() => void handleRemoteControl("home")}>Home</button>
          <button type="button" className="theme-toggle remote-btn" {...makeHoldHandlers("up")}>▲</button>
          <button type="button" className="theme-toggle remote-btn remote-btn--ghost" onClick={() => void handleRemoteControl("mute")}>Mute</button>

          <button type="button" className="theme-toggle remote-btn" {...makeHoldHandlers("left")}>◀</button>
          <button type="button" className="theme-toggle theme-toggle--primary remote-btn remote-btn--ok" onClick={() => void handleRemoteControl("select")}>OK</button>
          <button type="button" className="theme-toggle remote-btn" {...makeHoldHandlers("right")}>▶</button>

          <button type="button" className="theme-toggle remote-btn remote-btn--ghost" onClick={() => void handleRemoteControl("back")}>Back</button>
          <button type="button" className="theme-toggle remote-btn" {...makeHoldHandlers("down")}>▼</button>
          <button type="button" className="theme-toggle remote-btn remote-btn--ghost" onClick={() => void handleRemoteControl("playpause")}>⏯</button>
        </div>

        <div className="remote-control-row" role="group" aria-label="Volume controls">
          <button type="button" className="theme-toggle remote-btn" onClick={() => void handleRemoteControl("voldown", 2)} disabled={runningRemoteControlAction !== null}>Vol −</button>
          <button type="button" className="theme-toggle remote-btn" onClick={() => void handleRemoteControl("volup", 2)} disabled={runningRemoteControlAction !== null}>Vol +</button>
        </div>

        <div
          className="remote-trackpad"
          role="button"
          tabIndex={0}
          aria-label="Trackpad. Drag to move cursor. Tap to click."
          onPointerDown={handleTrackpadPointerDown}
          onPointerMove={handleTrackpadPointerMove}
          onPointerUp={handleTrackpadPointerUp}
          onPointerCancel={handleTrackpadPointerCancel}
          onPointerLeave={handleTrackpadPointerCancel}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void handleRemoteControl("select");
            }
          }}
        >
          <span className="remote-trackpad__label">Trackpad</span>
          <span className="remote-trackpad__hint">Drag to move cursor · Tap to click</span>
        </div>

        <div className="keyboard-toggle-row remote-control-row">
          <button
            type="button"
            className="theme-toggle remote-btn"
            onClick={cycleTrackpadSensitivity}
            aria-label="Toggle trackpad speed"
          >
            Trackpad: {trackpadSensitivity === "fine" ? "Fine" : trackpadSensitivity === "fast" ? "Fast" : "Normal"}
          </button>
          <button type="button" className={`theme-toggle remote-btn ${showKeyboard ? "theme-toggle--primary" : ""}`}
            onClick={() => setShowKeyboard((v) => !v)}>
            {showKeyboard ? "Hide keyboard" : "⌨ Keyboard"}
          </button>
          {showKeyboard ? (
            <button type="button" className={`theme-toggle remote-btn ${keyboardShift ? "keyboard-key--shift-on" : ""}`}
              onClick={() => setKeyboardShift((v) => !v)}>
              ⇧ Shift
            </button>
          ) : null}
        </div>

        {showKeyboard ? (
          <div className="keyboard-panel">
            {KB_ROWS.map((row, ri) => (
              <div key={ri} className="keyboard-row">
                {row.map((k) => (
                  <button key={k} type="button" className="keyboard-key"
                    onClick={() => { void handleRemoteType(keyboardShift ? k.toUpperCase() : k); setKeyboardShift(false); }}>
                    {keyboardShift ? k.toUpperCase() : k}
                  </button>
                ))}
              </div>
            ))}
            <div className="keyboard-row">
              <button type="button" className="keyboard-key keyboard-key--wide" onClick={() => void handleRemoteControl("backspace")}>⌫</button>
              <button type="button" className="keyboard-key keyboard-key--wide" style={{ flex: 4, maxWidth: 200 }} onClick={() => void handleRemoteType(" ")}>space</button>
              <button type="button" className="keyboard-key keyboard-key--wide" onClick={() => void handleRemoteControl("select")}>↵</button>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  function renderWeatherRadarMap(mapClassName: string) {
    const weatherCenterLat = mapRecentCenterPosition?.latitude ?? fishingMapCenter[0];
    const weatherCenterLon = mapRecentCenterPosition?.longitude ?? fishingMapCenter[1];
    const weatherCenter: [number, number] = [weatherCenterLat, weatherCenterLon];

    return (
      <MapContainer
        key={`weather-map-${weatherMapRenderNonce}`}
        center={weatherCenter}
        zoom={6}
        minZoom={4}
        maxZoom={WEATHER_RADAR_MAX_ZOOM}
        className={mapClassName}
        scrollWheelZoom
        attributionControl={false}
      >
        <WeatherRadarRuntimeGuard center={weatherCenter} />
        <MapCenterReporter onCenterChange={setWeatherMapCenter} />
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {stormRadarTileUrl ? (
          <>
            {stormRadarPlaying && stormRadarPreviousTileUrl ? (
              <TileLayer
                url={stormRadarPreviousTileUrl}
                opacity={0.34}
                zIndex={459}
                maxNativeZoom={WEATHER_RADAR_MAX_NATIVE_ZOOM}
                maxZoom={WEATHER_RADAR_MAX_ZOOM}
                errorTileUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgBqWcN0AAAAASUVORK5CYII="
              />
            ) : null}
            <TileLayer
              url={stormRadarTileUrl}
              opacity={0.86}
              zIndex={460}
              maxNativeZoom={WEATHER_RADAR_MAX_NATIVE_ZOOM}
              maxZoom={WEATHER_RADAR_MAX_ZOOM}
              errorTileUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgBqWcN0AAAAASUVORK5CYII="
            />
          </>
        ) : (
          <WMSTileLayer
            url={WEATHER_RADAR_WMS_URL}
            layers={WEATHER_RADAR_WMS_LAYER}
            format="image/png"
            transparent
            opacity={0.7}
            zIndex={450}
            maxNativeZoom={6}
            maxZoom={WEATHER_RADAR_MAX_ZOOM}
          />
        )}
        {WEATHER_RANGE_RINGS_NM.map((ringNm) => (
          <Circle
            key={`weather-range-${ringNm}`}
            center={[weatherCenterLat, weatherCenterLon]}
            radius={ringNm * 1852}
            pathOptions={{
              color: ringNm >= 40 ? "#f4c86a" : "#59baff",
              dashArray: "5 7",
              fillOpacity: 0,
              weight: 1
            }}
          >
            <Tooltip direction="center" permanent>{`${ringNm} NM`}</Tooltip>
          </Circle>
        ))}
        {nearbyMarineBuoys.map((buoy) => {
          const waveFeet = buoy.waveHeightM === null ? null : buoy.waveHeightM * 3.28084;
          const windKnots = buoy.windSpeedMps === null ? null : buoy.windSpeedMps * 1.94384;
          const distanceFromVesselNm = geoDistanceNm(weatherCenterLat, weatherCenterLon, buoy.latitude, buoy.longitude);
          const color = waveFeet === null
            ? "#89a3bc"
            : waveFeet >= 7
              ? "#ff6f6f"
              : waveFeet >= 4.5
                ? "#f4c86a"
                : "#6ad8a2";

          return (
            <CircleMarker
              key={`${buoy.stationId}-${buoy.observedAt}`}
              center={[buoy.latitude, buoy.longitude]}
              radius={waveFeet === null ? 5 : Math.min(13, Math.max(5, waveFeet * 1.2))}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.6,
                weight: 1
              }}
            >
              <Tooltip direction="top" offset={[0, -8]}>
                <div>{buoy.stationId}</div>
                <div>Wave {waveFeet === null ? "--" : `${waveFeet.toFixed(1)} ft`}</div>
                <div>Wind {windKnots === null ? "--" : `${windKnots.toFixed(1)} kt`}</div>
                <div>{`${Math.round(distanceFromVesselNm)} NM from vessel`}</div>
              </Tooltip>
            </CircleMarker>
          );
        })}
        {preferredMapPosition ? (
          <CircleMarker
            center={[preferredMapPosition.latitude, preferredMapPosition.longitude]}
            radius={6}
            pathOptions={{
              color: "rgba(255, 255, 255, 0.95)",
              weight: 2,
              fillColor: "#5fd0ff",
              fillOpacity: 0.95
            }}
          >
            <Tooltip direction="top" offset={[0, -4]} opacity={0.92}>Current location ({preferredMapPositionSource})</Tooltip>
          </CircleMarker>
        ) : null}
      </MapContainer>
    );
  }

  function renderSectionContent() {
    if (selectedNavId === "home") {
      return (
        <section className="panel home-panel home-splash">
          <div className="home-splash__heading home-splash__heading--standalone" aria-label="Heading ribbon" role="img">
              <span className="home-splash__heading-label">HDG</span>
              <span>030</span>
              <span>045</span>
              <span className="home-splash__heading-active">060</span>
              <span>075</span>
              <span>090</span>
              <span className="home-splash__heading-label">M</span>
            </div>

          <section className="home-splash__tiles-panel" aria-label="Configurable home tiles">
            <div className="home-splash__tiles-toolbar">
              <div className="home-splash__tiles-actions">
                <button className="theme-toggle" type="button" onClick={() => setEditingHomeTiles((current) => !current)}>
                  {editingHomeTiles ? "Done" : "Customize tiles"}
                </button>
                {editingHomeTiles ? (
                  <button className="theme-toggle" type="button" onClick={() => setHomeTileLayout(DEFAULT_HOME_TILE_LAYOUT)}>
                    Reset layout
                  </button>
                ) : null}
              </div>
            </div>

            <div className="home-splash__mod-grid">
              {configuredHomeTiles.map((tile, index) => (
                <article key={`${tile.id}-${index}`} className="home-splash__mod-tile">
                  {editingHomeTiles ? (
                    <label className="home-splash__slot-picker">
                      <span>Slot {index + 1}</span>
                      <select
                        value={homeTileLayout[index]}
                        onChange={(event) => {
                          const nextId = event.target.value as HomeTileId;
                          if (HOME_TILE_IDS.includes(nextId)) {
                            setHomeTileForSlot(index, nextId);
                          }
                        }}
                      >
                        {homeTileCatalog.map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <span className="home-splash__status-label">{tile.label}</span>
                  <strong>{tile.primary}</strong>
                  <span>{tile.secondary}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="home-splash__trend-card" aria-label="Depth and water temperature trend">
            <div className="home-splash__trend-header">
              <h3>Trend</h3>
              <div className="home-splash__trend-values">
                <span className="home-splash__trend-mode">Live samples</span>
                <span>Depth {homeInstruments.depthFeet === null ? "--" : `${homeInstruments.depthFeet.toFixed(0)} ft`}</span>
                <span>Temp {waterTempF === null ? "--" : `${waterTempF.toFixed(1)} F`}</span>
              </div>
            </div>
            <DepthTempGraph points={renderedDepthTempTrend} />
          </section>

        </section>
      );
    }

    if (selectedNavId === "streaming") {
      return (
        <section className="panel drill-panel drill-panel--streaming">
          <div className="tv-commandbar">
            <div className="tv-commandbar__left">
              <span className="panel__eyebrow">Video</span>
              <strong>{selectedStream.name}</strong>
            </div>
            <div className="tv-commandbar__actions">
              <button className="theme-toggle theme-toggle--primary" type="button" onClick={() => void launchAppTarget(selectedStream, "streaming")}>
                {launching ? "Opening..." : selectedStream.name}
              </button>
            </div>
          </div>

          {remoteMode ? (
            <div className="remote-launch-status" aria-live="polite">
              <strong>{launching ? `Sending ${selectedStream.name} to touchscreen...` : `${launcherState.name || "No app"}: ${launcherState.status}`}</strong>
              <span>{launcherState.message}</span>
            </div>
          ) : null}

          <div className="tv-tile-grid" role="list" aria-label="TV app launch tiles">
            {streamingTargets.map((target) => (
              <button
                key={target.id}
                className={
                  target.id === selectedStreamId
                    ? `tv-launch-tile tv-launch-tile--active stream-app-tile stream-app-tile--${target.accent} ${target.tileClass}`
                    : `tv-launch-tile stream-app-tile stream-app-tile--${target.accent} ${target.tileClass}`
                }
                type="button"
                onClick={() => {
                  setSelectedStreamId(target.id);
                  void launchAppTarget(target, "streaming");
                }}
                aria-label={target.name}
                title={target.name}
              >
                <BrandGlyph logoPath={target.logoPath} className="stream-app-tile__logo" />
                <div className="tv-launch-tile__copy">
                  <span className="stream-app-tile__label">{target.name}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      );
    }

    if (selectedNavId === "camera") {
      return <CameraPanel camera={activeSummary.camera} />;
    }

    if (selectedNavId === "music") {
      return (
        <section className="panel drill-panel drill-panel--streaming">
          <div className="tv-commandbar">
            <div className="tv-commandbar__left">
              <span className="panel__eyebrow">Music</span>
              <strong>{selectedMusic.name}</strong>
            </div>
            <div className="tv-commandbar__actions">
              <button className="theme-toggle theme-toggle--primary" type="button" onClick={() => void launchAppTarget(selectedMusic, "music") }>
                {launching ? "Opening..." : selectedMusic.name}
              </button>
            </div>
          </div>

          {remoteMode ? (
            <div className="remote-launch-status" aria-live="polite">
              <strong>{launching ? `Sending ${selectedMusic.name} to touchscreen...` : `${launcherState.name || "No app"}: ${launcherState.status}`}</strong>
              <span>{launcherState.message}</span>
            </div>
          ) : null}

          <div className="tv-tile-grid" role="list" aria-label="Music app launch tiles">
            {musicTargets.map((target, index) => {
              const accent = index % 2 === 0 ? "aqua" : "gold";
              return (
                <button
                  key={target.id}
                  className={
                    target.id === selectedMusicId
                      ? `tv-launch-tile tv-launch-tile--active stream-app-tile stream-app-tile--${accent}`
                      : `tv-launch-tile stream-app-tile stream-app-tile--${accent}`
                  }
                  type="button"
                  onClick={() => {
                    setSelectedMusicId(target.id);
                    void launchAppTarget(target, "music");
                  }}
                  aria-label={target.name}
                  title={target.name}
                >
                  <BrandGlyph logoPath={target.logoPath} className="stream-app-tile__logo" />
                  <div className="tv-launch-tile__copy">
                    <span className="stream-app-tile__label">{target.name}</span>
                  </div>
                </button>
              );
            })}
                </div>
        </section>
      );
    }

    if (selectedNavId === "weather") {
      if (weatherRadarFullscreen) {
        return (
          <div className="camera-fullscreen weather-radar-fullscreen" role="dialog" aria-label="Fullscreen storm radar">
            <div className="weather-radar-fullscreen__toolbar">
              <div className="weather-radar-fullscreen__toolbar-meta">
                <span className="panel__eyebrow">Weather</span>
                <strong>Storm Doppler radar</strong>
              </div>
              <button className="camera-fullscreen-btn" type="button" onClick={() => stepStormRadarFrame(-1)} disabled={!canPlaybackRadar}
                aria-label="Previous radar frame">Prev</button>
              <button
                className="camera-fullscreen-btn"
                type="button"
                onClick={toggleStormRadarPlayback}
                disabled={!canPlaybackRadar}
                aria-label={stormRadarPlaying ? "Pause radar playback" : "Play radar playback"}
              >
                {stormRadarPlaying ? "Pause" : "Play"}
              </button>
              <button className="camera-fullscreen-btn" type="button" onClick={() => stepStormRadarFrame(1)} disabled={!canPlaybackRadar}
                aria-label="Next radar frame">Next</button>
              <button className="camera-fullscreen-btn" type="button" onClick={centerWeatherMapOnBoat}
                disabled={!mapRecentCenterPosition && !navigator.geolocation}
                aria-label="Center weather map on vessel">
                Center recent
              </button>
              <button className={mapHeadingMode === "north" ? "camera-fullscreen-btn theme-toggle--primary" : "camera-fullscreen-btn"}
                type="button" onClick={() => setMapModeNorth("weather")} aria-label="North-up map mode">
                North
              </button>
              <button className={mapHeadingMode === "course" ? "camera-fullscreen-btn theme-toggle--primary" : "camera-fullscreen-btn"}
                type="button" onClick={() => setMapModeCourse("weather")} aria-label="Course-forward map mode">
                Course
              </button>
              <button className="camera-fullscreen-btn" type="button" onClick={() => setWeatherRadarFullscreen(false)}
                aria-label="Exit fullscreen radar">
                Exit fullscreen
              </button>
            </div>
            {renderWeatherRadarMap("weather-radar-map weather-radar-map--fullscreen")}
            <div className="weather-radar-fullscreen__hud">
              <strong>Storm Doppler radar</strong>
              <span>{stormRadarFrameLabel ? `Radar frame: ${stormRadarFrameLabel}` : "Radar frame unavailable"}</span>
              <span>{stormRadarTimeline.length > 1 ? `Playback: ${stormRadarPlaying ? "ON" : "OFF"} (${stormRadarTimeline.length} frames)` : "Playback unavailable"}</span>
              <span>Buoy sample: {latestBuoyObservationLabel}</span>
            </div>
          </div>
        );
      }

      return (
        <section className="panel drill-panel weather-panel">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Weather</p>
              <h2>Marine weather</h2>
            </div>
            <div className="weather-panel__header-actions">
              <span className={online ? "status-pill status-pill--success" : "status-pill"}>{online ? "Online" : "Fallback"}</span>
              <button className="camera-fullscreen-btn" type="button" onClick={() => setWeatherRadarFullscreen(true)}
                aria-label="Enter fullscreen radar">⛶</button>
            </div>
          </div>
          <div className="weather-strip" role="list" aria-label="Current marine weather values">
            <article className="weather-strip__card" role="listitem"><span>Current wave</span><strong>{currentWaveFeet === null ? "--" : `${currentWaveFeet.toFixed(1)} ft`}</strong></article>
            <article className="weather-strip__card" role="listitem"><span>Peak wave nearby</span><strong>{peakWaveFeet === null ? "--" : `${peakWaveFeet.toFixed(1)} ft`}</strong></article>
            <article className="weather-strip__card" role="listitem"><span>Wind</span><strong>{avgBuoyWindKnots === null ? activeSummary.weather.wind : `${avgBuoyWindKnots.toFixed(1)} kt`}</strong></article>
            <article className="weather-strip__card" role="listitem"><span>Pressure trend</span><strong>{buoyPressureTrend.label}</strong></article>
          </div>

          <div className="weather-layout">
            <section className="weather-radar-card" aria-label="Storm radar">
              <div className="weather-radar-card__header">
                <div>
                  <p className="panel__eyebrow">Radar</p>
                  <h3>Storm Doppler radar</h3>
                </div>
                <div className="weather-radar-card__actions">
                  <span className="trip-card__tag">{loadingStormRadar ? "Syncing weather" : "Radar observed"}</span>
                  <button className="camera-fullscreen-btn" type="button" onClick={() => stepStormRadarFrame(-1)} disabled={!canPlaybackRadar}
                    aria-label="Previous radar frame">Prev</button>
                  <button
                    className="camera-fullscreen-btn"
                    type="button"
                    onClick={toggleStormRadarPlayback}
                    disabled={!canPlaybackRadar}
                    aria-label={stormRadarPlaying ? "Pause radar playback" : "Play radar playback"}
                  >
                    {stormRadarPlaying ? "Pause" : "Play"}
                  </button>
                  <button className="camera-fullscreen-btn" type="button" onClick={() => stepStormRadarFrame(1)} disabled={!canPlaybackRadar}
                    aria-label="Next radar frame">Next</button>
                  <button className="camera-fullscreen-btn" type="button" onClick={centerWeatherMapOnBoat}
                    disabled={!mapRecentCenterPosition && !navigator.geolocation}
                    aria-label="Center weather map on vessel">
                    Center recent
                  </button>
                  <button className={mapHeadingMode === "north" ? "camera-fullscreen-btn theme-toggle--primary" : "camera-fullscreen-btn"}
                    type="button" onClick={() => setMapModeNorth("weather")} aria-label="North-up map mode">
                    North
                  </button>
                  <button className={mapHeadingMode === "course" ? "camera-fullscreen-btn theme-toggle--primary" : "camera-fullscreen-btn"}
                    type="button" onClick={() => setMapModeCourse("weather")} aria-label="Course-forward map mode">
                    Course
                  </button>
                </div>
              </div>

              <div className="weather-radar-map-shell">
                {renderWeatherRadarMap("weather-radar-map")}
              </div>
              <p className="weather-radar-card__note">Range rings: 10 / 20 / 40 / 80 NM from vessel for offshore storm distance.</p>
              <p className="weather-radar-card__note">Radar frame: {stormRadarFrameLabel ?? "Waiting for feed"}{stormRadarTileUrl ? "" : " (fallback source)"}</p>
              <p className="weather-radar-card__note">Playback: {stormRadarTimeline.length > 1 ? `${stormRadarPlaying ? "running" : "stopped"} (${stormRadarTimeline.length} frames)` : "not available"}</p>
              <p className="weather-radar-card__note">Nearest buoy sample: {latestBuoyObservationLabel}</p>
            </section>

            <section className="weather-forecast" aria-label="Marine forecast">
              <div className="weather-forecast__header">
                <div>
                  <p className="panel__eyebrow">Forecast</p>
                  <h3>12 hour outlook</h3>
                </div>
                <div className="trip-header-actions">
                  <span className="trip-card__tag">{seaStateLabel}</span>
                  {signalKForecastSource ? <span className="trip-card__tag">{signalKForecastSource}</span> : null}
                </div>
              </div>
              <div className="weather-forecast__grid">
                {weatherForecastCards.map((card) => (
                  <article key={card.label} className="weather-forecast__card">
                    <span>{card.label}</span>
                    <strong>{card.wave.toFixed(1)} ft</strong>
                    <div>{card.wind.toFixed(0)} kt wind</div>
                    <p>{card.outlook}</p>
                  </article>
                ))}
              </div>

              <div className="weather-forecast__foot">
                <article className="weather-forecast__stat"><span>Barometer</span><strong>{activeSummary.weather.barometer}</strong></article>
                <article className="weather-forecast__stat"><span>Tide</span><strong>{activeSummary.weather.tide}</strong></article>
                <article className="weather-forecast__stat"><span>Water temp</span><strong>{activeSummary.weather.waterTemp}</strong></article>
                <article className="weather-forecast__stat"><span>Depth</span><strong>{homeInstruments.depthFeet === null ? "--" : `${homeInstruments.depthFeet.toFixed(0)} ft`}</strong></article>
              </div>
            </section>
          </div>
        </section>
      );
    }

    if (selectedNavId === "fishing") {
      const canCenterOnBoat = Boolean(preferredMapPosition || navigator.geolocation);

      return (
        <section className={`panel drill-panel ${fishingSubview === "map" ? `drill-panel--fishing-map drill-panel--fishing-map--${fishingMapMode}` : "drill-panel--fishing-log"}`}>
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Fishing</p>
              <h2>Fishing</h2>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {fishingSubview === "map" ? (
                <button
                  type="button"
                  className="camera-fullscreen-btn"
                  onClick={() => setFishingMapFullscreen(true)}
                  aria-label="Enter fullscreen fishing map"
                >
                  ⛶
                </button>
              ) : null}
              {fishingSubview === "map" ? (
                <div className="fishing-page-switch fishing-page-switch--mode" role="tablist" aria-label="Fishing map mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={fishingMapMode === "navigate"}
                    className={fishingMapMode === "navigate" ? "theme-toggle theme-toggle--primary" : "theme-toggle"}
                    onClick={() => applyFishingMapMode("navigate")}
                  >
                    Navigate
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={fishingMapMode === "hunt"}
                    className={fishingMapMode === "hunt" ? "theme-toggle theme-toggle--primary" : "theme-toggle"}
                    onClick={() => applyFishingMapMode("hunt")}
                  >
                    Hunt
                  </button>
                </div>
              ) : null}
              <div className="fishing-page-switch" role="tablist" aria-label="Fishing pages">
                <button
                  type="button"
                  role="tab"
                  aria-selected={fishingSubview === "map"}
                  className={fishingSubview === "map" ? "theme-toggle theme-toggle--primary" : "theme-toggle"}
                  onClick={() => setFishingSubview("map")}
                >
                  Map
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={fishingSubview === "logbook"}
                  className={fishingSubview === "logbook" ? "theme-toggle theme-toggle--primary" : "theme-toggle"}
                  onClick={() => setFishingSubview("logbook")}
                >
                  Logbook
                </button>
              </div>
            </div>
          </div>

          <div className="fishing-layout">
            {fishingSubview === "logbook" ? (
            <div className="fishing-card fishing-card--quick-catch fishing-logbook-pane">
              <p className="panel__eyebrow">Quick catch</p>
              <div className="fishing-species-grid">
                {pelagicSpecies.map((species) => (
                  <button
                    key={species}
                    type="button"
                    className={species === quickSpecies ? "fishing-species-chip fishing-species-chip--active" : "fishing-species-chip"}
                    onClick={() => setQuickSpecies(species)}
                  >
                    {species}
                  </button>
                ))}
              </div>

              <div className="fishing-field">
                <label>Lure type</label>
                <div className="fishing-quick-chip-grid" role="group" aria-label="Lure type">
                  {QUICK_LOG_LURE_TYPES.map((typeOption) => (
                    <button
                      key={typeOption}
                      type="button"
                      className={quickLureType === typeOption ? "fishing-species-selector__chip fishing-species-selector__chip--active" : "fishing-species-selector__chip"}
                      onClick={() => setQuickLureType(typeOption)}
                    >
                      {typeOption}
                    </button>
                  ))}
                </div>
              </div>

              <div className="fishing-field">
                <label>Lure color</label>
                <div className="fishing-quick-chip-grid fishing-quick-chip-grid--colors" role="group" aria-label="Lure color">
                  {QUICK_LOG_LURE_COLORS.map((colorOption) => (
                    <button
                      key={colorOption}
                      type="button"
                      className={quickLureColor === colorOption ? "fishing-species-selector__chip fishing-species-selector__chip--active" : "fishing-species-selector__chip"}
                      onClick={() => setQuickLureColor(colorOption)}
                    >
                      {colorOption}
                    </button>
                  ))}
                </div>
              </div>

              <div className="fishing-field">
                <label htmlFor="fish-size-input">Size (optional, inches)</label>
                <div className="fishing-quick-chip-grid fishing-quick-chip-grid--sizes" role="group" aria-label="Fish size presets">
                  {QUICK_FISH_SIZE_PRESETS.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={quickFishSizeInches === String(size) ? "fishing-species-selector__chip fishing-species-selector__chip--active" : "fishing-species-selector__chip"}
                      onClick={() => setQuickFishSizeInches(String(size))}
                    >
                      {size} in
                    </button>
                  ))}
                  <button
                    type="button"
                    className={!quickFishSizeInches ? "fishing-species-selector__chip fishing-species-selector__chip--active" : "fishing-species-selector__chip"}
                    onClick={() => setQuickFishSizeInches("")}
                  >
                    No size
                  </button>
                </div>
                <input
                  id="fish-size-input"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.5}
                  value={quickFishSizeInches}
                  onChange={(event) => setQuickFishSizeInches(event.target.value)}
                  placeholder="e.g. 32"
                />
              </div>

              <div className="fishing-location-row">
                <span>Selection</span>
                <strong>{quickLureType} | {quickLureColor}{quickFishSizeInches ? ` | ${quickFishSizeInches} in` : ""}</strong>
              </div>

              <div className="fishing-location-row">
                <span>Location</span>
                <strong>{catchLocation.label}</strong>
              </div>

              <button className="theme-toggle theme-toggle--primary" type="button" onClick={() => void logQuickCatch()} disabled={loggingCatch}>
                {loggingCatch ? "Logging catch..." : `Log ${quickSpecies} to map`}
              </button>
            </div>
            ) : null}

            <div className="fishing-report-stack">
              <div className="fishing-card fishing-map-card fishing-map-pane">
                {fishingSubview === "logbook" ? (
                  <>
                    <div className="fishing-map-header">
                      <div>
                        <p className="panel__eyebrow">Catch map</p>
                        <h3>Where the bites happened</h3>
                      </div>
                      <span className="status-pill status-pill--success">{fishingMapPoints.length} points</span>
                    </div>

                    <div className="fishing-map-filters">
                      <label className="fishing-field fishing-field--compact">
                        <span>Date</span>
                        <select value={fishingMapDateFilter} onChange={(event) => setFishingMapDateFilter(event.target.value as "all" | "7d" | "30d" | "90d")}>
                          <option value="all">All time</option>
                          <option value="7d">Last 7 days</option>
                          <option value="30d">Last 30 days</option>
                          <option value="90d">Last 90 days</option>
                        </select>
                      </label>

                      <label className="fishing-field fishing-field--compact">
                        <span>Lure</span>
                        <select value={fishingMapLureFilter} onChange={(event) => setFishingMapLureFilter(event.target.value)}>
                          {lureOptions.map((lure) => (
                            <option key={lure} value={lure}>{lure}</option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="fishing-species-selector" aria-label="Species selector">
                      <button
                        type="button"
                        className={fishingMapSpeciesFilter === "All fish" ? "fishing-species-selector__chip fishing-species-selector__chip--active" : "fishing-species-selector__chip"}
                        onClick={() => {
                          setFishingMapSpeciesFilter("All fish");
                          setAdvisorSpecies("Auto (map species)");
                        }}
                      >
                        All fish
                      </button>
                      {pelagicSpecies.map((species) => (
                        <button
                          key={species}
                          type="button"
                          className={fishingMapSpeciesFilter === species ? "fishing-species-selector__chip fishing-species-selector__chip--active" : "fishing-species-selector__chip"}
                          onClick={() => {
                            setFishingMapSpeciesFilter(species);
                            setAdvisorSpecies(species);
                            const targetCircle = allFishMappingCircles.find((circle) => circle.species === species);
                            if (targetCircle) {
                              setSelectedFishCircleId(targetCircle.id);
                            }
                          }}
                        >
                          {species}
                        </button>
                      ))}
                    </div>

                    <div className="fishing-layer-presets fishing-layer-presets--species" role="group" aria-label="Species map presets">
                      <span className="fishing-layer-presets__label">Species preset</span>
                      {pelagicSpecies.map((species) => (
                        <button
                          key={species}
                          type="button"
                          className={fishingMapSpeciesFilter === species ? "fishing-species-selector__chip fishing-species-selector__chip--active" : "fishing-species-selector__chip"}
                          onClick={() => applySpeciesFishingPreset(species)}
                        >
                          {species}
                        </button>
                      ))}
                    </div>

                    <div className="fishing-map-controls">
                      <button
                        type="button"
                        className="fishing-species-selector__chip fishing-species-selector__chip--active"
                        onClick={() => setAllSpeciesVisibility(true)}
                      >
                        All species on
                      </button>
                      <button
                        type="button"
                        className="fishing-species-selector__chip"
                        onClick={() => setAllSpeciesVisibility(false)}
                      >
                        All species off
                      </button>

                      <label className="fishing-field fishing-field--compact">
                        <span>View</span>
                        <select value={fishingMapViewMode} onChange={(event) => setFishingMapViewMode(event.target.value as FishingMapViewMode)}>
                          <option value="clusters">Clusters</option>
                          <option value="heatmap">Heatmap</option>
                          <option value="points">Points</option>
                        </select>
                      </label>

                      <label className="fishing-field fishing-field--compact">
                        <span>Basemap</span>
                        <select value={fishingBasemap} onChange={(event) => setFishingBasemap(event.target.value as FishingBasemap)}>
                          <option value="nautical">Nautical</option>
                          <option value="standard">Standard</option>
                          <option value="satellite">Satellite</option>
                        </select>
                      </label>
                    </div>

                    <div className="fishing-ocean-controls">
                      <div className="fishing-layer-presets" role="group" aria-label="Fishing map strategy presets">
                        <span className="fishing-layer-presets__label">Strategy</span>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("search")}>Search water</button>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("temp-edge")}>Temp edge</button>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("structure")}>Structure</button>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("currents")}>Currents</button>
                      </div>

                      <div className="fishing-ocean-controls__row">
                        <label className="fishing-field fishing-field--compact fishing-field--slider">
                          <span>Live overlay opacity ({fishingMapOverlayOpacity}%)</span>
                          <input
                            type="range"
                            min={15}
                            max={95}
                            step={1}
                            value={fishingMapOverlayOpacity}
                            onChange={(event) => setFishingMapOverlayOpacity(Number(event.target.value))}
                          />
                        </label>
                      </div>
                      <p className="fishing-map-runtime-readout">
                        Overlay date: {realtimeOceanOverlayDate}{oceanRasterSoftened ? " | Coarse raster auto-dimmed" : ""}
                      </p>

                      <div className="fishing-overlay-toggle-grid" role="group" aria-label="Ocean overlays">
                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.sst}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, sst: event.target.checked }))}
                          />
                          <span>Sea temp</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.currents}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, currents: event.target.checked }))}
                          />
                          <span>Currents vectors</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.contours}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, contours: event.target.checked }))}
                          />
                          <span>Depth contours</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.fronts}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, fronts: event.target.checked }))}
                          />
                          <span>Eddies</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={showSpeciesHotspots}
                            onChange={(event) => setShowSpeciesHotspots(event.target.checked)}
                          />
                          <span>Hotspots</span>
                        </label>
                      </div>
                      {enabledOceanOverlays.currents ? (
                        <p className="fishing-map-local-status fishing-map-local-status--warning">
                          Current arrows and eddy confidence zones use real vector datasets (live provider with NOAA/OSCAR fallback). Raster current tile is only a visual backdrop.
                        </p>
                      ) : null}

                      <div className="fishing-map-confidence-legend" aria-label="Eddy confidence legend">
                        <div className="fishing-map-confidence-legend__item">
                          <strong>High</strong>
                          <span>Strong coherent rotation with broad vector support</span>
                        </div>
                        <div className="fishing-map-confidence-legend__item">
                          <strong>Medium</strong>
                          <span>Moderate rotational structure with decent coverage</span>
                        </div>
                        <div className="fishing-map-confidence-legend__item">
                          <strong>Low</strong>
                          <span>Weak or partial rotation, use as a scouting pass</span>
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}

                <div className={fishingMapFullscreen ? "fishing-map-shell fishing-map-shell--fullscreen" : "fishing-map-shell"} aria-label="Fishing catch map">
                  {fishingSubview === "map" ? (
                    <div className="map-nav-controls" role="group" aria-label="Fishing map navigation controls">
                      <button
                        type="button"
                        className="fishing-map-center-toggle"
                        onClick={centerFishingMapOnBoat}
                        disabled={!canCenterOnBoat}
                      >
                        Center recent
                      </button>
                      <button
                        type="button"
                        className={mapHeadingMode === "north" ? "fishing-map-center-toggle map-nav-controls__mode--active" : "fishing-map-center-toggle"}
                        onClick={() => setMapModeNorth("fishing")}
                        aria-label="North-up map mode"
                      >
                        North
                      </button>
                      <button
                        type="button"
                        className={mapHeadingMode === "course" ? "fishing-map-center-toggle map-nav-controls__mode--active" : "fishing-map-center-toggle"}
                        onClick={() => setMapModeCourse("fishing")}
                        aria-label="Course-forward map mode"
                      >
                        Course
                      </button>
                    </div>
                  ) : null}
                  {fishingSubview === "map" ? (
                    <button
                      type="button"
                      className="fishing-map-settings-toggle"
                      onClick={() => setShowFishingMapSettings((current) => !current)}
                      aria-expanded={showFishingMapSettings}
                      aria-controls="fishing-map-settings"
                    >
                      {showFishingMapSettings ? "Close controls" : "Controls"}
                    </button>
                  ) : null}
                  {fishingMapFullscreen ? (
                    <button
                      type="button"
                      className="camera-fullscreen__exit"
                      onClick={() => setFishingMapFullscreen(false)}
                      aria-label="Exit fullscreen fishing map"
                    >
                      ✕
                    </button>
                  ) : null}
                  {fishingSubview === "map" && showFishingMapSettings ? (
                    <aside id="fishing-map-settings" className="fishing-map-settings" aria-label="Map settings">
                      <label className="fishing-field fishing-field--compact">
                        <span>Basemap</span>
                        <select value={fishingBasemap} onChange={(event) => setFishingBasemap(event.target.value as FishingBasemap)}>
                          <option value="nautical">Nautical</option>
                          <option value="standard">Standard</option>
                          <option value="satellite">Satellite</option>
                        </select>
                      </label>

                      <label className="fishing-field fishing-field--compact">
                        <span>View</span>
                        <select value={fishingMapViewMode} onChange={(event) => setFishingMapViewMode(event.target.value as FishingMapViewMode)}>
                          <option value="clusters">Clusters</option>
                          <option value="heatmap">Heatmap</option>
                          <option value="points">Points</option>
                        </select>
                      </label>

                      <label className="fishing-field fishing-field--compact fishing-field--slider">
                        <span>Live overlay opacity ({fishingMapOverlayOpacity}%)</span>
                        <input
                          type="range"
                          min={15}
                          max={95}
                          step={1}
                          value={fishingMapOverlayOpacity}
                          onChange={(event) => setFishingMapOverlayOpacity(Number(event.target.value))}
                        />
                      </label>
                      <p className="fishing-map-runtime-readout">
                        Overlay date: {realtimeOceanOverlayDate}{oceanRasterSoftened ? " | Coarse raster auto-dimmed" : ""}
                      </p>

                      <div className="fishing-map-settings__toggles" role="group" aria-label="Ocean overlays">
                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.sst}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, sst: event.target.checked }))}
                          />
                          <span>Sea temp</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.currents}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, currents: event.target.checked }))}
                          />
                          <span>Currents vectors</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.contours}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, contours: event.target.checked }))}
                          />
                          <span>Depth contours</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.fronts}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, fronts: event.target.checked }))}
                          />
                          <span>Eddies (confidence)</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={showSpeciesHotspots}
                            onChange={(event) => setShowSpeciesHotspots(event.target.checked)}
                          />
                          <span>Species hotspots</span>
                        </label>
                      </div>

                      <div className="fishing-layer-presets" role="group" aria-label="Fishing map strategy presets">
                        <span className="fishing-layer-presets__label">Strategy</span>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("search")}>Search</button>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("temp-edge")}>Temp edge</button>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("structure")}>Structure</button>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("currents")}>Currents</button>
                      </div>

                      <div className="fishing-layer-presets fishing-layer-presets--species" role="group" aria-label="Species map presets">
                        <span className="fishing-layer-presets__label">Species</span>
                        {pelagicSpecies.map((species) => (
                          <button
                            key={species}
                            type="button"
                            className={fishingMapSpeciesFilter === species ? "fishing-species-selector__chip fishing-species-selector__chip--active" : "fishing-species-selector__chip"}
                            onClick={() => applySpeciesFishingPreset(species)}
                          >
                            {species}
                          </button>
                        ))}
                      </div>

                      <div className="fishing-map-confidence-legend" aria-label="Seam confidence legend">
                        <div className="fishing-map-confidence-legend__item">
                          <strong>High</strong>
                          <span>Tight edge, strong signal</span>
                        </div>
                        <div className="fishing-map-confidence-legend__item">
                          <strong>Medium</strong>
                          <span>Usable seam, verify quickly</span>
                        </div>
                        <div className="fishing-map-confidence-legend__item">
                          <strong>Low</strong>
                          <span>Weak signal, scout only</span>
                        </div>
                      </div>
                    </aside>
                  ) : null}
                  {!fishingMapFullscreen && tacticalMapFallback ? (
                    <div className="fishing-map-local-status">
                      Public tiles offline. Local tactical mode active with vessel GPS, catches, and species intel.
                    </div>
                  ) : null}
                  {!fishingMapFullscreen && showFishingMapDiagnostics && noBuoySignalCoverage ? (
                    <div className="fishing-map-local-status fishing-map-local-status--warning">
                      No NOAA buoys in view. Hotspots are running in fallback mode.
                    </div>
                  ) : null}
                  {!fishingMapFullscreen && showFishingMapDiagnostics && noCurrentVectorCoverage && !hasCachedCurrentVectors ? (
                    <div className="fishing-map-local-status fishing-map-local-status--warning">
                      Live current vectors unavailable in this view (provider/rate-limit). Pan offshore and it will auto-resume.
                    </div>
                  ) : null}
                    <MapContainer
                      key={`fishing-map-${fishingMapRenderNonce}`}
                      center={mapRecentCenterPosition ? [mapRecentCenterPosition.latitude, mapRecentCenterPosition.longitude] : fishingMapCenter}
                      zoom={7}
                      minZoom={4}
                      maxZoom={15}
                      scrollWheelZoom
                      attributionControl={false}
                      zoomAnimation={false}
                      fadeAnimation={false}
                      markerZoomAnimation={false}
                      className="fishing-map-canvas"
                      style={fishingMapFullscreen
                        ? { height: "100vh", width: "100vw" }
                        : { height: "clamp(300px, 48vh, 620px)", width: "100%" }}
                    >
                      <FishingMapRuntimeGuard />
                    {preferredMapPosition ? (
                      <CircleMarker
                        center={[preferredMapPosition.latitude, preferredMapPosition.longitude]}
                        radius={9}
                        pathOptions={{
                          color: "rgba(255, 255, 255, 0.9)",
                          weight: 2,
                          fillColor: "#5fd0ff",
                          fillOpacity: 0.95
                        }}
                      >
                        <Popup>
                          <div className="fishing-map-popup">
                            <strong>Map center anchor</strong>
                            <span>{preferredMapPosition.latitude.toFixed(4)}°, {preferredMapPosition.longitude.toFixed(4)}°</span>
                            <small>{preferredMapPositionSource}</small>
                          </div>
                        </Popup>
                      </CircleMarker>
                    ) : null}
                    {!mapFallbackActive && fishingBasemap !== "satellite" ? (
                      <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      />
                    ) : null}
                    {!mapFallbackActive && fishingBasemap === "nautical" ? (
                      <TileLayer
                        url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
                        attribution='&copy; <a href="https://www.openseamap.org">OpenSeaMap</a> contributors'
                      />
                    ) : null}
                    {!mapFallbackActive && fishingBasemap === "satellite" ? (
                      <TileLayer
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        attribution='Tiles &copy; Esri'
                      />
                    ) : null}
                    {!mapFallbackActive && showSstRaster ? (
                      <TileLayer
                        url={buildOceanOverlayUrl("sst", realtimeOceanOverlayDate)}
                        opacity={sstOverlayOpacity}
                        className="fishing-ocean-raster fishing-ocean-raster--sst"
                        maxNativeZoom={7}
                      />
                    ) : null}
                    {!mapFallbackActive && showChlorophyllRaster ? (
                      <TileLayer
                        url={buildOceanOverlayUrl("chlorophyll", realtimeOceanOverlayDate)}
                        opacity={chlorophyllOverlayOpacity}
                        className="fishing-ocean-raster fishing-ocean-raster--chlorophyll"
                        maxNativeZoom={7}
                      />
                    ) : null}
                    {!mapFallbackActive && enabledOceanOverlays.contours ? (
                      <>
                        <TileLayer
                          url="https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}"
                          opacity={0.9}
                          maxNativeZoom={10}
                        />
                      </>
                    ) : null}
                    {enabledOceanOverlays.currents ? tacticalCurrentArrows.flatMap((arrow) => [
                      <Polyline
                        key={`${arrow.id}-shaft`}
                        positions={arrow.shaft}
                        pathOptions={{ color: "#d7f4ff", weight: 1.8, opacity: arrow.opacity }}
                      />,
                      <Polyline
                        key={`${arrow.id}-left`}
                        positions={arrow.left}
                        pathOptions={{ color: "#d7f4ff", weight: 1.8, opacity: arrow.opacity }}
                      />,
                      <Polyline
                        key={`${arrow.id}-right`}
                        positions={arrow.right}
                        pathOptions={{ color: "#d7f4ff", weight: 1.8, opacity: arrow.opacity }}
                      />
                    ]) : null}
                    <FishingMapBoundsReporter onBoundsChange={setFishingMapBounds} />
                    <FishingMapZoomReporter onZoomChange={setFishingMapZoom} />
                    <FishingMapViewport points={fishingMapPoints} currentPosition={preferredMapPosition} />
                    <FishingIntelViewport
                      circles={showSpeciesHotspots ? fishMappingCircles : []}
                      currentPosition={preferredMapPosition}
                    />
                    <FishingMapLayer points={fishingMapPoints} viewMode={fishingMapViewMode} />
                    {oceanBuoys.map((buoy) => {
                      const color = buoyTempColor(buoy.waterTempC);
                      const waterTempLabel = buoy.waterTempC === null ? "N/A" : `${((buoy.waterTempC * 9) / 5 + 32).toFixed(1)} F`;
                      return (
                        <CircleMarker
                          key={`buoy-${buoy.stationId}`}
                          center={[buoy.latitude, buoy.longitude]}
                          radius={4.8}
                          pathOptions={{
                            color: "rgba(255, 255, 255, 0.95)",
                            weight: 1,
                            fillColor: color,
                            fillOpacity: 0.86
                          }}
                        >
                          <Popup>
                            <div className="fishing-map-popup">
                              <strong>Buoy {buoy.stationId}</strong>
                              <span>Water: {waterTempLabel}</span>
                              <span>Wind: {buoy.windSpeedMps === null ? "N/A" : `${buoy.windSpeedMps.toFixed(1)} m/s`}</span>
                              <small>{new Date(buoy.observedAt).toLocaleString()}</small>
                            </div>
                          </Popup>
                        </CircleMarker>
                      );
                    })}
                    {enabledOceanOverlays.fronts ? currentEddyZones.map((eddy) => (
                      <Circle
                        key={eddy.id}
                        center={[eddy.latitude, eddy.longitude]}
                        radius={eddy.radiusNm * 1852}
                        pathOptions={{
                          color: eddy.confidence === "high" ? "#6ff2ff" : eddy.confidence === "medium" ? "#39c7e0" : "#2e93ad",
                          weight: eddy.confidence === "high" ? 3 : eddy.confidence === "medium" ? 2.5 : 2,
                          opacity: eddy.confidence === "high" ? 0.9 : eddy.confidence === "medium" ? 0.82 : 0.74,
                          fillColor: eddy.confidence === "high" ? "#39d8ff" : "#2489a6",
                          fillOpacity: eddy.confidence === "high" ? 0.12 : 0.08,
                          dashArray: eddy.confidence === "high" ? "" : "6 8"
                        }}
                      >
                        <Tooltip direction="top" offset={[0, -4]} opacity={0.92}>
                          Eddy confidence {eddy.score} ({eddy.confidence.toUpperCase()})
                        </Tooltip>
                        <Popup>
                          <div className="fishing-map-popup">
                            <strong>Current eddy ({eddy.confidence.toUpperCase()})</strong>
                            <span>{eddy.latitude.toFixed(4)}°, {eddy.longitude.toFixed(4)}°</span>
                            <span>Confidence score: {eddy.score}/100</span>
                            <span>Rotation: {eddy.rotation}</span>
                            <small>{eddy.sampleCount} vector samples · {eddy.meanSpeedKnots.toFixed(2)} kt mean flow</small>
                          </div>
                        </Popup>
                      </Circle>
                    )) : null}
                    {showSpeciesHotspots ? fishMappingCircles.flatMap((circle) => [
                      <Circle
                        key={`${circle.id}-zone`}
                        center={[circle.latitude, circle.longitude]}
                        radius={circle.radiusNm * 1852}
                        pathOptions={{
                          color: circle.profile.color,
                          weight: selectedFishCircle?.id === circle.id ? 2.5 : 1.5,
                          fillColor: circle.profile.color,
                          fillOpacity: selectedFishCircle?.id === circle.id ? 0.35 : 0.18,
                          dashArray: circle.confidence === "high" ? "" : "8,6"
                        }}
                        eventHandlers={{
                          click: () => {
                            setSelectedFishCircleId(circle.id);
                            setAdvisorSpecies(circle.species);
                          }
                        }}
                      >
                        <Popup>
                          {(() => {
                            const intelEntry = speciesIntelByName.get(circle.species);
                            const offshoreNm = offshoreDistanceFromAtlanticCoastNm({ latitude: circle.latitude, longitude: circle.longitude });
                            const tactic = circle.confidence === "high"
                              ? "Tactic: Run your first pass on the up-current edge and work cross-current through bait marks."
                              : circle.confidence === "medium"
                                ? "Tactic: Probe this zone after confirming bait and temp break, then expand 3-6 NM outward."
                                : "Tactic: Use as a scouting waypoint and validate with bait/marks before long runs.";

                            const reasons = [
                              `Temp window: ${circle.profile.temperatureRangeF.min} F - ${circle.profile.temperatureRangeF.max} F`,
                              `Current pattern: ${circle.profile.currentSignal}`,
                              `Habitat depth guideline: ${circle.profile.depthBand}`,
                              offshoreNm === null
                                ? "Offshore guardrail: outside known inshore zones"
                                : `Offshore guardrail: ${offshoreNm.toFixed(1)} NM off coastline`,
                              circle.supportingCount > 0
                                ? `Recent catches nearby: ${circle.supportingCount}`
                                : "Catch history: limited recent logs",
                              ...(intelEntry?.notes?.slice(0, 2) ?? []),
                              tactic
                            ];

                            return (
                          <div className="fishing-map-popup">
                            <strong>{circle.species}</strong>
                            <span>Score {circle.score} | {circle.confidence.toUpperCase()}</span>
                            <span>{circle.latitude.toFixed(4)}°, {circle.longitude.toFixed(4)}°</span>
                            {reasons.map((reason, reasonIndex) => (
                              <small key={`${circle.id}-reason-${reasonIndex}`}>{reason}</small>
                            ))}
                          </div>
                            );
                          })()}
                        </Popup>
                      </Circle>,
                      <CircleMarker
                        key={`${circle.id}-pin`}
                        center={[circle.latitude, circle.longitude]}
                        radius={4}
                        pathOptions={{
                          color: circle.profile.color,
                          weight: 2,
                          fillColor: "#fff",
                          fillOpacity: 0.92
                        }}
                        eventHandlers={{
                          click: () => {
                            setSelectedFishCircleId(circle.id);
                            setAdvisorSpecies(circle.species);
                          }
                        }}
                      >
                        <Popup>
                          <div className="fishing-map-popup">
                            <strong>{circle.species} hotspot</strong>
                            <span>{circle.latitude.toFixed(4)}°, {circle.longitude.toFixed(4)}°</span>
                            <small>Tap and run to this coordinate</small>
                          </div>
                        </Popup>
                      </CircleMarker>
                    ]) : null}
                    </MapContainer>
                  {!fishingMapFullscreen && fishingMapMode === "hunt" && showSpeciesHotspots && fishLegendCircles.length > 0 && (
                    <div className="fishing-map-intel-legend">
                      {fishLegendCircles.map((circle) => {
                        const refLat = vesselPosition?.latitude ?? fishingMapCenter[0];
                        const refLng = vesselPosition?.longitude ?? fishingMapCenter[1];
                        const isActive = selectedFishCircle?.id === circle.id;
                        return (
                          <button
                            key={circle.id}
                            type="button"
                            className={`fishing-map-intel-legend__item${isActive ? " fishing-map-intel-legend__item--active" : ""}`}
                            onClick={() => { setSelectedFishCircleId(circle.id); setAdvisorSpecies(circle.species); }}
                          >
                            <span className="fishing-map-intel-legend__swatch" style={{ background: circle.profile.color }} />
                            <span className="fishing-map-intel-legend__name">{circle.species}</span>
                            <span className="fishing-map-intel-legend__score" style={{ color: circle.profile.color }}>{circle.score}</span>
                            <span className="fishing-map-intel-legend__dist">
                              {Math.round(geoDistanceNm(refLat, refLng, circle.latitude, circle.longitude))} NM 
                              {geoBearingLabel(refLat, refLng, circle.latitude, circle.longitude)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!fishingMapFullscreen && showFishingMapDiagnostics ? (
                    <p className="fishing-map-attribution">
                      {fishingBasemap === "nautical"
                        ? "Map data: OpenStreetMap + OpenSeaMap contributors"
                        : fishingBasemap === "satellite"
                          ? "Map data: Esri World Imagery"
                          : "Map data: OpenStreetMap contributors"}
                      {enabledOceanOverlays.sst || enabledOceanOverlays.currents
                        ? ` | Ocean layers: NASA GIBS ${realtimeOceanOverlayDate}`
                        : ""}
                      {enabledOceanOverlays.contours ? " | Contours: Esri Ocean Reference" : ""}
                      {fishMappingCircles.length > 0
                        ? ` | Hotspots: ${fishMappingCircles.filter((circle) => !circle.id.includes("-scout")).length} primary, ${fishMappingCircles.filter((circle) => circle.id.includes("-scout")).length} scout`
                        : speciesIntel
                          ? " | Hotspots: no qualified offshore lanes"
                          : " | Hotspots: loading"}
                    </p>
                  ) : null}
                  {!fishingMapFullscreen && showFishingMapDiagnostics && fishMappingCircles.length === 0 ? (
                    <div className="fishing-species-empty">
                      Offshore quality gate active. No lanes shown until SST, fronts, and offshore distance align.
                    </div>
                  ) : null}
                </div>

                {fishingSubview === "logbook" ? (
                <div className="species-intel-panel fishing-logbook-pane">
                  <div className="species-intel-panel__header">
                    <div>
                      <p className="panel__eyebrow">Offshore fishing intelligence</p>
                      <h3>Species conditions</h3>
                    </div>
                    <span className="status-pill status-pill--success">
                      {loadingSpeciesIntel
                        ? "Analyzing..."
                        : speciesIntel
                          ? `${speciesIntel.buoyCount} buoys · ${speciesIntel.frontCount} fronts`
                          : "No data"}
                    </span>
                  </div>

                  {speciesIntel && speciesIntel.species.length > 0 ? (
                    <div className="species-intel-rank">
                      {speciesIntel.species.map((entry: SpeciesIntelEntry) => {
                        const isExpanded = expandedSpeciesIntel === entry.species;
                        const isSelected = selectedFishCircle?.species === entry.species;
                        return (
                          <div key={entry.species} className={`species-intel-row${isSelected ? " species-intel-row--selected" : ""}`}>
                            <button
                              type="button"
                              className="species-intel-row__summary"
                              onClick={() => {
                                setExpandedSpeciesIntel(isExpanded ? null : entry.species);
                                const circle = fishMappingCircles.find((c) => c.species === entry.species);
                                if (circle) {
                                  setSelectedFishCircleId(circle.id);
                                  setAdvisorSpecies(entry.species);
                                }
                              }}
                            >
                              <span className="species-intel-row__swatch" style={{ background: entry.color }} />
                              <div className="species-intel-row__info">
                                <strong>{entry.species}</strong>
                                {entry.bestLatitude !== null && entry.bestLongitude !== null
                                  ? <small className="species-intel-row__nav">
                                      {Math.round(geoDistanceNm(
                                        vesselPosition?.latitude ?? fishingMapCenter[0],
                                        vesselPosition?.longitude ?? fishingMapCenter[1],
                                        entry.bestLatitude, entry.bestLongitude
                                      ))} NM&nbsp;
                                      {geoBearingLabel(
                                        vesselPosition?.latitude ?? fishingMapCenter[0],
                                        vesselPosition?.longitude ?? fishingMapCenter[1],
                                        entry.bestLatitude, entry.bestLongitude
                                      )}
                                    </small>
                                  : <small>{entry.bestLocationLabel}</small>}
                              </div>
                              <div className="species-intel-row__right">
                                <span className="species-intel-row__score">{entry.score}</span>
                                <span className={`species-intel-row__conf species-intel-row__conf--${entry.confidence}`}>
                                  {entry.confidence.toUpperCase()}
                                </span>
                              </div>
                            </button>
                            <div className="species-intel-row__flags">
                              {entry.recommended
                                ? <span className="species-intel-row__flag species-intel-row__flag--go">Go here</span>
                                : entry.score >= 40
                                  ? <span className="species-intel-row__flag">Scout lane</span>
                                  : <span className="species-intel-row__flag">Monitor</span>}
                            </div>
                            <div className="species-intel-row__bar">
                              <div className="species-intel-row__bar-fill" style={{ width: `${entry.score}%`, background: entry.color }} />
                            </div>
                            {isExpanded ? (
                              <div className="species-intel-breakdown">
                                <div className="species-intel-breakdown__grid">
                                  {([
                                    entry.factors.sst,
                                    entry.factors.sstFront,
                                    entry.factors.convergence,
                                    entry.factors.chlorophyllProxy,
                                    entry.factors.dataAge,
                                    entry.factors.catchHistory
                                  ] as Array<{ label: string; value: string; score: number }>).map((factor) => (
                                    <div key={factor.label} className="species-intel-factor">
                                      <span className="species-intel-factor__label">{factor.label}</span>
                                      <span className="species-intel-factor__value">{factor.value}</span>
                                      <div className="species-intel-factor__bar">
                                        <div style={{ width: `${factor.score}%`, background: entry.color }} />
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                <div className="species-intel-breakdown__meta">
                                  <small>{entry.depthBand}</small>
                                  <small>{entry.currentSignal}</small>
                                  <small>SST target: {entry.temperatureRangeF.min}–{entry.temperatureRangeF.max} F</small>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : !loadingSpeciesIntel ? (
                    <div className="fishing-species-empty">
                      No species currently meet marine condition thresholds. Expand the map or move offshore to load buoy evidence.
                    </div>
                  ) : (
                    <p>Building species intelligence from public ocean data...</p>
                  )}
                </div>
                ) : null}

                {fishingSubview === "logbook" ? (
                <div className="fishing-map-legend">
                  <div className="fishing-map-legend__item">
                    <span>SST</span>
                    <div className="fishing-map-legend__bar fishing-map-legend__bar--sst" />
                    <small>cool to warm</small>
                  </div>
                  <div className="fishing-map-legend__item">
                    <span>Convergence</span>
                    <div className="fishing-map-legend__bar fishing-map-legend__bar--chlorophyll" />
                    <small>current edge</small>
                  </div>
                  <div className="fishing-map-legend__item">
                    <span>Depth contours</span>
                    <div className="fishing-map-legend__bar fishing-map-legend__bar--contours" />
                    <small>shelf lanes</small>
                  </div>
                  <div className="fishing-map-legend__item">
                    <span>Buoy temp</span>
                    <div className="fishing-map-legend__swatches">
                      <i style={{ background: "#52a5ff" }} />
                      <i style={{ background: "#00c0c0" }} />
                      <i style={{ background: "#6ad8a2" }} />
                      <i style={{ background: "#e0b060" }} />
                      <i style={{ background: "#ff8f70" }} />
                    </div>
                    <small>cold to hot</small>
                  </div>
                </div>
                ) : null}

                {fishingSubview === "logbook" ? (
                <div className="fishing-map-list">
                  {fishingMapPoints.length > 0 ? fishingMapPoints.map((point) => (
                    <div key={point.id} className="fishing-map-list__item">
                      <span className="fishing-map-list__dot" style={{ background: point.color }} />
                      <div>
                        <strong>{point.species}</strong>
                        <small>{point.lureName}{point.fishSizeInches ? ` | ${point.fishSizeInches.toFixed(1)} in` : ""}</small>
                      </div>
                      <span>{new Date(point.timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                    </div>
                  )) : <p className="fishing-bait-empty">No catches match the current filter set.</p>}
                </div>
                ) : null}

                {fishingSubview === "logbook" ? (
                <div className="fishing-buoy-list">
                  <p className="panel__eyebrow">Nearby buoy observations</p>
                  {loadingOceanBuoys ? <p>Loading buoy data...</p> : null}
                  {!loadingOceanBuoys && displayedBuoys.length === 0 ? <p>No buoy observations in this viewport.</p> : null}
                  {displayedBuoys.map((buoy) => (
                    <article key={`buoy-list-${buoy.stationId}`} className="fishing-buoy-list__item">
                      <strong>{buoy.stationId}</strong>
                      <span>{buoy.waterTempC === null ? "Water N/A" : `${((buoy.waterTempC * 9) / 5 + 32).toFixed(1)} F water`}</span>
                      <small>{buoy.windSpeedMps === null ? "Wind N/A" : `${buoy.windSpeedMps.toFixed(1)} m/s wind`}</small>
                    </article>
                  ))}
                </div>
                ) : null}
              </div>

              {fishingSubview === "logbook" ? (
              <div className="fishing-card">
                <p className="panel__eyebrow">Fishing report</p>
                <h3>{fishingReport.headline}</h3>
                <p>{fishingReport.summary}</p>
                <ul className="fishing-report-list">
                  {fishingReport.suggestions.map((suggestion) => (
                    <li key={suggestion}>{suggestion}</li>
                  ))}
                </ul>
              </div>
              ) : null}

              {fishingSubview === "logbook" ? (
              <div className="fishing-card">
                <p className="panel__eyebrow">What worked</p>
                <strong className="fishing-pattern">{fishingReport.strongestPattern}</strong>
                <div className="fishing-list">
                  {fishingCatches.slice(0, 5).map((catchItem) => (
                    <article key={catchItem.id} className="fishing-list-item">
                      <div>
                        <strong>{catchItem.species}</strong>
                        <span>{catchItem.bait}</span>
                      </div>
                      <div>
                        <span>{new Date(catchItem.timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                        <small>{catchItem.locationLabel}</small>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
              ) : null}
            </div>
          </div>
        </section>
      );
    }

    if (selectedNavId === "vessel") {
      return (
        <section className="panel drill-panel drill-panel--vessel vessel-panel">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Vessel</p>
              <h2>Engines and system status</h2>
            </div>
            <span className="status-pill">{activeSummary.system.uptime}</span>
          </div>

          <div className="vessel-panel__pager" role="tablist" aria-label="Vessel pages">
            <button
              type="button"
              role="tab"
              aria-selected={vesselSubview === "systems"}
              className={vesselSubview === "systems" ? "vessel-panel__pager-btn vessel-panel__pager-btn--active" : "vessel-panel__pager-btn"}
              onClick={() => {
                setBilgeBuddyFullscreen(false);
                setVesselSubview("systems");
              }}
            >
              Systems
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={vesselSubview === "bilgebuddy"}
              className={vesselSubview === "bilgebuddy" ? "vessel-panel__pager-btn vessel-panel__pager-btn--active" : "vessel-panel__pager-btn"}
              onClick={() => setVesselSubview("bilgebuddy")}
            >
              BilgeBuddy
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={vesselSubview === "myvessel"}
              className={vesselSubview === "myvessel" ? "vessel-panel__pager-btn vessel-panel__pager-btn--active" : "vessel-panel__pager-btn"}
              onClick={() => setVesselSubview("myvessel")}
            >
              My Vessel
            </button>
          </div>

          <div className={vesselSubview === "systems" ? "vessel-panel__systems" : "vessel-panel__systems vessel-panel__systems--hidden"}>
            <div className="metric-grid">
              {activeSummary.metrics.map((metric) => (
                <MetricCard key={metric.label} metric={metric} />
              ))}
            </div>
            <div className="engine-grid">
              {activeSummary.engines.map((engine) => (
                <article className="engine-card" key={engine.label}>
                  <div className="engine-card__header">
                    <h3>{engine.label}</h3>
                    <span>{engine.voltage.toFixed(1)} V</span>
                  </div>
                  <div className="engine-card__main">
                    <strong>{engine.rpm}</strong>
                    <span>RPM</span>
                  </div>
                  <div className="engine-card__stats">
                    <span>{engine.gph.toFixed(1)} GPH</span>
                    <span>{engine.tempF} F</span>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className={vesselSubview === "myvessel" ? "vessel-panel__systems my-vessel-layout" : "vessel-panel__systems vessel-panel__systems--hidden my-vessel-layout"}>
            <div className="home-panel__quick-grid settings-kiosk__summary my-vessel-layout__summary">
              <article className="home-panel__quick-card">
                <span className="home-panel__quick-label">Home port status</span>
                <strong>{homePortPoint ? "Configured" : "Not configured"}</strong>
                <span>{homePortLabel}</span>
              </article>
              <article className="home-panel__quick-card">
                <span className="home-panel__quick-label">Geofence radius</span>
                <strong>{homePortRadiusNm.toFixed(2)} NM</strong>
                <span>Used for trip auto-complete and map ring</span>
              </article>
              <article className="home-panel__quick-card">
                <span className="home-panel__quick-label">Source</span>
                <strong>{preferredMapPositionSource}</strong>
                <span>{preferredMapPosition ? `${preferredMapPosition.latitude.toFixed(5)}, ${preferredMapPosition.longitude.toFixed(5)}` : "No live position lock"}</span>
              </article>
            </div>

            <div className="my-vessel-layout__main">
              <div className="home-port-map-shell" aria-label="Home port map picker">
                <MapContainer
                  key={`home-port-map-${myVesselHomePortMapCenter[0].toFixed(5)}-${myVesselHomePortMapCenter[1].toFixed(5)}`}
                  center={myVesselHomePortMapCenter}
                  zoom={12}
                  minZoom={4}
                  maxZoom={17}
                  scrollWheelZoom
                  attributionControl={false}
                  className="home-port-map"
                >
                  <TileLayer
                    attribution='&copy; OpenStreetMap contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <HomePortConfigMapInteractions
                    onPick={({ latitude, longitude }) => {
                      setHomePortConfig((current) => ({
                        ...current,
                        latitude,
                        longitude
                      }));
                    }}
                    onCenterChange={setMyVesselMapCenter}
                  />
                  {homePortPoint ? (
                    <>
                      <Circle
                        center={[homePortPoint.latitude, homePortPoint.longitude]}
                        radius={homePortRadiusNm * 1852}
                        pathOptions={{
                          color: "#f4c86a",
                          weight: 2,
                          dashArray: "7 7",
                          opacity: 0.9,
                          fillColor: "#f4c86a",
                          fillOpacity: 0.08
                        }}
                      >
                        <Tooltip direction="top" offset={[0, -4]} opacity={0.92}>Home Port Radius ({homePortRadiusNm.toFixed(2)} NM)</Tooltip>
                      </Circle>
                      <CircleMarker
                        center={[homePortPoint.latitude, homePortPoint.longitude]}
                        radius={6}
                        pathOptions={{
                          color: "#fff4cf",
                          weight: 2,
                          fillColor: "#f4c86a",
                          fillOpacity: 0.95
                        }}
                      >
                        <Tooltip direction="top" offset={[0, -4]} opacity={0.92}>Home Port</Tooltip>
                      </CircleMarker>
                    </>
                  ) : null}
                  {preferredMapPosition ? (
                    <CircleMarker
                      center={[preferredMapPosition.latitude, preferredMapPosition.longitude]}
                      radius={5}
                      pathOptions={{
                        color: "rgba(255, 255, 255, 0.95)",
                        weight: 1.8,
                        fillColor: "#5fd0ff",
                        fillOpacity: 0.94
                      }}
                    >
                      <Tooltip direction="top" offset={[0, -4]} opacity={0.92}>Current location ({preferredMapPositionSource})</Tooltip>
                    </CircleMarker>
                  ) : null}
                </MapContainer>
                <p className="home-port-map__hint">
                  Tap chart to set Home Port. Gold circle is return geofence.
                </p>
              </div>

              <div className="my-vessel-layout__controls">
                <div className="settings-kiosk__field-grid">
                  <label className="settings-kiosk__field">
                    <span>Home port latitude</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step={0.00001}
                      value={homePortConfig.latitude ?? ""}
                      onChange={(event) => {
                        const next = event.target.value.trim();
                        const parsed = Number.parseFloat(next);
                        setHomePortConfig((current) => ({
                          ...current,
                          latitude: next === "" || !Number.isFinite(parsed) ? null : parsed
                        }));
                      }}
                      placeholder="34.72000"
                    />
                  </label>

                  <label className="settings-kiosk__field">
                    <span>Home port longitude</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step={0.00001}
                      value={homePortConfig.longitude ?? ""}
                      onChange={(event) => {
                        const next = event.target.value.trim();
                        const parsed = Number.parseFloat(next);
                        setHomePortConfig((current) => ({
                          ...current,
                          longitude: next === "" || !Number.isFinite(parsed) ? null : parsed
                        }));
                      }}
                      placeholder="-76.67000"
                    />
                  </label>

                  <label className="settings-kiosk__field">
                    <span>Home port radius (NM)</span>
                    <input
                      type="range"
                      min={0.05}
                      max={2.5}
                      step={0.05}
                      value={homePortRadiusNm}
                      onChange={(event) => {
                        const parsed = Number.parseFloat(event.target.value);
                        const clamped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0.05), 2.5) : DEFAULT_TRIP_HOME_RADIUS_NM;
                        setHomePortConfig((current) => ({ ...current, radiusNm: clamped }));
                      }}
                    />
                    <strong>{homePortRadiusNm.toFixed(2)} NM</strong>
                  </label>
                </div>

                <div className="launcher-shell__actions settings-kiosk__actions">
                  <button
                    className="theme-toggle theme-toggle--primary"
                    type="button"
                    onClick={() => {
                      if (!preferredMapPosition) {
                        return;
                      }

                      setHomePortConfig((current) => ({
                        ...current,
                        latitude: preferredMapPosition.latitude,
                        longitude: preferredMapPosition.longitude
                      }));
                    }}
                    disabled={!preferredMapPosition}
                  >
                    Set from vessel position
                  </button>
                  <button
                    className="theme-toggle"
                    type="button"
                    onClick={() => {
                      if (!myVesselMapCenter) {
                        return;
                      }

                      setHomePortConfig((current) => ({
                        ...current,
                        latitude: myVesselMapCenter[0],
                        longitude: myVesselMapCenter[1]
                      }));
                    }}
                    disabled={!myVesselMapCenter}
                  >
                    Set from map center
                  </button>
                  <button
                    className="theme-toggle"
                    type="button"
                    onClick={() => setHomePortConfig((current) => ({ ...current, latitude: null, longitude: null }))}
                  >
                    Clear home port
                  </button>
                </div>
              </div>
            </div>
          </div>

          {vesselSubview === "bilgebuddy" ? (
          <section
            className={bilgeBuddyFullscreen ? "vessel-embed panel vessel-embed--fullscreen-mode" : "vessel-embed panel"}
            aria-label="BilgeBuddy monitoring"
          >
            {bilgeBuddyFullscreen ? (
              <div className="vessel-embed-fullscreen__toolbar">
                <div className="vessel-embed-fullscreen__toolbar-meta">
                  <span className="panel__eyebrow">Vessel</span>
                  <strong>BilgeBuddy</strong>
                </div>
                <button className="camera-fullscreen-btn" type="button" onClick={() => setBilgeBuddyFullscreen(false)}
                  aria-label="Exit fullscreen BilgeBuddy">
                  Exit fullscreen
                </button>
              </div>
            ) : null}

            <div className="vessel-embed__header">
              <div>
                <p className="panel__eyebrow">BilgeBuddy</p>
                <h3>Flooding, battery, and impact monitoring</h3>
              </div>
              <button className="camera-fullscreen-btn" type="button" onClick={() => setBilgeBuddyFullscreen(true)}
                aria-label="Enter fullscreen BilgeBuddy">⛶</button>
            </div>

            <div className={bilgeBuddyFullscreen ? "vessel-embed__frame-shell vessel-embed__frame-shell--fullscreen" : "vessel-embed__frame-shell"}>
              <iframe
                title="BilgeBuddy"
                src={BILGEBUDDY_EMBED_URL}
                className={bilgeBuddyFullscreen ? "vessel-embed__frame vessel-embed__frame--fullscreen" : "vessel-embed__frame"}
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
                allow="clipboard-read; clipboard-write; geolocation"
              />
            </div>
          </section>
          ) : null}
        </section>
      );
    }

    if (selectedNavId === "trips") {
      const selectedHistoricalTrip = selectedTripId ? (tripHistory.find((trip) => trip.id === selectedTripId) ?? null) : null;
      const isViewingHistoryTrip = Boolean(selectedHistoricalTrip);
      const tripDetail = selectedHistoricalTrip ?? tripSession;
      const isViewingCurrentTrip = Boolean(tripSession && tripDetail?.id === tripSession.id);
      const activeTripPoints = tripDetail?.breadcrumbs.map((point) => [point.latitude, point.longitude] as [number, number]) ?? [];
      const activeTripCenter = tripMapFollowRecent && mapRecentCenterPosition
        ? [mapRecentCenterPosition.latitude, mapRecentCenterPosition.longitude] as [number, number]
        : activeTripPoints.length > 0
          ? activeTripPoints[0]
          : preferredMapPosition
            ? [preferredMapPosition.latitude, preferredMapPosition.longitude] as [number, number]
            : fishingMapCenter;
      const breadcrumbRows = tripDetail?.breadcrumbs.slice(-25).reverse() ?? [];
      const routeBreadcrumbs = tripDetail?.breadcrumbs ?? [];
      const latestBreadcrumb = routeBreadcrumbs.length > 0 ? routeBreadcrumbs[routeBreadcrumbs.length - 1] : null;
      const parseTimestampMs = (value: string | null | undefined) => {
        if (!value) {
          return Number.NaN;
        }

        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : Number.NaN;
      };
      const distanceNmBetween = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
        const toRad = (degrees: number) => (degrees * Math.PI) / 180;
        const earthRadiusMeters = 6371000;
        const lat1 = toRad(a.latitude);
        const lat2 = toRad(b.latitude);
        const dLat = toRad(b.latitude - a.latitude);
        const dLng = toRad(b.longitude - a.longitude);

        const sinLat = Math.sin(dLat / 2);
        const sinLng = Math.sin(dLng / 2);
        const h = (sinLat * sinLat) + (Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng);
        const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
        const meters = earthRadiusMeters * c;
        return meters / 1852;
      };
      const firstBreadcrumbMs = routeBreadcrumbs.length > 0 ? parseTimestampMs(routeBreadcrumbs[0]?.time) : Number.NaN;
      const lastBreadcrumbMs = latestBreadcrumb ? parseTimestampMs(latestBreadcrumb.time) : Number.NaN;
      const startedAtParsedMs = parseTimestampMs(tripDetail?.startedAt);
      const endedAtParsedMs = parseTimestampMs(tripDetail?.endedAt ?? null);
      const startedAtMs = Number.isFinite(startedAtParsedMs) ? startedAtParsedMs : firstBreadcrumbMs;
      const fallbackEndMs = isViewingCurrentTrip ? Date.now() : lastBreadcrumbMs;
      const elapsedEndMs = Number.isFinite(endedAtParsedMs) ? endedAtParsedMs : fallbackEndMs;
      const elapsedFromFieldsMs = Number.isFinite(startedAtMs) && Number.isFinite(elapsedEndMs) && elapsedEndMs >= startedAtMs
        ? elapsedEndMs - startedAtMs
        : Number.NaN;
      const elapsedFromBreadcrumbsMs = Number.isFinite(firstBreadcrumbMs) && Number.isFinite(lastBreadcrumbMs) && lastBreadcrumbMs >= firstBreadcrumbMs
        ? lastBreadcrumbMs - firstBreadcrumbMs
        : Number.NaN;
      const elapsedMs = Number.isFinite(elapsedFromFieldsMs) && Number.isFinite(elapsedFromBreadcrumbsMs)
        ? Math.max(elapsedFromFieldsMs, elapsedFromBreadcrumbsMs)
        : (Number.isFinite(elapsedFromBreadcrumbsMs) ? elapsedFromBreadcrumbsMs : elapsedFromFieldsMs);
      const elapsedMinutes = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs / 60000)) : null;
      const elapsedHoursPart = elapsedMinutes === null ? null : Math.floor(elapsedMinutes / 60);
      const elapsedMinutesPart = elapsedMinutes === null ? null : elapsedMinutes % 60;
      const elapsedLabel = elapsedMinutesPart === null || elapsedHoursPart === null
        ? "--"
        : `${elapsedHoursPart}h ${elapsedMinutesPart.toString().padStart(2, "0")}m`;
      const startedAtLabel = Number.isFinite(startedAtMs)
        ? new Date(startedAtMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : "--";
      const endedAtLabel = Number.isFinite(endedAtParsedMs)
        ? new Date(endedAtParsedMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : Number.isFinite(lastBreadcrumbMs)
          ? new Date(lastBreadcrumbMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : null;
      const routeSpeedProfile = routeBreadcrumbs.map((point, index) => {
        const observedSpeed = typeof point.speedKnots === "number" && Number.isFinite(point.speedKnots)
          ? Math.max(0, point.speedKnots)
          : null;

        if (observedSpeed !== null) {
          return {
            knots: observedSpeed,
            derived: false
          };
        }

        const prev = routeBreadcrumbs[index - 1];
        const next = routeBreadcrumbs[index + 1];
        if (!prev || !next) {
          return { knots: 0, derived: true };
        }

        const prevTimeMs = parseTimestampMs(prev.time);
        const nextTimeMs = parseTimestampMs(next.time);
        if (!Number.isFinite(prevTimeMs) || !Number.isFinite(nextTimeMs) || nextTimeMs <= prevTimeMs) {
          return { knots: 0, derived: true };
        }

        const deltaHours = (nextTimeMs - prevTimeMs) / 3600000;
        const distanceNm = distanceNmBetween(prev, next);
        const derivedKnots = deltaHours > 0 ? distanceNm / deltaHours : 0;

        return {
          knots: Math.max(0, Math.min(55, derivedKnots)),
          derived: true
        };
      });

      const smoothedRouteSpeeds = routeSpeedProfile.map((entry, index) => {
        const previousSpeed = index > 0 ? routeSpeedProfile[index - 1]?.knots ?? entry.knots : entry.knots;
        const nextSpeed = index < routeSpeedProfile.length - 1 ? routeSpeedProfile[index + 1]?.knots ?? entry.knots : entry.knots;
        return (entry.knots * 0.58) + (previousSpeed * 0.26) + (nextSpeed * 0.16);
      });

      const sortedSmoothed = [...smoothedRouteSpeeds].sort((a, b) => a - b);
      const percentile95 = sortedSmoothed.length > 0
        ? sortedSmoothed[Math.min(sortedSmoothed.length - 1, Math.floor((sortedSmoothed.length - 1) * 0.95))] ?? 0
        : 0;
      const maxSmoothedSpeed = sortedSmoothed.length > 0 ? sortedSmoothed[sortedSmoothed.length - 1] ?? 0 : 0;
      const slowBandKnots = 6;
      const speedReferenceKnots = Math.max(12, percentile95, maxSmoothedSpeed, 1);

      const speedColorForBreadcrumb = (speedKnots: number) => {
        const shifted = Math.max(0, speedKnots - slowBandKnots);
        const range = Math.max(1, speedReferenceKnots - slowBandKnots);
        const normalized = Math.max(0, Math.min(1, shifted / range));
        const eased = Math.pow(normalized, 0.82);

        const hue = 1 + (126 * eased);
        const saturation = 88 - (6 * eased);
        const lightness = 36 + (22 * eased);
        return `hsl(${hue.toFixed(0)} ${saturation}% ${lightness.toFixed(0)}%)`;
      };

      const renderTripRouteMap = (mapClassName: string) => (
        <MapContainer key={`trip-map-${tripMapRenderNonce}`} center={activeTripCenter} zoom={11} minZoom={4} maxZoom={15} scrollWheelZoom attributionControl={false} className={mapClassName}>
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapCenterReporter onCenterChange={setTripMapCenter} />
          <TripRouteViewport routePoints={activeTripPoints} currentPosition={preferredMapPosition} />
          {homePortPoint ? (
            <>
              <Circle
                center={[homePortPoint.latitude, homePortPoint.longitude]}
                radius={homePortRadiusNm * 1852}
                pathOptions={{
                  color: "#f4c86a",
                  weight: 2,
                  dashArray: "7 7",
                  opacity: 0.9,
                  fillColor: "#f4c86a",
                  fillOpacity: 0.08
                }}
              >
                <Tooltip direction="top" offset={[0, -4]} opacity={0.92}>Home Port Radius ({homePortRadiusNm.toFixed(2)} NM)</Tooltip>
              </Circle>
              <CircleMarker
                center={[homePortPoint.latitude, homePortPoint.longitude]}
                radius={5}
                pathOptions={{
                  color: "#fff4cf",
                  weight: 2,
                  fillColor: "#f4c86a",
                  fillOpacity: 0.95
                }}
              >
                <Tooltip direction="top" offset={[0, -4]} opacity={0.92}>Home Port</Tooltip>
              </CircleMarker>
            </>
          ) : null}
          {activeTripPoints.length > 1 ? <Polyline positions={activeTripPoints} pathOptions={{ color: "#39d0ff", weight: 4, opacity: 0.9 }} /> : null}
          {routeBreadcrumbs.map((point, index) => (
            <CircleMarker
              key={`${point.time}-${index}`}
              center={[point.latitude, point.longitude]}
              radius={3.8}
              pathOptions={{
                color: "rgba(6, 16, 26, 0.88)",
                fillColor: speedColorForBreadcrumb(smoothedRouteSpeeds[index] ?? 0),
                fillOpacity: 0.96,
                weight: 1.05
              }}
            >
              <Popup>
                <div className="fishing-map-popup">
                  <strong>{new Date(point.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</strong>
                  <span>{point.latitude.toFixed(5)}°, {point.longitude.toFixed(5)}°</span>
                  <span>
                    Speed: {(() => {
                      const entry = routeSpeedProfile[index];
                      if (!entry) {
                        return "--";
                      }

                      return `${entry.knots.toFixed(1)} kt${entry.derived ? " (derived)" : ""}`;
                    })()}
                  </span>
                  <span>Heading: {typeof point.headingDegrees === "number" ? `${Math.round(point.headingDegrees)}°` : "--"}</span>
                  <span>Depth: {typeof point.depthFeet === "number" ? `${point.depthFeet.toFixed(1)} ft` : "--"}</span>
                  <span>Water: {typeof point.waterTempF === "number" ? `${point.waterTempF.toFixed(1)} F` : "--"}</span>
                  <span>RPM: {typeof point.engineRpmTotal === "number" ? point.engineRpmTotal.toFixed(0) : "--"}</span>
                  <span>Fuel: {typeof point.fuelBurnGph === "number" ? `${point.fuelBurnGph.toFixed(1)} gph` : "--"}</span>
                  {Array.isArray(point.engineSnapshots) && point.engineSnapshots.length > 0
                    ? point.engineSnapshots.map((engine) => (
                      <span key={`${point.time}-${engine.label}`}>
                        {engine.label}: RPM {typeof engine.rpm === "number" ? engine.rpm.toFixed(0) : "--"} | Oil {typeof engine.oilPressurePsi === "number" ? `${engine.oilPressurePsi.toFixed(1)} psi` : "--"} | Oil T {typeof engine.oilTempF === "number" ? `${engine.oilTempF.toFixed(1)} F` : "--"} | Coolant {typeof engine.coolantTempF === "number" ? `${engine.coolantTempF.toFixed(1)} F` : (typeof engine.tempF === "number" ? `${engine.tempF.toFixed(1)} F` : "--")} | Fuel {typeof engine.gph === "number" ? `${engine.gph.toFixed(1)} gph` : "--"} | V {typeof engine.voltage === "number" ? `${engine.voltage.toFixed(2)} V` : "--"}
                      </span>
                    ))
                    : null}
                  <small>{point.source}</small>
                </div>
              </Popup>
            </CircleMarker>
          ))}
          {preferredMapPosition ? (
            <CircleMarker
              center={[preferredMapPosition.latitude, preferredMapPosition.longitude]}
              radius={6}
              pathOptions={{
                color: "rgba(255, 255, 255, 0.95)",
                weight: 2,
                fillColor: "#5fd0ff",
                fillOpacity: 0.95
              }}
            >
              <Tooltip direction="top" offset={[0, -4]} opacity={0.92}>Current location ({preferredMapPositionSource})</Tooltip>
            </CircleMarker>
          ) : null}
        </MapContainer>
      );

      if (tripMapFullscreen) {
        return (
          <div className="camera-fullscreen weather-radar-fullscreen" role="dialog" aria-label="Fullscreen trip map">
            {renderTripRouteMap("trip-route-map trip-route-map--fullscreen")}
            <button className="camera-fullscreen__exit" type="button" onClick={() => setTripMapFullscreen(false)}
              aria-label="Exit fullscreen trip map">
              ✕
            </button>
          </div>
        );
      }

      return (
        <section className="panel drill-panel drill-panel--trips">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Trips</p>
              <h2>Current track and trip history</h2>
            </div>
            <div className="trip-header-actions">
              <span className={isViewingCurrentTrip || !isViewingHistoryTrip ? "status-pill status-pill--success" : "status-pill status-pill--warning"}>
                {isViewingCurrentTrip || !isViewingHistoryTrip ? "LIVE TRACK" : "HISTORY VIEW"}
              </span>
              <span className="status-pill status-pill--success">{tripHistory.length} saved</span>
              {lastTripSyncAt ? (
                <span className="trip-card__tag">Cruise sync {new Date(lastTripSyncAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              ) : null}
              {shouldShowTripCenterButton ? (
                <button className="camera-fullscreen-btn" type="button" onClick={centerTripMapOnBoat}
                  disabled={!mapRecentCenterPosition && !navigator.geolocation}
                  aria-label="Re-center trip map">
                  Re-center
                </button>
              ) : null}
              <button
                className="camera-fullscreen-btn map-mode-icon-btn"
                type="button"
                onClick={toggleTripMapHeadingMode}
                aria-label={mapHeadingMode === "north" ? "Switch to course-up" : "Switch to north-up"}
                title={mapHeadingMode === "north" ? "North-up (tap for Course-up)" : "Course-up (tap for North-up)"}
              >
                <span aria-hidden="true">⌖</span>
                <span>{mapHeadingMode === "north" ? "N↑" : "C↑"}</span>
              </button>
              <button className="camera-fullscreen-btn" type="button" onClick={() => setTripMapFullscreen(true)}
                aria-label="Enter fullscreen trip map">⛶</button>
            </div>
          </div>

          <div className="trip-controls">
            {tripSession ? (
              <button type="button" className="action-btn action-btn--danger" onClick={stopTripSession}>Stop trip</button>
            ) : (
              <button type="button" className="action-btn" onClick={startTripSession}>Start trip</button>
            )}
            {tripSession && !isViewingCurrentTrip ? (
              <button type="button" className="camera-fullscreen-btn" onClick={() => setSelectedTripId(tripSession.id)}>
                View current trip
              </button>
            ) : null}
            {!tripSession && tripHistory.length > 0 && !selectedTripId ? (
              <button type="button" className="camera-fullscreen-btn" onClick={() => setSelectedTripId(tripHistory[0].id)}>
                Open last saved trip
              </button>
            ) : null}
            {isViewingHistoryTrip ? (
              <button type="button" className="camera-fullscreen-btn" onClick={() => setSelectedTripId(tripSession?.id ?? null)}>
                Show live chart
              </button>
            ) : null}
            {tripHistory.length > 0 ? (
              <label className="trip-history-picker">
                <span>Review trip</span>
                <select
                  value={selectedHistoricalTrip?.id ?? ""}
                  onChange={(event) => setSelectedTripId(event.target.value || null)}
                  aria-label="Select a saved trip to review"
                >
                  <option value="">Live chart</option>
                  {tripHistory.map((trip) => (
                    <option key={trip.id} value={trip.id}>
                      {trip.title} • {trip.distanceNm.toFixed(2)} NM
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="trip-home-port-pill" role="status" aria-live="polite">
              <span>Home port</span>
              <strong>{homePortLabel}</strong>
              <small>Radius {homePortRadiusNm.toFixed(2)} NM</small>
            </div>
            <button
              type="button"
              className="camera-fullscreen-btn"
              onClick={() => {
                setSelectedNavId("vessel");
                setVesselSubview("myvessel");
              }}
            >
              Configure home port
            </button>
          </div>

          {tripControlMessage ? <p className="trip-control-message">{tripControlMessage}</p> : null}

          <div className="trip-mode-banner" role="status" aria-live="polite">
            {isViewingCurrentTrip
              ? "Live chart mode: current vessel track is the active route."
              : isViewingHistoryTrip
                ? "History mode: viewing a saved trip. Tap Show live chart to return to current tracking."
                : "Live chart mode: no saved trip selected; map stays centered on the vessel."}
          </div>

          <div className={tripDetail ? "trip-route-top" : "trip-route-top trip-route-top--map-only"}>
            {tripDetail ? (
              <div className="trip-detail panel trip-mfd-panel" style={{ padding: 16 }}>
                <div className="trip-detail__header">
                  <div>
                    <p className="panel__eyebrow">MFD track detail</p>
                    <h3 className="trip-detail__title">{tripDetail.title}</h3>
                  </div>
                  <span className="trip-card__tag">{tripDetail.tag}</span>
                </div>

                <div className="trip-mfd-grid">
                  <div><strong>{tripDetail.distanceNm.toFixed(2)}</strong><div>Distance NM</div></div>
                  <div><strong>{elapsedLabel}</strong><div>Elapsed</div></div>
                  <div><strong>{tripDetail.breadcrumbs.length}</strong><div>Track points</div></div>
                  <div><strong>{tripDetail.averageSpeedKnots.toFixed(1)}</strong><div>Avg kt</div></div>
                  <div><strong>{tripDetail.averageRpmTotal.toFixed(0)}</strong><div>Avg RPM</div></div>
                  <div><strong>{tripDetail.maxEngineTempF.toFixed(0)}</strong><div>Max eng temp F</div></div>
                  <div><strong>{latestBreadcrumb && typeof latestBreadcrumb.depthFeet === "number" ? `${latestBreadcrumb.depthFeet.toFixed(1)} ft` : "--"}</strong><div>Latest depth</div></div>
                  <div><strong>{latestBreadcrumb && typeof latestBreadcrumb.waterTempF === "number" ? `${latestBreadcrumb.waterTempF.toFixed(1)} F` : "--"}</strong><div>Latest water</div></div>
                  <div><strong>{latestBreadcrumb && typeof latestBreadcrumb.speedKnots === "number" ? `${latestBreadcrumb.speedKnots.toFixed(1)} kt` : "--"}</strong><div>Latest speed</div></div>
                  <div><strong>{latestBreadcrumb && typeof latestBreadcrumb.headingDegrees === "number" ? `${Math.round(latestBreadcrumb.headingDegrees)}°` : "--"}</strong><div>Latest heading</div></div>
                  <div><strong>{latestBreadcrumb && typeof latestBreadcrumb.fuelBurnGph === "number" ? `${latestBreadcrumb.fuelBurnGph.toFixed(1)} gph` : "--"}</strong><div>Latest fuel</div></div>
                  <div><strong>{latestBreadcrumb && typeof latestBreadcrumb.engineVoltageAvg === "number" ? `${latestBreadcrumb.engineVoltageAvg.toFixed(2)} V` : "--"}</strong><div>Latest bus V</div></div>
                </div>

                {latestBreadcrumb ? (
                  <div className="trip-mfd-latest-row">
                    <span>Position {latestBreadcrumb.latitude.toFixed(5)}, {latestBreadcrumb.longitude.toFixed(5)}</span>
                    <span>{new Date(latestBreadcrumb.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
                    <span>{latestBreadcrumb.source}</span>
                  </div>
                ) : null}

                <div className="trip-mfd-time-row">
                  <span>Start {startedAtLabel}</span>
                  <span>{isViewingCurrentTrip ? "Track is active" : (endedAtLabel ? `End ${endedAtLabel}` : "End --")}</span>
                </div>
              </div>
            ) : null}

            <div className="trip-route-map-shell trip-route-map-shell--top">
              {renderTripRouteMap("trip-route-map")}
            </div>
          </div>

          {breadcrumbRows.length > 0 ? (
            <div className="panel trip-breadcrumb-panel trip-breadcrumb-panel--padded">
              <div className="trip-breadcrumb-panel__header">
                <p className="panel__eyebrow trip-breadcrumb-panel__eyebrow">Breadcrumb data log</p>
                <span className="trip-breadcrumb-panel__count">Most recent {breadcrumbRows.length} points</span>
              </div>
              <div className="trip-breadcrumb-log">
                <table className="trip-breadcrumb-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Time</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Lat / Lon</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Speed</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>RPM</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Depth</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Water</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Engine Temp</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Fuel</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>V</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breadcrumbRows.map((point) => (
                      <tr key={`${tripDetail?.id ?? "trip"}-${point.time}`}>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {new Date(point.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)", whiteSpace: "nowrap" }}>
                          {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {typeof point.speedKnots === "number" ? `${point.speedKnots.toFixed(1)} kt` : "--"}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {typeof point.engineRpmTotal === "number" ? point.engineRpmTotal.toFixed(0) : "--"}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {typeof point.depthFeet === "number" ? `${point.depthFeet.toFixed(1)} ft` : "--"}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {typeof point.waterTempF === "number" ? `${point.waterTempF.toFixed(1)} F` : "--"}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {typeof point.engineTempAvgF === "number" ? `${point.engineTempAvgF.toFixed(0)} F` : "--"}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {typeof point.fuelBurnGph === "number" ? `${point.fuelBurnGph.toFixed(1)} gph` : "--"}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {typeof point.engineVoltageAvg === "number" ? `${point.engineVoltageAvg.toFixed(2)} V` : "--"}
                        </td>
                        <td style={{ padding: "6px 4px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                          {point.source}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="trips-panel">
            {tripHistory.length === 0 ? (
              <div className="trip-history-empty panel">
                <p className="panel__eyebrow">No saved trips yet</p>
                <strong>Start a trip to begin logging track history.</strong>
              </div>
            ) : null}
            {tripHistory.length > 0 ? tripHistory.map((trip) => (
              <TripSummaryCard
                key={trip.id || trip.title}
                trip={trip}
                selected={selectedTripId === trip.id || (isViewingCurrentTrip && tripSession?.id === trip.id)}
                onSelect={setSelectedTripId}
                onDelete={(tripId) => {
                  const selected = tripHistory.find((entry) => entry.id === tripId);
                  const label = selected?.title ?? "this trip";
                  if (selected && (selected.origin ?? "local") !== "local") {
                    setTripControlMessage("Cruise Report trips are read-only in this view.");
                    return;
                  }
                  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) {
                    return;
                  }

                  deleteSavedTrip(tripId);
                }}
                deleteDisabled={tripSession?.id === trip.id || (trip.origin ?? "local") !== "local"}
              />
            )) : null}
          </div>
        </section>
      );
    }

    if (selectedNavId === "more") {
      const btHint = btScanning
        ? "Scanning for nearby devices..."
        : btScanResults.length === 0
          ? "Put the stereo in pairing mode, then tap scan. Use Forget device if you need a clean re-pair."
          : `${btScanResults.length} device${btScanResults.length === 1 ? "" : "s"} found.`;

      return (
        <section className="panel drill-panel settings-kiosk">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Settings</p>
              <h2>System controls</h2>
            </div>
            <div className="settings-header-actions" />
          </div>

          <div className="settings-kiosk__pager settings-kiosk__pager--compact" role="tablist" aria-label="Settings pages">
            <button
              type="button"
              role="tab"
              aria-selected={settingsSubview === "bluetooth"}
              className={settingsSubview === "bluetooth" ? "settings-kiosk__pager-btn settings-kiosk__pager-btn--active" : "settings-kiosk__pager-btn"}
              style={compactSettingsTabStyle}
              onClick={() => setSettingsSubview("bluetooth")}
            >
              Bluetooth
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={settingsSubview === "wifi"}
              className={settingsSubview === "wifi" ? "settings-kiosk__pager-btn settings-kiosk__pager-btn--active" : "settings-kiosk__pager-btn"}
              style={compactSettingsTabStyle}
              onClick={() => {
                setSettingsSubview("wifi");
                setWifiHasManualScan(false);
                setWifiScanning(false);
              }}
            >
              Wi‑Fi
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={settingsSubview === "remote"}
              className={settingsSubview === "remote" ? "settings-kiosk__pager-btn settings-kiosk__pager-btn--active" : "settings-kiosk__pager-btn"}
              style={compactSettingsTabStyle}
              onClick={() => setSettingsSubview("remote")}
            >
              Remote
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={settingsSubview === "updates"}
              className={settingsSubview === "updates" ? "settings-kiosk__pager-btn settings-kiosk__pager-btn--active" : "settings-kiosk__pager-btn"}
              style={compactSettingsTabStyle}
              onClick={() => setSettingsSubview("updates")}
            >
              Updates
            </button>
          </div>

          <div className="settings-kiosk__body">
            {settingsSubview === "bluetooth" ? (
              <>
                <div className="home-panel__quick-grid settings-kiosk__summary settings-kiosk__summary--compact">
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Bluetooth device</span>
                    <strong>{bluetoothState.device}</strong>
                    <span>{bluetoothState.audioRoute}</span>
                  </article>
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Connection</span>
                    <strong>{bluetoothState.connected ? "Connected" : "Not connected"}</strong>
                    <span>{bluetoothState.lastAction}</span>
                  </article>
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Command state</span>
                    <strong>{bluetoothState.ready ? "Ready" : "Configuration required"}</strong>
                    <span>{bluetoothState.updatedAt ? formatTimestamp(bluetoothState.updatedAt) : "Unknown"}</span>
                  </article>
                </div>

                <div className="launcher-shell__actions settings-kiosk__actions">
                  <button
                    className="theme-toggle theme-toggle--primary"
                    type="button"
                    onClick={() => void handleBluetoothAction("reconnect")}
                    disabled={!bluetoothState.config.reconnectConfigured || runningBtWorkflowId !== null}
                  >
                    Reconnect now
                  </button>
                  <button className="theme-toggle" type="button" onClick={() => void handleBluetoothAction("route-audio")} disabled={!bluetoothState.config.routeConfigured}>Route audio</button>
                  <button
                    className="theme-toggle"
                    type="button"
                    onClick={() => void handleForgetBtDevice()}
                    disabled={!bluetoothState.config.disconnectConfigured || runningBtWorkflowId !== null}
                  >
                    Forget device
                  </button>
                </div>

                <div className="bt-scan-section settings-kiosk__scan">
                  <p className="panel__eyebrow">Find and configure stereo</p>
                  <button
                    className="theme-toggle theme-toggle--primary"
                    type="button"
                    onClick={() => void handleBluetoothScan()}
                    disabled={btScanning || runningBtWorkflowId !== null}
                  >
                    {btScanning ? "Scanning..." : "Scan for stereo"}
                  </button>
                  <p className="settings-kiosk__hint">{btHint}</p>
                  {!btScanning && btScanResults.length > 0 && (
                    <div className="bt-device-list">
                      {btScanResults.map((device) => (
                        <div key={device.mac} className="bt-device-item">
                          <div className="bt-device-item__info">
                            <strong>{device.name}</strong>
                            <span>{device.mac}</span>
                          </div>
                          <button
                            className="theme-toggle theme-toggle--primary"
                            type="button"
                            disabled={runningBtWorkflowId !== null}
                            onClick={() => void handleSetBtDevice(device.mac, device.name)}
                          >
                            {runningBtWorkflowId === device.mac ? "Pairing..." : "Pair"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <button className="theme-toggle" type="button" onClick={() => void handleBluetoothDiagnostics()} disabled={runningBluetoothDiagnostics}>
                  {runningBluetoothDiagnostics ? "Running diagnostics..." : "Diagnostics"}
                </button>

                {bluetoothDiagnostics ? (
                  <div className="settings-kiosk__diagnostics">
                    <p>Diagnostics: {bluetoothDiagnostics.ready ? "Pass" : "Fail"}</p>
                    <p>Checked: {new Date(bluetoothDiagnostics.checkedAt).toLocaleString()}</p>
                  </div>
                ) : null}
              </>
            ) : null}

            {settingsSubview === "wifi" ? (
              <>
                {(() => {
                  const connectedNetwork = wifiNetworks.find((network) => network.connected) ?? null;
                  const connectedSignal = connectedNetwork ? `${connectedNetwork.signal}% signal` : "Signal unavailable";

                  return (
                <div className="home-panel__quick-grid settings-kiosk__summary">
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Current network</span>
                    <strong>{connectedNetwork?.ssid ?? "Not joined"}</strong>
                    <span>{wifiStatus ?? (connectedNetwork ? connectedSignal : "No active Wi‑Fi connection")}</span>
                  </article>
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Visible networks</span>
                    <strong>{wifiHasManualScan ? wifiNetworks.length : "--"}</strong>
                    <span>{wifiScanning ? "Scanning for Wi‑Fi..." : wifiHasManualScan ? "Fresh network list" : "Tap Scan Wi‑Fi to load nearby networks"}</span>
                  </article>
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Security</span>
                    <strong>{connectedNetwork?.security.toUpperCase() ?? "Unknown"}</strong>
                    <span>{connectedNetwork?.ssid ?? "No network selected"}</span>
                  </article>
                </div>
                  );
                })()}

                <div className="launcher-shell__actions settings-kiosk__actions">
                  <button className="theme-toggle theme-toggle--primary" type="button" onClick={() => void handleWifiScan()} disabled={wifiScanning}>
                    {wifiScanning ? "Scanning..." : "Scan Wi‑Fi"}
                  </button>
                  <button
                    className="theme-toggle"
                    type="button"
                    onClick={() => void handleWifiDisconnect()}
                    disabled={wifiDisconnecting || wifiJoining !== null || !wifiNetworks.some((network) => network.connected)}
                  >
                    {wifiDisconnecting ? "Disconnecting..." : "Disconnect"}
                  </button>
                </div>

                <div className="bt-scan-section settings-kiosk__scan">
                  {wifiHasManualScan && wifiNetworks.length > 0 ? (
                    <div className="bt-device-list wifi-network-list">
                      {wifiNetworks.map((network) => (
                        <div key={`${network.ssid}-${network.bssid}`} className={network.connected ? "bt-device-item wifi-network-item wifi-network-item--connected" : "bt-device-item wifi-network-item"}>
                          <div className="bt-device-item__info">
                            <strong>
                              {network.ssid}
                              {network.connected ? <span className="wifi-network-item__badge">Connected</span> : null}
                            </strong>
                            <span>{network.security.toUpperCase()} · {network.signal}% signal · CH {network.channel ?? "?"}</span>
                          </div>
                          <button
                            className="theme-toggle theme-toggle--primary"
                            type="button"
                            disabled={wifiJoining !== null || wifiDisconnecting}
                            onClick={() => void handleWifiJoinClick(network)}
                          >
                            {wifiJoining === network.ssid ? "Connecting..." : network.connected ? "Reconnect" : "Join"}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : !wifiScanning ? (
                    <p className="settings-kiosk__hint">{wifiHasManualScan ? "No Wi‑Fi networks found yet. Scan to refresh the list." : "Tap Scan Wi‑Fi to show nearby networks and Join options."}</p>
                  ) : null}
                </div>
              </>
            ) : null}

            {settingsSubview === "remote" ? (
              <>
                <div className="home-panel__quick-grid settings-kiosk__summary">
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Remote mode</span>
                    <strong>{remoteAccessStatus.mode}</strong>
                    <span>{remoteAccessStatus.notes}</span>
                  </article>
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Tunnel status</span>
                    <strong>{remoteAccessStatus.status}</strong>
                    <span>Checked: {formatTimestamp(remoteAccessStatus.lastCheckedAt)}</span>
                  </article>
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Access links</span>
                    <strong>{remoteAccessStatus.viewUrl ? "Configured" : "Unset"}</strong>
                    <span>{remoteAccessStatus.troubleshootUrl || "No troubleshoot URL configured"}</span>
                  </article>
                </div>

                <div className="launcher-shell__actions settings-kiosk__actions">
                  <button className="theme-toggle" type="button" onClick={() => void handleRemoteTunnelAction("status")} disabled={runningRemoteTunnelAction !== null}>Refresh tunnel</button>
                  <button className="theme-toggle" type="button" onClick={() => void handleRemoteTunnelAction("start")} disabled={runningRemoteTunnelAction !== null}>Start tunnel</button>
                  <button className="theme-toggle" type="button" onClick={() => void handleRemoteTunnelAction("restart")} disabled={runningRemoteTunnelAction !== null}>Restart tunnel</button>
                  <button className="theme-toggle theme-toggle--primary" type="button" onClick={() => window.location.assign(signalKAdminUrl)}>
                    Open Signal K Admin
                  </button>
                </div>

                <button className="theme-toggle" type="button" onClick={() => void refreshRemoteOpsStatus()}>
                  Refresh remote page
                </button>

                {remoteAccessStatus.lastOutput ? (
                  <pre className="remote-ops-output" aria-label="Remote tunnel command output">
                    {remoteAccessStatus.lastOutput}
                  </pre>
                ) : null}
              </>
            ) : null}

            {settingsSubview === "updates" ? (
              <>
                <div className="home-panel__quick-grid settings-kiosk__summary">
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Current</span>
                    <strong>{activeSummary.update.currentVersion}</strong>
                    <span>{activeSummary.update.channel}</span>
                  </article>
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Latest</span>
                    <strong>{activeSummary.update.latestVersion ?? "Not checked"}</strong>
                    <span>{formatTimestamp(activeSummary.update.lastCheckedAt)}</span>
                  </article>
                  <article className="home-panel__quick-card">
                    <span className="home-panel__quick-label">Onboard script</span>
                    <strong>{remoteUpdateStatus.configured ? "Configured" : "Not configured"}</strong>
                    <span>{remoteUpdateStatus.notes}</span>
                  </article>
                </div>

                <div className="launcher-shell__actions settings-kiosk__actions">
                  <button className="theme-toggle" type="button" onClick={() => void refreshUpdateStatus()}>
                    Check version feed
                  </button>
                  <button className="theme-toggle theme-toggle--primary" type="button" onClick={() => void handleRunRemoteUpdate()} disabled={runningRemoteUpdate || !remoteUpdateStatus.configured}>
                    {runningRemoteUpdate ? "Running update..." : "Run onboard update"}
                  </button>
                  <button className="theme-toggle" type="button" onClick={() => void refreshRemoteOpsStatus()}>
                    Refresh update status
                  </button>
                </div>

                <div className="settings-kiosk__diagnostics">
                  <p>Last run: {formatTimestamp(remoteUpdateStatus.lastRunAt)}</p>
                  <p>Last finish: {formatTimestamp(remoteUpdateStatus.lastFinishedAt)}</p>
                  <p>Last result: {remoteUpdateStatus.lastSuccess === null ? "Unknown" : remoteUpdateStatus.lastSuccess ? "Success" : "Failed"}</p>
                </div>
              </>
            ) : null}
          </div>

          {remoteOpsError ? <p className="settings-kiosk__error">Remote: {remoteOpsError}</p> : null}
        </section>
      );
    }

    return (
      <section className="panel drill-panel">
        <div className="panel__header">
          <div>
            <p className="panel__eyebrow">{selectedNav.label}</p>
            <h2>{selectedNav.detail}</h2>
          </div>
          <span className="status-pill status-pill--success">Ready</span>
        </div>
        <p>{selectedNavApp?.description ?? "Open a section from the Garmin-style tab bar to drill in."}</p>
      </section>
    );
  }

  async function handleCloseRuntimePanel() {
    setSelectedNavId("home");
    setShowRuntimePanel(false);

    try {
      const state = await sendReturnHomeRequest();
      setLauncherState(state);
    } catch {
      setLauncherState(defaultLauncherState());
    }
  }

  async function handleKillLaunchedApp() {
    const restoreCandidate = findLaunchTargetById(launcherState.appId);
    const appToRestore = restoreCandidate?.id ?? lastRestorableAppId;
    setKillingLaunchedApp(true);

    try {
      const state = await sendKillLaunchedAppRequest();
      setLauncherState({
        ...state,
        appId: "",
        name: "",
        subtitle: ""
      });
      if (appToRestore) {
        setLastRestorableAppId(appToRestore);
      }
      setShowRuntimePanel(false);
      setOnline(true);
    } catch {
      setLauncherState((current) => ({
        ...current,
        status: "Kill request failed",
        message: "Could not terminate the active launched app process.",
        launchMethod: "Task kill",
        startedAt: new Date().toISOString()
      }));
      setOnline(false);
    } finally {
      setKillingLaunchedApp(false);
    }
  }

  async function handleRestoreLaunchedApp() {
    const target = findLaunchTargetById(lastRestorableAppId) ?? findLaunchTargetById(launcherState.appId);
    if (!target) {
      return;
    }

    const section: "streaming" | "music" = streamingTargets.some((candidate) => candidate.id === target.id)
      ? "streaming"
      : "music";

    setRestoringLaunchedApp(true);
    try {
      await launchAppTarget(target, section);
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setRestoringLaunchedApp(false);
    }
  }

  function selectNavItem(itemId: string) {
    setSelectedNavId(itemId);
  }

  function handleNavPointerDown(itemId: string, pointerType: string) {
    if (pointerType === "mouse") {
      return;
    }

    lastTouchNavSelectionRef.current = { id: itemId, at: Date.now() };
    selectNavItem(itemId);
  }

  function handleNavClick(itemId: string) {
    const lastTouchSelection = lastTouchNavSelectionRef.current;
    if (lastTouchSelection && lastTouchSelection.id === itemId && Date.now() - lastTouchSelection.at < 700) {
      return;
    }

    selectNavItem(itemId);
  }

  const isNativeRuntime = launcherState.runtime.trim().toLowerCase() === "native app process";
  const activeLaunchTarget = findLaunchTargetById(launcherState.appId);
  const appIsRunning = isNativeRuntime && launcherState.status === "Launched";
  const killTargetName = appIsRunning ? launcherState.name : "";
  const killTargetLogoPath = appIsRunning
    ? activeLaunchTarget?.logoPath
    : undefined;
  const restoreTarget = !appIsRunning ? findLaunchTargetById(lastRestorableAppId) : null;
  const restoreTargetName = restoreTarget?.name ?? "";
  const restoreTargetLogoPath = restoreTarget?.logoPath;

  // Clean remote-only layout — no dashboard tiles, just controls + app launch
  if (remoteMode) {
    return (
      <div className="shell shell--remote">
        <BootSplash visible={!summary && online} />
        <div className="remote-only-shell">
          <header className="remote-only-header">
            <img className="home-header__logo" src="/brand/logo.png" alt="Palmer Lou" />
            <div className="remote-only-header__status">
              <span className={`home-header__dot ${nmeaOnline ? "home-header__dot--online" : "home-header__dot--offline"}`} />
              <span className="home-header__time">{nowLabel}</span>
            </div>
            {killTargetName ? (
              <button className="kill-app-button kill-app-button--inline" type="button"
                onClick={() => void handleKillLaunchedApp()} disabled={killingLaunchedApp}>
                <span className="kill-app-button__name">{killingLaunchedApp ? "Closing…" : `✕ ${killTargetName}`}</span>
              </button>
            ) : null}
            {restoreTargetName ? (
              <button className="restore-app-button restore-app-button--inline" type="button"
                onClick={() => void handleRestoreLaunchedApp()} disabled={restoringLaunchedApp || launching || killingLaunchedApp}>
                <span className="restore-app-button__name">{restoringLaunchedApp ? "Restoring…" : `↺ ${restoreTargetName}`}</span>
              </button>
            ) : null}
          </header>

          <div className="remote-only-body">
            <section className="remote-apps-section">
              <p className="remote-section-label">Video</p>
              <div className="remote-app-row">
                {streamingTargets.map((target) => (
                  <button key={target.id} type="button"
                    className={`remote-app-btn${launcherState.appId === target.id ? " remote-app-btn--active" : ""}`}
                    onClick={() => void launchAppTarget(target, "streaming")} disabled={launching}>
                    <BrandGlyph logoPath={target.logoPath} className="remote-app-btn__icon" />
                  </button>
                ))}
              </div>
              <p className="remote-section-label">Music</p>
              <div className="remote-app-row">
                {musicTargets.map((target) => (
                  <button key={target.id} type="button"
                    className={`remote-app-btn${launcherState.appId === target.id ? " remote-app-btn--active" : ""}`}
                    onClick={() => void launchAppTarget(target, "music")} disabled={launching}>
                    <BrandGlyph logoPath={target.logoPath} className="remote-app-btn__icon" />
                  </button>
                ))}
              </div>
            </section>

            {renderRemoteControlPad()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={remoteMode ? "shell shell--remote" : "shell"}>
      <BootSplash visible={!summary && online} />
      <div className="shell__glow shell__glow--aqua" />
      <div className="shell__glow shell__glow--gold" />

      {showRuntimePanel && !isNativeRuntime ? (
        <div className="runtime-panel runtime-panel--fullscreen" role="dialog" aria-modal="true" aria-label={`${launcherState.name} app launch overlay`}>
          <div className="runtime-panel__surface">
            <div className="runtime-panel__chrome">
              <span className="runtime-panel__dot runtime-panel__dot--aqua" />
              <span className="runtime-panel__dot runtime-panel__dot--gold" />
              <span className="runtime-panel__dot runtime-panel__dot--teal" />
              <span className="runtime-panel__title">{launcherState.name || "Palmer Lou"}</span>
              <span className="runtime-panel__runtime">{launcherState.runtime}</span>
              <button
                type="button"
                className="runtime-panel__close"
                aria-label="Close launched app"
                onClick={() => void handleCloseRuntimePanel()}
              >
                ×
              </button>
            </div>

            <div className="runtime-panel__hero">
              <span className="runtime-panel__brand">{launcherState.launchMethod}</span>
              <h3>{launcherState.name}</h3>
              <p>{launcherState.message}</p>
              <div className="runtime-panel__actions">
                <button type="button" className="theme-toggle theme-toggle--primary" onClick={() => void handleCloseRuntimePanel()}>
                  Back to home
                </button>
              </div>
            </div>

            <div className="runtime-panel__status">
              <div>
                <span className="runtime-panel__status-label">Status</span>
                <strong>{launcherState.status}</strong>
              </div>
              <div>
                <span className="runtime-panel__status-label">Method</span>
                <strong>{launcherState.launchMethod}</strong>
              </div>
              <div>
                <span className="runtime-panel__status-label">Started</span>
                <strong>{new Date(launcherState.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <section className={remoteMode ? "garmin-frame garmin-frame--remote" : "garmin-frame"} aria-label="Garmin display shell">
        <HomeHeader
          online={nmeaOnline}
          nowLabel={nowLabel}
          remoteMode={remoteMode}
          qrImageSrc={assetUrl("/brand/remote-qr.svg")}
          killingApps={killingLaunchedApp}
          killTargetName={killTargetName}
          killTargetLogoPath={killTargetLogoPath}
          restoringApp={restoringLaunchedApp || launching}
          restoreTargetName={restoreTargetName}
          restoreTargetLogoPath={restoreTargetLogoPath}
          {...(!remoteMode ? { onRestoreApp: () => void handleRestoreLaunchedApp() } : {})}
          {...(!remoteMode ? { onKillApps: () => void handleKillLaunchedApp() } : {})}
        />

        <main className={remoteMode ? "dashboard garmin-viewport dashboard--remote" : "dashboard garmin-viewport"}>
          {!online ? <OfflineState message="The UI is running from a fallback summary until the backend responds." onRetry={() => window.location.reload()} /> : null}
          {renderRemoteControlPad()}

          <section className="garmin-content garmin-content--viewport">
            {renderSectionContent()}
          </section>
        </main>

        <nav className={remoteMode ? "garmin-tabbar garmin-tabbar--remote" : "garmin-tabbar"} aria-label="Palmer Lou navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === selectedNavId ? "garmin-tabbar__item garmin-tabbar__item--active" : "garmin-tabbar__item"}
              onPointerDown={(event) => handleNavPointerDown(item.id, event.pointerType)}
              onClick={() => handleNavClick(item.id)}
            >
              <span className="garmin-tabbar__label">{item.label}</span>
              <span className="garmin-tabbar__detail">{item.detail}</span>
            </button>
          ))}
        </nav>
      </section>

      {wifiJoinDialog ? (
        <div className="wifi-join-modal" role="dialog" aria-modal="true" aria-label="Join Wi‑Fi network">
          <div className="wifi-join-modal__card">
            <p className="panel__eyebrow">Join network</p>
            <h3>{wifiJoinDialog.ssid}</h3>
            <p className="wifi-join-modal__meta">Security: {wifiJoinDialog.security.toUpperCase()}</p>
            <label className="settings-kiosk__field">
              <span>Password</span>
              <input
                type="password"
                value={wifiJoinPassword}
                onChange={(event) => setWifiJoinPassword(event.target.value)}
                autoFocus
                autoComplete="new-password"
                placeholder={wifiJoinDialog.security === "open" ? "Optional for open networks" : "Enter network password"}
              />
            </label>
            <div className="wifi-join-modal__actions">
              <button className="theme-toggle" type="button" onClick={() => { setWifiJoinDialog(null); setWifiStatus("Join cancelled"); }}>
                Cancel
              </button>
              <button className="theme-toggle theme-toggle--primary" type="button" onClick={() => void submitWifiJoinDialog()}>
                Join network
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
