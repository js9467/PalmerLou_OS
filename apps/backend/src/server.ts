import http from "node:http";
import { createReadStream, existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { applyBluetoothAction, getBluetoothState, runBluetoothDiagnostics, scanBluetoothDevices, configureBluetoothDevice, type BluetoothAction } from "./bluetooth.js";
import { dashboardSummary } from "./mock-data.js";
import { getNmeaTelemetry } from "./nmea.js";
import { getLauncherState, killLaunchedApp, launchApp, returnToHome } from "./launcher.js";
import { getRemoteAccessStatus, getRemoteUpdateStatus, runRemoteControlAction, runRemoteTypeAction, runRemoteUpdate, runTunnelAction, type RemoteAccessStatus, type RemoteControlAction } from "./remote.js";
import { getSignalKIntegrationStatus, loadCruiseReportTrips, loadWindyForecast } from "./signalk-integrations.js";
import { resolveUpdateStatus } from "./update.js";
import { disconnectWifiNetwork, joinWifiNetwork, scanWifiNetworks } from "./wifi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const stateDir = path.resolve(repoRoot, "state");
const homePortConfigPath = path.resolve(stateDir, "home-port-config.json");
const uiDist = path.resolve(repoRoot, "apps/ui/dist");
const brandArtwork = path.resolve(repoRoot, "images/Palmer Lou Artwork.png");
const port = Number(process.env.PORT ?? 8787);
const requireBluetoothReady = (process.env.PALMER_LOU_REQUIRE_BLUETOOTH_READY ?? "false").toLowerCase() === "true";
const currentVersion = dashboardSummary.version.currentVersion;
const currentChannel = dashboardSummary.version.channel;
const oceanTileCache = new Map<string, { expiresAt: number; contentType: string; body: Buffer }>();
const OCEAN_TILE_CACHE_TTL_MS = 1000 * 60 * 15;
const OCEAN_TILE_CACHE_LIMIT = 1200;
const OCEAN_CURRENT_VECTOR_CACHE_TTL_MS = 1000 * 60 * 5;
const OCEAN_CURRENT_RATE_LIMIT_COOLDOWN_MS = 1000 * 60;
const stormRadarTileCache = new Map<string, { expiresAt: number; contentType: string; body: Buffer }>();
const STORM_RADAR_TILE_CACHE_TTL_MS = 1000 * 60 * 5;
const STORM_RADAR_TILE_CACHE_LIMIT = 1600;
const STORM_RADAR_FRAME_TTL_MS = 1000 * 60 * 3;
const STORM_RADAR_MAX_NATIVE_ZOOM = 8;
const CAMERA_STREAM_STOP_DELAY_MS = 5000;
const EXTERNAL_WEATHER_CACHE_TTL_MS = 1000 * 60 * 5;
const WEATHER_FETCH_TIMEOUT_MS = 12000;
const DEFAULT_HOME_LAT = Number.parseFloat(process.env.PALMER_LOU_HOME_LAT ?? "34.7229");
const DEFAULT_HOME_LON = Number.parseFloat(process.env.PALMER_LOU_HOME_LON ?? "-76.7260");
const TRANSPARENT_PNG_BUFFER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgBqWcN0AAAAASUVORK5CYII=", "base64");
const SIGNALK_PROXY_BASE_URL = (process.env.PALMER_LOU_SIGNALK_PROXY_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

type HomePortConfig = {
  latitude: number | null;
  longitude: number | null;
  radiusNm: number;
  updatedAt: string;
};

let cameraStreamProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
let cameraStreamStopTimer: NodeJS.Timeout | null = null;
const cameraStreamClients = new Set<http.ServerResponse>();
let cameraLastStartAt = 0;
let cameraLastFrameAt = 0;
let cameraRestartCount = 0;
let cameraLastError: string | null = null;
let cameraLastExitCode: number | null = null;
let cameraLastExitSignal: NodeJS.Signals | null = null;
let cameraLastStderr = "";
let cameraLastCandidateList: string[] = [];
let externalMarineWeatherCache: {
  expiresAt: number;
  key: string;
  data: {
    windKnots: number | null;
    barometerHpa: number | null;
    waterTempF: number | null;
    tideFeet: number | null;
    tideTrend: "rising" | "falling" | "steady" | null;
    source: string;
    cards: Array<{
      label: string;
      windKnots: number;
      waveFeet: number;
      outlook: string;
      observedAt: string | null;
    }>;
  };
} | null = null;

type RainViewerFrame = {
  path: string;
  time: number | null;
  kind: "past" | "nowcast" | "future";
};

type OceanCurrentVector = {
  latitude: number;
  longitude: number;
  speedKmh: number;
  speedKnots: number;
  directionDegrees: number;
  observedAt: string;
};
let stormRadarFrameCache: {
  fetchedAt: number;
  host: string;
  frame: RainViewerFrame | null;
  timeline: RainViewerFrame[];
} | null = null;

type OceanTileSource = "sst" | "chlorophyll" | "currents";

type OceanBuoyObservation = {
  stationId: string;
  latitude: number;
  longitude: number;
  observedAt: string;
  waterTempC: number | null;
  airTempC: number | null;
  windSpeedMps: number | null;
  waveHeightM: number | null;
  pressureHpa: number | null;
};

const oceanCurrentVectorCache = new Map<string, { expiresAt: number; vectors: OceanCurrentVector[]; source: string }>();
let lastOceanCurrentVectorSnapshot: { vectors: OceanCurrentVector[]; source: string; generatedAt: number } | null = null;
let oceanCurrentRateLimitedUntil = 0;
type FishingAdvisorZone = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  radiusNm: number;
  score: number;
  confidence: "high" | "medium" | "low";
  reasoning: string[];
};

type FishingOceanSignalFront = {
  id: string;
  kind: "sst" | "convergence";
  label: string;
  strength: "high" | "medium" | "low";
  score: number;
  gradientFPer10Nm: number;
  distanceNm: number;
  midpoint: {
    latitude: number;
    longitude: number;
  };
  points: [number, number][];
  notes: string[];
};

type FishingOceanSignals = {
  generatedAt: string;
  buoyCount: number;
  evaluatedPairs: number;
  fronts: FishingOceanSignalFront[];
};

type FishingAdvisorResult = {
  generatedAt: string;
  species: string;
  summary: string;
  recommendation: string;
  bestWindow: string;
  temperatureRangeF: {
    min: number;
    max: number;
  };
  zones: FishingAdvisorZone[];
  oceanSignals: FishingOceanSignals;
  notes: string[];
};

type GeoPoint = {
  latitude: number;
  longitude: number;
};

type AdvisorCatchInput = {
  species: string;
  bait: string;
  timestamp: string;
  latitude: number | null;
  longitude: number | null;
};

type SpeciesScoreFactor = {
  label: string;
  value: string;
  score: number;
};

type SpeciesIntelEntry = {
  species: string;
  score: number;
  confidence: "high" | "medium" | "low";
  recommended: boolean;
  bestLatitude: number | null;
  bestLongitude: number | null;
  bestLocationLabel: string;
  radiusNm: number;
  temperatureRangeF: { min: number; max: number };
  color: string;
  depthBand: string;
  currentSignal: string;
  factors: {
    sst: SpeciesScoreFactor;
    sstFront: SpeciesScoreFactor;
    convergence: SpeciesScoreFactor;
    chlorophyllProxy: SpeciesScoreFactor;
    dataAge: SpeciesScoreFactor;
    catchHistory: SpeciesScoreFactor;
  };
  points: [number, number][];
  notes: string[];
};

type AllSpeciesIntelResponse = {
  generatedAt: string;
  referenceLatitude: number | null;
  referenceLongitude: number | null;
  buoyCount: number;
  frontCount: number;
  species: SpeciesIntelEntry[];
  oceanSignals: FishingOceanSignals;
};

type FishingAdvisorContext = {
  referenceLatitude: number;
  referenceLongitude: number;
  maxRadiusNm: number;
};

const NDBC_LATEST_OBS_URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt";
const BUOY_CACHE_TTL_MS = 1000 * 60 * 10;
let buoyCache: { fetchedAt: number; data: OceanBuoyObservation[] } | null = null;

const OCEAN_TILE_CONFIG_BY_SOURCE: Record<OceanTileSource, { layer: string; matrixSet: string; maxTileMatrix: number }> = {
  sst: {
    layer: "GHRSST_L4_MUR_Sea_Surface_Temperature",
    matrixSet: "GoogleMapsCompatible_Level7",
    maxTileMatrix: 7
  },
  chlorophyll: {
    layer: "MODIS_Aqua_L2_Chlorophyll_A",
    matrixSet: "GoogleMapsCompatible_Level7",
    maxTileMatrix: 7
  },
  currents: {
    layer: "OSCAR_Sea_Surface_Currents_Zonal",
    matrixSet: "GoogleMapsCompatible_Level6",
    maxTileMatrix: 6
  }
};

function setMetricValue(summary: { metrics: Array<{ label: string; value: string; unit: string; accent: string }> }, label: string, value: string, unit: string) {
  const index = summary.metrics.findIndex((metric) => metric.label.toLowerCase() === label.toLowerCase());
  if (index < 0) {
    return;
  }

  const metric = summary.metrics[index];
  if (!metric) {
    return;
  }

  metric.value = value;
  metric.unit = unit;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function resolveWeatherReferencePoint(nmeaTelemetry: { latitude: number | null; longitude: number | null } | null) {
  if (typeof nmeaTelemetry?.latitude === "number" && typeof nmeaTelemetry?.longitude === "number") {
    return {
      latitude: nmeaTelemetry.latitude,
      longitude: nmeaTelemetry.longitude,
      source: "nmea"
    };
  }

  if (Number.isFinite(DEFAULT_HOME_LAT) && Number.isFinite(DEFAULT_HOME_LON)) {
    return {
      latitude: DEFAULT_HOME_LAT,
      longitude: DEFAULT_HOME_LON,
      source: "home-port"
    };
  }

  return null;
}

function pickNearestIndex(times: string[], targetMs: number) {
  if (!Array.isArray(times) || times.length === 0) {
    return -1;
  }

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < times.length; index += 1) {
    const value = times[index];
    if (!value) {
      continue;
    }

    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      continue;
    }

    const distance = Math.abs(ms - targetMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestDistance === Number.POSITIVE_INFINITY ? -1 : bestIndex;
}

function summarizeMarineOutlook(windKnots: number, waveFeet: number) {
  if (waveFeet >= 6.5 || windKnots >= 24) {
    return "Hazardous run window";
  }

  if (waveFeet >= 4.5 || windKnots >= 18) {
    return "Bumpy offshore legs";
  }

  if (waveFeet <= 2.5 && windKnots <= 12) {
    return "Clean travel window";
  }

  return "Stable marine run";
}

function formatTideLabel(tideFeet: number, trend: "rising" | "falling" | "steady" | null) {
  const sign = tideFeet >= 0 ? "+" : "";
  const trendLabel = trend ?? "steady";
  return `${sign}${tideFeet.toFixed(1)} ft ${trendLabel}`;
}

async function loadExternalMarineWeather(latitude: number, longitude: number) {
  const lat = clampNumber(latitude, -89.5, 89.5);
  const lon = clampNumber(longitude, -179.9, 179.9);
  const cacheKey = `${lat.toFixed(2)}:${lon.toFixed(2)}`;
  const now = Date.now();

  if (externalMarineWeatherCache && externalMarineWeatherCache.expiresAt > now && externalMarineWeatherCache.key === cacheKey) {
    return externalMarineWeatherCache.data;
  }

  const weatherParams = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: "wind_speed_10m,pressure_msl",
    hourly: "wind_speed_10m,pressure_msl",
    wind_speed_unit: "kn",
    timezone: "UTC",
    forecast_days: "2"
  });

  const marineParams = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: "sea_surface_temperature,wave_height,sea_level_height_msl",
    hourly: "wave_height,sea_level_height_msl,sea_surface_temperature",
    timezone: "UTC",
    forecast_days: "2"
  });

  const [weatherResponse, marineResponse] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?${weatherParams.toString()}`, {
      headers: {
        "User-Agent": "Palmer-Lou-OS/1.0 (+weather-summary)"
      },
      signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS)
    }),
    fetch(`https://marine-api.open-meteo.com/v1/marine?${marineParams.toString()}`, {
      headers: {
        "User-Agent": "Palmer-Lou-OS/1.0 (+marine-summary)"
      },
      signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS)
    })
  ]);

  if (!weatherResponse.ok || !marineResponse.ok) {
    throw new Error(`Open-Meteo weather unavailable (${weatherResponse.status}/${marineResponse.status})`);
  }

  const weatherPayload = await weatherResponse.json() as {
    current?: { time?: string; wind_speed_10m?: number; pressure_msl?: number };
    hourly?: { time?: string[]; wind_speed_10m?: number[]; pressure_msl?: number[] };
  };
  const marinePayload = await marineResponse.json() as {
    current?: { time?: string; sea_surface_temperature?: number; wave_height?: number; sea_level_height_msl?: number };
    hourly?: { time?: string[]; wave_height?: number[]; sea_level_height_msl?: number[]; sea_surface_temperature?: number[] };
  };

  const currentWindKnots = toFiniteNumber(weatherPayload.current?.wind_speed_10m);
  const currentBarometer = toFiniteNumber(weatherPayload.current?.pressure_msl);
  const currentWaterTempC = toFiniteNumber(marinePayload.current?.sea_surface_temperature);
  const currentTideMeters = toFiniteNumber(marinePayload.current?.sea_level_height_msl);
  const hourlyTimes = Array.isArray(weatherPayload.hourly?.time) ? weatherPayload.hourly.time : [];
  const hourlyWindKnots = Array.isArray(weatherPayload.hourly?.wind_speed_10m) ? weatherPayload.hourly.wind_speed_10m : [];
  const hourlyWaveM = Array.isArray(marinePayload.hourly?.wave_height) ? marinePayload.hourly.wave_height : [];
  const hourlySeaLevelM = Array.isArray(marinePayload.hourly?.sea_level_height_msl) ? marinePayload.hourly.sea_level_height_msl : [];
  const referenceNow = Date.now();
  const tideIndex = pickNearestIndex(hourlyTimes, referenceNow);
  const nextTideIndex = tideIndex >= 0 ? Math.min(hourlySeaLevelM.length - 1, tideIndex + 1) : -1;

  const tideNowMeters = tideIndex >= 0 ? toFiniteNumber(hourlySeaLevelM[tideIndex] ?? null) ?? currentTideMeters : currentTideMeters;
  const tideNextMeters = nextTideIndex >= 0 ? toFiniteNumber(hourlySeaLevelM[nextTideIndex] ?? null) : null;

  let tideTrend: "rising" | "falling" | "steady" | null = null;
  if (tideNowMeters !== null && tideNextMeters !== null) {
    const delta = tideNextMeters - tideNowMeters;
    if (delta > 0.02) {
      tideTrend = "rising";
    } else if (delta < -0.02) {
      tideTrend = "falling";
    } else {
      tideTrend = "steady";
    }
  }

  const offsets = [
    { label: "Now", hours: 0 },
    { label: "+6h", hours: 6 },
    { label: "+12h", hours: 12 }
  ];

  const cards = offsets.map((offset) => {
    const targetMs = referenceNow + (offset.hours * 60 * 60 * 1000);
    const index = pickNearestIndex(hourlyTimes, targetMs);
    const wind = index >= 0 ? toFiniteNumber(hourlyWindKnots[index] ?? null) : null;
    const waveM = index >= 0 ? toFiniteNumber(hourlyWaveM[index] ?? null) : null;
    const observedAt = index >= 0 ? hourlyTimes[index] ?? null : null;
    const windKnots = Math.max(0, wind ?? currentWindKnots ?? 0);
    const waveFeet = Math.max(0.5, (waveM ?? toFiniteNumber(marinePayload.current?.wave_height) ?? 0.5) * 3.28084);

    return {
      label: offset.label,
      windKnots,
      waveFeet,
      outlook: summarizeMarineOutlook(windKnots, waveFeet),
      observedAt
    };
  });

  const result = {
    windKnots: currentWindKnots,
    barometerHpa: currentBarometer,
    waterTempF: currentWaterTempC === null ? null : ((currentWaterTempC * 9) / 5) + 32,
    tideFeet: tideNowMeters === null ? null : tideNowMeters * 3.28084,
    tideTrend,
    source: "Open-Meteo marine/weather",
    cards
  };

  externalMarineWeatherCache = {
    key: cacheKey,
    expiresAt: now + EXTERNAL_WEATHER_CACHE_TTL_MS,
    data: result
  };

  return result;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeHomePortConfig(input: unknown): HomePortConfig {
  const candidate = input && typeof input === "object"
    ? input as { latitude?: unknown; longitude?: unknown; radiusNm?: unknown; updatedAt?: unknown }
    : {};

  const latitude = typeof candidate.latitude === "number" && Number.isFinite(candidate.latitude)
    ? clampNumber(candidate.latitude, -89.9, 89.9)
    : null;
  const longitude = typeof candidate.longitude === "number" && Number.isFinite(candidate.longitude)
    ? clampNumber(candidate.longitude, -180, 180)
    : null;
  const radiusRaw = typeof candidate.radiusNm === "number" && Number.isFinite(candidate.radiusNm)
    ? candidate.radiusNm
    : 0.15;
  const radiusNm = clampNumber(radiusRaw, 0.05, 2.5);

  const updatedAtValue = typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
    ? new Date(candidate.updatedAt).toISOString()
    : new Date().toISOString();

  return {
    latitude,
    longitude,
    radiusNm,
    updatedAt: updatedAtValue
  };
}

function readHomePortConfig(): HomePortConfig {
  if (!existsSync(homePortConfigPath)) {
    return normalizeHomePortConfig({});
  }

  try {
    const raw = readFileSync(homePortConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeHomePortConfig(parsed);
  } catch {
    return normalizeHomePortConfig({});
  }
}

function writeHomePortConfig(nextConfig: unknown): HomePortConfig {
  const normalized = normalizeHomePortConfig(nextConfig);
  const withTimestamp: HomePortConfig = {
    ...normalized,
    updatedAt: new Date().toISOString()
  };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(homePortConfigPath, `${JSON.stringify(withTimestamp, null, 2)}\n`, "utf-8");
  return withTimestamp;
}

function parseOceanBounds(url: URL) {
  const rawMinLat = Number.parseFloat(url.searchParams.get("minLat") ?? "-90");
  const rawMaxLat = Number.parseFloat(url.searchParams.get("maxLat") ?? "90");
  const rawMinLng = Number.parseFloat(url.searchParams.get("minLng") ?? "-180");
  const rawMaxLng = Number.parseFloat(url.searchParams.get("maxLng") ?? "180");

  const minLat = Number.isFinite(rawMinLat) ? clampNumber(rawMinLat, -89.9, 89.9) : -89.9;
  const maxLat = Number.isFinite(rawMaxLat) ? clampNumber(rawMaxLat, -89.9, 89.9) : 89.9;
  const minLng = Number.isFinite(rawMinLng) ? clampNumber(rawMinLng, -180, 180) : -180;
  const maxLng = Number.isFinite(rawMaxLng) ? clampNumber(rawMaxLng, -180, 180) : 180;

  return {
    minLat: Math.min(minLat, maxLat),
    maxLat: Math.max(minLat, maxLat),
    minLng: Math.min(minLng, maxLng),
    maxLng: Math.max(minLng, maxLng)
  };
}

function buildOceanCurrentSampleGrid(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }, maxPoints: number) {
  const latSpan = Math.max(0.2, bounds.maxLat - bounds.minLat);
  const lngSpan = Math.max(0.2, bounds.maxLng - bounds.minLng);
  const aspect = clampNumber(lngSpan / latSpan, 0.6, 2.8);

  let rows = Math.max(3, Math.round(Math.sqrt(maxPoints / aspect)));
  let cols = Math.max(3, Math.round(rows * aspect));

  while ((rows * cols) > maxPoints && rows > 3) {
    rows -= 1;
    cols = Math.max(3, Math.round(rows * aspect));
  }

  while ((rows * cols) > maxPoints && cols > 3) {
    cols -= 1;
  }

  const points: Array<{ latitude: number; longitude: number }> = [];
  for (let r = 0; r < rows; r += 1) {
    const latitude = bounds.minLat + ((r + 0.5) / rows) * (bounds.maxLat - bounds.minLat);
    for (let c = 0; c < cols; c += 1) {
      const longitude = bounds.minLng + ((c + 0.5) / cols) * (bounds.maxLng - bounds.minLng);
      points.push({ latitude, longitude });
    }
  }

  return points;
}

function quantizeBound(value: number, step: number, mode: "floor" | "ceil") {
  if (mode === "floor") {
    return Math.floor(value / step) * step;
  }
  return Math.ceil(value / step) * step;
}

function vectorsInBounds(vectors: OceanCurrentVector[], bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }) {
  return vectors.filter((vector) => {
    return vector.latitude >= bounds.minLat
      && vector.latitude <= bounds.maxLat
      && vector.longitude >= bounds.minLng
      && vector.longitude <= bounds.maxLng;
  });
}

async function loadErddapCurrentVectors(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }, limit: number) {
  const wrapLon = (lon: number) => {
    const normalized = ((lon % 360) + 360) % 360;
    return normalized;
  };

  const minLon360 = wrapLon(bounds.minLng);
  const maxLon360 = wrapLon(bounds.maxLng);
  const crossesDateLine = minLon360 > maxLon360;

  const latSpan = Math.max(0.1, bounds.maxLat - bounds.minLat);
  const lonSpan = Math.max(0.1, crossesDateLine ? (360 - minLon360 + maxLon360) : (maxLon360 - minLon360));
  const coarseResolutionDeg = 0.02;
  const targetRows = Math.max(4, Math.round(Math.sqrt(limit / Math.max(0.5, lonSpan / latSpan))));
  const targetCols = Math.max(4, Math.round(limit / targetRows));
  const latStride = Math.max(1, Math.round((latSpan / coarseResolutionDeg) / targetRows));
  const lonStride = Math.max(1, Math.round((lonSpan / coarseResolutionDeg) / targetCols));

  const datasetId = "ucsdHfrE2_Lon0360";
  const lonStart = crossesDateLine ? minLon360 : Math.min(minLon360, maxLon360);
  const lonEnd = crossesDateLine ? (maxLon360 + 360) : Math.max(minLon360, maxLon360);

  const query = `water_u[(last)][(${bounds.minLat.toFixed(4)}):${latStride}:(${bounds.maxLat.toFixed(4)})][(${lonStart.toFixed(4)}):${lonStride}:(${lonEnd.toFixed(4)})],water_v[(last)][(${bounds.minLat.toFixed(4)}):${latStride}:(${bounds.maxLat.toFixed(4)})][(${lonStart.toFixed(4)}):${lonStride}:(${lonEnd.toFixed(4)})]`;
  const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/${datasetId}.csv?${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Palmer-Lou-OS/1.0 (+ocean-current-vectors-erddap)"
    },
    signal: AbortSignal.timeout(18000)
  });

  if (!response.ok) {
    throw new Error(`ERDDAP response ${response.status}`);
  }

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).slice(2).filter((line) => line.trim().length > 0);

  const vectors = lines
    .map((line) => {
      const parts = line.split(",");
      if (parts.length < 5) {
        return null;
      }

      const observedAt = parts[0]?.trim();
      const latitude = Number.parseFloat(parts[1] ?? "NaN");
      const longitudeRaw = Number.parseFloat(parts[2] ?? "NaN");
      const u = Number.parseFloat(parts[3] ?? "NaN");
      const v = Number.parseFloat(parts[4] ?? "NaN");

      if (!Number.isFinite(latitude) || !Number.isFinite(longitudeRaw) || !Number.isFinite(u) || !Number.isFinite(v)) {
        return null;
      }

      const longitude = longitudeRaw > 180 ? longitudeRaw - 360 : longitudeRaw;
      const speedMps = Math.hypot(u, v);
      const speedKnots = speedMps * 1.94384;
      const directionDegrees = ((Math.atan2(u, v) * 180 / Math.PI) + 360) % 360;

      return {
        latitude,
        longitude,
        speedKmh: speedMps * 3.6,
        speedKnots,
        directionDegrees,
        observedAt: observedAt && observedAt.length > 0 ? observedAt : new Date().toISOString()
      } as OceanCurrentVector;
    })
    .filter((vector): vector is OceanCurrentVector => vector !== null)
    .filter((vector) => vector.latitude >= bounds.minLat && vector.latitude <= bounds.maxLat && vector.longitude >= bounds.minLng && vector.longitude <= bounds.maxLng);

  if (vectors.length <= limit) {
    return vectors;
  }

  const stride = Math.ceil(vectors.length / limit);
  return vectors.filter((_, index) => index % stride === 0);
}

async function loadOscarClimatologyVectors(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }, limit: number) {
  const toLon360 = (lon: number) => ((lon % 360) + 360) % 360;
  const minLat = Math.max(-79.5, bounds.minLat - 0.8);
  const maxLat = Math.min(79.5, bounds.maxLat + 0.8);
  const minLon = toLon360(bounds.minLng - 0.8);
  const maxLon = toLon360(bounds.maxLng + 0.8);

  const latSpan = Math.max(0.2, maxLat - minLat);
  const lonSpanRaw = maxLon >= minLon ? (maxLon - minLon) : (360 - minLon + maxLon);
  const lonSpan = Math.max(0.2, lonSpanRaw);
  const targetRows = Math.max(4, Math.round(Math.sqrt(limit / Math.max(0.5, lonSpan / latSpan))));
  const targetCols = Math.max(4, Math.round(limit / targetRows));
  const gridStepDeg = 0.3333333333333333;
  const latStride = Math.max(1, Math.round((latSpan / gridStepDeg) / targetRows));
  const lonStride = Math.max(1, Math.round((lonSpan / gridStepDeg) / targetCols));

  const lonEnd = maxLon >= minLon ? maxLon : (maxLon + 360);
  const query = `u[(last)][(15.0)][(${minLat.toFixed(4)}):${latStride}:(${maxLat.toFixed(4)})][(${minLon.toFixed(4)}):${lonStride}:(${lonEnd.toFixed(4)})],v[(last)][(15.0)][(${minLat.toFixed(4)}):${latStride}:(${maxLat.toFixed(4)})][(${minLon.toFixed(4)}):${lonStride}:(${lonEnd.toFixed(4)})]`;
  const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplOscar.csv?${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Palmer-Lou-OS/1.0 (+ocean-current-vectors-oscar)"
    },
    signal: AbortSignal.timeout(18000)
  });

  if (!response.ok) {
    throw new Error(`OSCAR ERDDAP response ${response.status}`);
  }

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).slice(2).filter((line) => line.trim().length > 0);

  const vectors = lines
    .map((line) => {
      const parts = line.split(",");
      if (parts.length < 6) {
        return null;
      }

      const observedAt = parts[0]?.trim();
      const latitude = Number.parseFloat(parts[2] ?? "NaN");
      const longitudeRaw = Number.parseFloat(parts[3] ?? "NaN");
      const u = Number.parseFloat(parts[4] ?? "NaN");
      const v = Number.parseFloat(parts[5] ?? "NaN");
      if (!Number.isFinite(latitude) || !Number.isFinite(longitudeRaw) || !Number.isFinite(u) || !Number.isFinite(v)) {
        return null;
      }

      const longitudeNorm = longitudeRaw > 180 ? longitudeRaw - 360 : longitudeRaw;
      const speedMps = Math.hypot(u, v);
      const speedKnots = speedMps * 1.94384;
      const directionDegrees = ((Math.atan2(u, v) * 180 / Math.PI) + 360) % 360;

      return {
        latitude,
        longitude: longitudeNorm,
        speedKmh: speedMps * 3.6,
        speedKnots,
        directionDegrees,
        observedAt: observedAt && observedAt.length > 0 ? observedAt : new Date().toISOString()
      } as OceanCurrentVector;
    })
    .filter((vector): vector is OceanCurrentVector => vector !== null);

  const inBounds = vectors.filter((vector) => {
    return vector.latitude >= bounds.minLat
      && vector.latitude <= bounds.maxLat
      && vector.longitude >= bounds.minLng
      && vector.longitude <= bounds.maxLng;
  });

  const selected = inBounds.length > 0 ? inBounds : vectors;
  if (selected.length <= limit) {
    return selected;
  }

  const stride = Math.ceil(selected.length / limit);
  return selected.filter((_, index) => index % stride === 0);
}

async function loadOceanCurrentVectors(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }, limit: number) {
  const maxPoints = clampNumber(limit, 12, 180);
  const cacheStep = 0.35;
  const normalizedBounds = {
    minLat: quantizeBound(bounds.minLat, cacheStep, "floor"),
    maxLat: quantizeBound(bounds.maxLat, cacheStep, "ceil"),
    minLng: quantizeBound(bounds.minLng, cacheStep, "floor"),
    maxLng: quantizeBound(bounds.maxLng, cacheStep, "ceil")
  };
  const cacheKey = [
    normalizedBounds.minLat.toFixed(2),
    normalizedBounds.maxLat.toFixed(2),
    normalizedBounds.minLng.toFixed(2),
    normalizedBounds.maxLng.toFixed(2),
    String(maxPoints)
  ].join(":");

  const now = Date.now();
  const cached = oceanCurrentVectorCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  if (now < oceanCurrentRateLimitedUntil && lastOceanCurrentVectorSnapshot && lastOceanCurrentVectorSnapshot.vectors.length > 0) {
    const staleSubset = vectorsInBounds(lastOceanCurrentVectorSnapshot.vectors, normalizedBounds);
    return {
      expiresAt: now + OCEAN_CURRENT_VECTOR_CACHE_TTL_MS,
      vectors: staleSubset.length > 0 ? staleSubset : lastOceanCurrentVectorSnapshot.vectors,
      source: `${lastOceanCurrentVectorSnapshot.source} (cached fallback)`
    };
  }

  const samplePoints = buildOceanCurrentSampleGrid(normalizedBounds, maxPoints);
  if (samplePoints.length === 0) {
    return {
      expiresAt: now + OCEAN_CURRENT_VECTOR_CACHE_TTL_MS,
      vectors: [] as OceanCurrentVector[],
      source: "Open-Meteo Marine"
    };
  }

  const vectors: OceanCurrentVector[] = [];
  const batchSize = 24;
  let batchFailures = 0;

  for (let start = 0; start < samplePoints.length; start += batchSize) {
    const batch = samplePoints.slice(start, start + batchSize);
    const params = new URLSearchParams({
      latitude: batch.map((point) => point.latitude.toFixed(4)).join(","),
      longitude: batch.map((point) => point.longitude.toFixed(4)).join(","),
      current: "ocean_current_velocity,ocean_current_direction",
      timezone: "UTC",
      forecast_days: "1"
    });

    try {
      const response = await fetch(`https://marine-api.open-meteo.com/v1/marine?${params.toString()}`, {
        headers: {
          "User-Agent": "Palmer-Lou-OS/1.0 (+ocean-current-vectors)"
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        if (response.status === 429) {
          oceanCurrentRateLimitedUntil = Date.now() + OCEAN_CURRENT_RATE_LIMIT_COOLDOWN_MS;
        }
        batchFailures += 1;
        continue;
      }

      const payload = await response.json() as unknown;
      const records = Array.isArray(payload) ? payload : [payload];

      records.forEach((record, batchIndex) => {
        const item = record as {
          latitude?: number;
          longitude?: number;
          current?: {
            time?: string;
            ocean_current_velocity?: number;
            ocean_current_direction?: number;
          };
        };
        const fallbackPoint = batch[batchIndex] ?? batch[batch.length - 1];
        const latitude = Number.isFinite(item.latitude) ? item.latitude as number : (fallbackPoint?.latitude ?? 0);
        const longitude = Number.isFinite(item.longitude) ? item.longitude as number : (fallbackPoint?.longitude ?? 0);
        const speedKmh = item.current?.ocean_current_velocity;
        const directionDegrees = item.current?.ocean_current_direction;
        const observedAt = item.current?.time;

        if (!Number.isFinite(speedKmh) || !Number.isFinite(directionDegrees)) {
          return;
        }

        const speedValueKmh = Math.max(0, speedKmh as number);
        vectors.push({
          latitude,
          longitude,
          speedKmh: speedValueKmh,
          speedKnots: speedValueKmh * 0.539957,
          directionDegrees: (((directionDegrees as number) % 360) + 360) % 360,
          observedAt: typeof observedAt === "string" ? observedAt : new Date().toISOString()
        });
      });
    } catch {
      batchFailures += 1;
      continue;
    }
  }

  if (vectors.length === 0 && batchFailures > 0) {
    try {
      const erddapVectors = await loadErddapCurrentVectors(normalizedBounds, maxPoints);
      if (erddapVectors.length > 0) {
        lastOceanCurrentVectorSnapshot = {
          vectors: erddapVectors,
          source: "NOAA HF Radar (ERDDAP E2)",
          generatedAt: now
        };

        return {
          expiresAt: now + OCEAN_CURRENT_VECTOR_CACHE_TTL_MS,
          vectors: erddapVectors,
          source: "NOAA HF Radar (ERDDAP E2)"
        };
      }
    } catch {
      // Fall back to stale snapshots below if ERDDAP is unavailable.
    }

    try {
      const oscarVectors = await loadOscarClimatologyVectors(normalizedBounds, maxPoints);
      if (oscarVectors.length > 0) {
        lastOceanCurrentVectorSnapshot = {
          vectors: oscarVectors,
          source: "OSCAR historical vectors (ERDDAP)",
          generatedAt: now
        };

        return {
          expiresAt: now + OCEAN_CURRENT_VECTOR_CACHE_TTL_MS,
          vectors: oscarVectors,
          source: "OSCAR historical vectors (ERDDAP)"
        };
      }
    } catch {
      // Fall back to stale snapshots below.
    }

    if (lastOceanCurrentVectorSnapshot && lastOceanCurrentVectorSnapshot.vectors.length > 0) {
      const staleSubset = vectorsInBounds(lastOceanCurrentVectorSnapshot.vectors, normalizedBounds);
      return {
        expiresAt: now + OCEAN_CURRENT_VECTOR_CACHE_TTL_MS,
        vectors: staleSubset.length > 0 ? staleSubset : lastOceanCurrentVectorSnapshot.vectors,
        source: `${lastOceanCurrentVectorSnapshot.source} (stale fallback)`
      };
    }

    throw new Error("Open-Meteo marine vector sampling failed for all batches");
  }

  if (vectors.length > 0) {
    lastOceanCurrentVectorSnapshot = {
      vectors,
      source: "Open-Meteo Marine",
      generatedAt: now
    };
    oceanCurrentRateLimitedUntil = 0;
  }

  const result = {
    expiresAt: now + OCEAN_CURRENT_VECTOR_CACHE_TTL_MS,
    vectors,
    source: "Open-Meteo Marine"
  };
  oceanCurrentVectorCache.set(cacheKey, result);
  return result;
}
function normalizeOceanOverlayDate(value: string | null) {
  if (!value) {
    return new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  }

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!valid) {
    return new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  }

  return value;
}

function buildOceanTileUrls(source: OceanTileSource, z: number, x: number, y: number, date: string) {
  const sourceConfig = OCEAN_TILE_CONFIG_BY_SOURCE[source];
  const tileMatrix = Math.max(0, Math.min(sourceConfig.maxTileMatrix, z));
  const scaleFactor = z > tileMatrix ? 2 ** (z - tileMatrix) : 1;
  const scaledX = Math.floor(x / scaleFactor);
  const scaledY = Math.floor(y / scaleFactor);
  const matrixSize = 2 ** tileMatrix;
  const wrappedX = ((scaledX % matrixSize) + matrixSize) % matrixSize;
  const clampedY = Math.max(0, Math.min(matrixSize - 1, scaledY));
  const layer = sourceConfig.layer;
  const matrixSet = sourceConfig.matrixSet;

  return [
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/${matrixSet}/${tileMatrix}/${clampedY}/${wrappedX}.png`,
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${matrixSet}/${tileMatrix}/${clampedY}/${wrappedX}.png`,
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/${matrixSet}/${tileMatrix}/${clampedY}/${wrappedX}.png`
  ];
}

function pruneOceanTileCache() {
  const now = Date.now();

  for (const [key, entry] of oceanTileCache.entries()) {
    if (entry.expiresAt <= now) {
      oceanTileCache.delete(key);
    }
  }

  if (oceanTileCache.size <= OCEAN_TILE_CACHE_LIMIT) {
    return;
  }

  const overage = oceanTileCache.size - OCEAN_TILE_CACHE_LIMIT;
  const keys = oceanTileCache.keys();
  for (let index = 0; index < overage; index += 1) {
    const key = keys.next().value;
    if (!key) {
      break;
    }

    oceanTileCache.delete(key);
  }
}

function pruneStormRadarTileCache() {
  const now = Date.now();

  for (const [key, entry] of stormRadarTileCache.entries()) {
    if (entry.expiresAt <= now) {
      stormRadarTileCache.delete(key);
    }
  }

  if (stormRadarTileCache.size <= STORM_RADAR_TILE_CACHE_LIMIT) {
    return;
  }

  const overage = stormRadarTileCache.size - STORM_RADAR_TILE_CACHE_LIMIT;
  const keys = stormRadarTileCache.keys();
  for (let index = 0; index < overage; index += 1) {
    const key = keys.next().value;
    if (!key) {
      break;
    }

    stormRadarTileCache.delete(key);
  }
}

async function loadStormRadarFrame() {
  const now = Date.now();
  if (stormRadarFrameCache && (now - stormRadarFrameCache.fetchedAt) < STORM_RADAR_FRAME_TTL_MS) {
    return stormRadarFrameCache;
  }

  const response = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
    headers: {
      "User-Agent": "Palmer-Lou-OS/1.0 (+storm-radar-proxy)"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Radar metadata unavailable (${response.status})`);
  }

  const payload = await response.json() as {
    host?: string;
    radar?: {
      past?: Array<{ path?: string; time?: number }>;
      nowcast?: Array<{ path?: string; time?: number }>;
      future?: Array<{ path?: string; time?: number }>;
    };
  };

  const hostRaw = (payload.host ?? "https://tilecache.rainviewer.com").trim();
  const host = hostRaw.length > 0 ? hostRaw.replace(/\/$/, "") : "https://tilecache.rainviewer.com";
  const toFrames = (
    sourceFrames: Array<{ path?: string; time?: number }>,
    kind: "past" | "nowcast" | "future"
  ): RainViewerFrame[] => sourceFrames
    .filter((frame): frame is { path: string; time?: number } => typeof frame.path === "string" && frame.path.length > 0)
    .map((frame) => ({
      path: frame.path,
      time: typeof frame.time === "number" ? frame.time : null,
      kind
    }));

  const pastFrames = toFrames(payload.radar?.past ?? [], "past");
  const nowcastFrames = toFrames(payload.radar?.nowcast ?? [], "nowcast");
  const futureFrames = toFrames(payload.radar?.future ?? [], "future");
  const observedLatest = pastFrames.at(-1) ?? null;
  const projectedFrames = (nowcastFrames.length > 0 ? nowcastFrames : futureFrames).slice(0, 4);

  const timeline = [...pastFrames.slice(-8), ...projectedFrames]
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
    .filter((frame, index, list) => index === 0 || frame.path !== list[index - 1]?.path)
    .slice(-12);

  const latest = observedLatest ?? timeline.at(-1) ?? null;

  stormRadarFrameCache = {
    fetchedAt: now,
    host,
    frame: latest,
    timeline
  };

  return stormRadarFrameCache;
}

function buildStormRadarTileUrl(host: string, framePath: string, z: number, x: number, y: number) {
  const safePath = framePath.startsWith("/") ? framePath : `/${framePath}`;
  const normalizedPath = safePath.replace(/\/$/, "");
  return `${host}${normalizedPath}/256/${z}/${x}/${y}/2/1_1.png`;
}

function parseNumericToken(token: string | undefined): number | null {
  if (!token || token === "MM") {
    return null;
  }

  const parsed = Number.parseFloat(token);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNdbcLatestObs(content: string) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0 && !line.startsWith("#"));
  const observations: OceanBuoyObservation[] = [];

  lines.forEach((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 19) {
      return;
    }

    const stationId = columns[0] ?? "";
    const latitude = parseNumericToken(columns[1]);
    const longitude = parseNumericToken(columns[2]);
    const year = Number.parseInt(columns[3] ?? "", 10);
    const month = Number.parseInt(columns[4] ?? "", 10);
    const day = Number.parseInt(columns[5] ?? "", 10);
    const hour = Number.parseInt(columns[6] ?? "", 10);
    const minute = Number.parseInt(columns[7] ?? "", 10);

    if (!stationId || latitude === null || longitude === null) {
      return;
    }

    if (![year, month, day, hour, minute].every((value) => Number.isFinite(value))) {
      return;
    }

    observations.push({
      stationId,
      latitude,
      longitude,
      observedAt: new Date(Date.UTC(year, month - 1, day, hour, minute, 0)).toISOString(),
      waterTempC: parseNumericToken(columns[18]),
      airTempC: parseNumericToken(columns[17]),
      windSpeedMps: parseNumericToken(columns[9]),
      waveHeightM: parseNumericToken(columns[11]),
      pressureHpa: parseNumericToken(columns[15])
    });
  });

  return observations;
}

async function loadBuoyObservations() {
  const now = Date.now();
  if (buoyCache && (now - buoyCache.fetchedAt) < BUOY_CACHE_TTL_MS) {
    return buoyCache.data;
  }

  const response = await fetch(NDBC_LATEST_OBS_URL, {
    headers: {
      "User-Agent": "Palmer-Lou-OS/1.0 (+buoy-ingest)"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`NDBC feed unavailable (${response.status})`);
  }

  const raw = await response.text();
  const parsed = parseNdbcLatestObs(raw);
  buoyCache = {
    fetchedAt: now,
    data: parsed
  };

  return parsed;
}

const SPECIES_INTEL_PROFILES = [
  {
    name: "Wahoo",
    tempMin: 72, tempMax: 84, optimalTemp: 78,
    sstWeight: 1.25, convWeight: 0.75,
    minOffshoreNm: 30,
    targetOffshoreNm: 46,
    maxOffshoreNm: 130,
    color: "#ff5b8a",
    depthBand: "140–600 ft contour edge",
    currentSignal: "Fast current lane and bait stacking"
  },
  {
    name: "Mahi Mahi",
    tempMin: 74, tempMax: 86, optimalTemp: 80,
    sstWeight: 0.9, convWeight: 1.1,
    minOffshoreNm: 16,
    targetOffshoreNm: 30,
    maxOffshoreNm: 110,
    color: "#6ad8a2",
    depthBand: "Surface to 200 ft over structure",
    currentSignal: "Surface slick with debris and convergence"
  },
  {
    name: "Tuna",
    tempMin: 70, tempMax: 80, optimalTemp: 75,
    sstWeight: 1.05, convWeight: 0.95,
    minOffshoreNm: 22,
    targetOffshoreNm: 38,
    maxOffshoreNm: 140,
    color: "#00c0c0",
    depthBand: "120–600 ft temp break",
    currentSignal: "Cross-current seam with stable break"
  },
  {
    name: "Billfish",
    tempMin: 74, tempMax: 84, optimalTemp: 79,
    sstWeight: 0.85, convWeight: 1.15,
    minOffshoreNm: 30,
    targetOffshoreNm: 54,
    maxOffshoreNm: 180,
    color: "#b58dff",
    depthBand: "200–1000+ ft canyon edge",
    currentSignal: "Warm current push with pronounced seam"
  },
  {
    name: "Swordfish",
    tempMin: 65, tempMax: 78, optimalTemp: 71,
    sstWeight: 0.8, convWeight: 1.2,
    minOffshoreNm: 32,
    targetOffshoreNm: 58,
    maxOffshoreNm: 190,
    color: "#f0c96b",
    depthBand: "300–1200 ft outside edge",
    currentSignal: "Offshore break and eddy shoulder"
  },
  {
    name: "Kingfish",
    tempMin: 68, tempMax: 82, optimalTemp: 75,
    sstWeight: 1.15, convWeight: 0.85,
    minOffshoreNm: 8,
    targetOffshoreNm: 18,
    maxOffshoreNm: 65,
    color: "#ff8f70",
    depthBand: "100–400 ft shelf break",
    currentSignal: "Current edge with bait compression"
  }
] as const;

function buildCirclePolygon(lat: number, lng: number, radiusNm: number): [number, number][] {
  const sides = 20;
  return Array.from({ length: sides + 1 }, (_, i) => {
    const angle = (i / sides) * Math.PI * 2;
    const latOffset = Math.cos(angle) * radiusNm / 60;
    const lngOffset = Math.sin(angle) * radiusNm / (60 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
    return [lat + latOffset, lng + lngOffset] as [number, number];
  });
}

function buildAllSpeciesIntel(payload: {
  buoys: OceanBuoyObservation[];
  catches: AdvisorCatchInput[];
  context: FishingAdvisorContext | null;
}): AllSpeciesIntelResponse {
  const marineBuoys = filterBuoysToMarineRegion({ buoys: payload.buoys, context: payload.context })
    .filter((b) => b.waterTempC !== null && !isLikelyNearshoreInvalid({ latitude: b.latitude, longitude: b.longitude }));

  const oceanSignals = buildBuoySignalFronts({
    buoys: marineBuoys,
    species: "general",
    temperatureRangeF: { min: 62, max: 88 }
  });

  const now = Date.now();
  const speciesCandidateTable = SPECIES_INTEL_PROFILES.map((sp) => {
    const speciesCatches = payload.catches.filter((c) => c.species.toLowerCase().includes(sp.name.toLowerCase()));
    const recentStrength = speciesCatches.reduce((sum, c) => {
      const age = (now - new Date(c.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      return sum + Math.exp(-age / 8);
    }, 0);

    const candidates = marineBuoys.map((b) => {
      const tempF = toTempF(b.waterTempC)!;
      const inRange = tempF >= sp.tempMin && tempF <= sp.tempMax;
      const tempSpan = Math.max(3, (sp.tempMax - sp.tempMin) / 2);
      const distFromOptimal = Math.abs(tempF - sp.optimalTemp);
      const sstFit = inRange
        ? Math.max(0.5, 1 - (distFromOptimal / tempSpan) * 0.45)
        : Math.max(0, 1 - (Math.min(Math.abs(tempF - sp.tempMin), Math.abs(tempF - sp.tempMax)) / 11));

      const bestFrontEntry = oceanSignals.fronts
        .map((f) => {
          const d = distanceNm(f.midpoint.latitude, f.midpoint.longitude, b.latitude, b.longitude);
          if (d > 110) {
            return null;
          }

          const speciesWeight = f.kind === "sst" ? sp.sstWeight : sp.convWeight;
          const proximityFactor = Math.max(0.05, 1 - d / 90);
          return {
            front: f,
            distance: d,
            weightedScore: (f.score / 100) * speciesWeight * proximityFactor
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.weightedScore - a.weightedScore)[0];

      const frontProximityFit = bestFrontEntry ? Math.max(0.15, 1 - (bestFrontEntry.distance / 85)) : 0.18;
      const frontFit = Math.min(1, (bestFrontEntry?.weightedScore ?? 0) * frontProximityFit);
      const frontGradient = bestFrontEntry?.front.gradientFPer10Nm ?? 0;

      const ownWind = b.windSpeedMps ?? 0;
      const nearbyWindValues = marineBuoys
        .filter((nb) => nb !== b && nb.windSpeedMps !== null && distanceNm(b.latitude, b.longitude, nb.latitude, nb.longitude) < 55)
        .map((nb) => nb.windSpeedMps as number);
      const windSpread = nearbyWindValues.length > 0
        ? nearbyWindValues.reduce((s, w) => s + Math.abs(w - ownWind), 0) / nearbyWindValues.length
        : 0;
      const convergenceFit = Math.min(1, windSpread / 3.8) * Math.min(1, sp.convWeight * 0.92);

      const offshoreNm = offshoreDistanceFromAtlanticCoastNm({ latitude: b.latitude, longitude: b.longitude });
      if (offshoreNm === null || offshoreNm < sp.minOffshoreNm) {
        return null;
      }

      const offshoreSpan = Math.max(8, (sp.maxOffshoreNm - sp.minOffshoreNm) / 2);
      const offshoreFit = offshoreNm > sp.maxOffshoreNm
        ? Math.max(0.25, 1 - ((offshoreNm - sp.maxOffshoreNm) / Math.max(26, sp.maxOffshoreNm * 0.5)))
        : Math.max(0.35, 1 - (Math.abs(offshoreNm - sp.targetOffshoreNm) / offshoreSpan) * 0.7);

      const windKts = b.windSpeedMps === null ? null : b.windSpeedMps * 1.94384;
      const windFit = windKts === null
        ? 0.55
        : windKts < 6
          ? 0.45
          : windKts <= 18
            ? 1
            : windKts <= 26
              ? 0.78
              : 0.52;

      const waveFit = b.waveHeightM === null
        ? 0.55
        : b.waveHeightM < 0.4
          ? 0.55
          : b.waveHeightM <= 2.8
            ? 1
            : b.waveHeightM <= 4.2
              ? 0.72
              : 0.4;

      const buoyAgeMin = (now - new Date(b.observedAt).getTime()) / 60000;
      const dataAgeFit = Math.max(0.08, 1 - buoyAgeMin / (60 * 16));
      let raw = (sstFit * 0.31)
        + (frontFit * 0.26)
        + (convergenceFit * 0.13)
        + (offshoreFit * 0.16)
        + (waveFit * 0.07)
        + (windFit * 0.04)
        + (dataAgeFit * 0.03);

      if (!inRange) {
        raw -= 0.12;
      }

      return {
        buoy: b,
        tempF,
        sstFit,
        frontFit,
        frontGradient,
        bestFront: bestFrontEntry?.front ?? null,
        convergenceFit,
        offshoreNm,
        offshoreFit,
        waveFit,
        windFit,
        dataAgeFit,
        recentStrength,
        raw
      };
    }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((a, b) => b.raw - a.raw)
      .slice(0, 10);

    return { sp, speciesCatches, recentStrength, candidates };
  });

  // Deconflict species so they do not all occupy one hotspot.
  const usedStations = new Set<string>();
  const chosen: Array<{
    sp: typeof SPECIES_INTEL_PROFILES[number];
    speciesCatches: AdvisorCatchInput[];
    recentStrength: number;
    candidate: (typeof speciesCandidateTable)[number]["candidates"][number];
    effectiveRaw: number;
  }> = [];

  const sortedSpecies = [...speciesCandidateTable].sort((a, b) => {
    const aTop = a.candidates[0]?.raw ?? 0;
    const bTop = b.candidates[0]?.raw ?? 0;
    return bTop - aTop;
  });

  sortedSpecies.forEach((item) => {
    const best = item.candidates
      .map((candidate) => {
        const stationPenalty = usedStations.has(candidate.buoy.stationId) ? 0.18 : 0;
        const nearestChosenNm = chosen.length === 0
          ? Number.POSITIVE_INFINITY
          : Math.min(...chosen.map((pick) => distanceNm(
            pick.candidate.buoy.latitude,
            pick.candidate.buoy.longitude,
            candidate.buoy.latitude,
            candidate.buoy.longitude
          )));
        const proximityPenalty = nearestChosenNm < 140 ? (140 - nearestChosenNm) / 380 : 0;
        const effectiveRaw = candidate.raw - stationPenalty - proximityPenalty;
        return { candidate, effectiveRaw };
      })
      .sort((a, b) => b.effectiveRaw - a.effectiveRaw)[0];

    if (!best || best.effectiveRaw < 0.26) {
      return;
    }

    usedStations.add(best.candidate.buoy.stationId);
    chosen.push({
      sp: item.sp,
      speciesCatches: item.speciesCatches,
      recentStrength: item.recentStrength,
      candidate: best.candidate,
      effectiveRaw: best.effectiveRaw
    });
  });

  const minRaw = chosen.length > 0 ? Math.min(...chosen.map((c) => c.effectiveRaw)) : 0;
  const maxRaw = chosen.length > 0 ? Math.max(...chosen.map((c) => c.effectiveRaw)) : 1;
  const spread = Math.max(0.001, maxRaw - minRaw);

  const entries = chosen.map((pick) => {
    const center = enforceSpeciesOffshoreBuffer({ latitude: pick.candidate.buoy.latitude, longitude: pick.candidate.buoy.longitude }, pick.sp.name, marineBuoys);
    const centerOffshoreNm = offshoreDistanceFromAtlanticCoastNm(center);
    const requiredOffshoreNm = minOffshoreNmForSpecies(pick.sp.name);
    const normalized = (pick.effectiveRaw - minRaw) / spread;
    const historyBonus = Math.min(0.14, pick.recentStrength / 24);
    const score = Math.max(22, Math.min(97, Math.round(30 + ((normalized + historyBonus) * 64))));
    const evidenceSignals = [
      pick.candidate.sstFit >= 0.68,
      pick.candidate.frontFit >= 0.44,
      pick.candidate.convergenceFit >= 0.34,
      pick.recentStrength >= 0.45,
      pick.candidate.offshoreFit >= 0.6
    ].filter(Boolean).length;
    const recommended = score >= 56 && evidenceSignals >= 2 && (centerOffshoreNm === null || centerOffshoreNm >= requiredOffshoreNm);
    const confidence: "high" | "medium" | "low" = recommended && score >= 78 && evidenceSignals >= 4
      ? "high"
      : score >= 58 && evidenceSignals >= 2
        ? "medium"
        : "low";

    const frontStrength4 = pick.candidate.bestFront
      ? Math.min(4, Math.max(1, Math.round(pick.candidate.frontGradient * 2.1)))
      : 0;

    const convergenceLabel = pick.candidate.convergenceFit > 0.58 ? "Strong" : pick.candidate.convergenceFit > 0.34 ? "Moderate" : "Light";
    const buoyAgeMin = (now - new Date(pick.candidate.buoy.observedAt).getTime()) / 60000;
    const ageLabel = buoyAgeMin < 60 ? `${Math.round(buoyAgeMin)} min` : `${(buoyAgeMin / 60).toFixed(1)} h`;
    const baseRadiusNm = recommended
      ? Math.max(4, Math.min(6, 2 + score / 18))
      : 2.5;
    const shoreSafeRadiusNm = centerOffshoreNm === null
      ? baseRadiusNm
      : Math.max(2.2, Math.min(baseRadiusNm, Math.max(2.2, centerOffshoreNm - (requiredOffshoreNm * 0.55))));
    const radiusNm = Number(shoreSafeRadiusNm.toFixed(1));

    return {
      species: pick.sp.name,
      score,
      confidence,
      recommended,
      bestLatitude: center.latitude,
      bestLongitude: center.longitude,
      bestLocationLabel: `Near buoy ${pick.candidate.buoy.stationId}`,
      radiusNm,
      temperatureRangeF: { min: pick.sp.tempMin, max: pick.sp.tempMax },
      color: pick.sp.color,
      depthBand: pick.sp.depthBand,
      currentSignal: pick.sp.currentSignal,
      factors: {
        sst: {
          label: "Sea surface temp",
          value: `${pick.candidate.tempF.toFixed(1)} F (target ${pick.sp.tempMin}-${pick.sp.tempMax} F)`,
          score: Math.round(pick.candidate.sstFit * 100)
        },
        sstFront: {
          label: "SST front strength",
          value: frontStrength4 > 0
            ? `${frontStrength4}/4 - ${pick.candidate.frontGradient.toFixed(1)} F / 10 NM`
            : "No front in range",
          score: Math.round(pick.candidate.frontFit * 100)
        },
        convergence: {
          label: "Current convergence",
          value: convergenceLabel,
          score: Math.round(Math.min(1, pick.candidate.convergenceFit) * 100)
        },
        chlorophyllProxy: {
          label: "Productivity proxy",
          value: pick.candidate.convergenceFit > 0.55 ? "Likely active water edge" : "Moderate",
          score: Math.round((Math.min(1, pick.candidate.convergenceFit) * 0.6 + pick.candidate.frontFit * 0.4) * 100)
        },
        dataAge: {
          label: "Data age",
          value: ageLabel,
          score: Math.round(pick.candidate.dataAgeFit * 100)
        },
        catchHistory: {
          label: "Catch history",
          value: pick.speciesCatches.length > 0 ? `${pick.speciesCatches.length} logged catches` : "No history yet",
          score: Math.min(100, Math.round(pick.recentStrength * 30))
        }
      },
      points: buildCirclePolygon(center.latitude, center.longitude, radiusNm),
      notes: [
        pick.candidate.bestFront
          ? `Best front: ${pick.candidate.bestFront.label} (${pick.candidate.bestFront.strength.toUpperCase()}) - ${pick.candidate.frontGradient.toFixed(1)} F/10 NM`
          : "No SST/convergence fronts detected in local viewport",
        `SST: ${pick.candidate.tempF.toFixed(1)} F`,
        `Sea state: ${pick.candidate.waveFit >= 0.9 ? "clean" : pick.candidate.waveFit >= 0.65 ? "workable" : "marginal"}, wind fit ${(pick.candidate.windFit * 100).toFixed(0)}%`,
        `Convergence: ${convergenceLabel.toLowerCase()}`,
        centerOffshoreNm !== null
          ? `Offshore distance: ${centerOffshoreNm.toFixed(1)} NM from shoreline`
          : "Offshore distance unavailable at this latitude",
        `Offshore guardrail target: >= ${minOffshoreNmForSpecies(pick.sp.name)} NM from shoreline`
      ]
    } as SpeciesIntelEntry;
  }).sort((a, b) => b.score - a.score);

  const existingSpecies = new Set(entries.map((entry) => entry.species.toLowerCase()));
  speciesCandidateTable.forEach((item) => {
    if (existingSpecies.has(item.sp.name.toLowerCase())) {
      return;
    }

    const fallbackCandidate = item.candidates[0] ?? null;
    const fallbackBuoy = fallbackCandidate?.buoy
      ?? marineBuoys
        .filter((buoy) => buoy.waterTempC !== null)
        .map((buoy) => ({
          buoy,
          delta: Math.abs((toTempF(buoy.waterTempC) ?? item.sp.optimalTemp) - item.sp.optimalTemp)
        }))
        .sort((a, b) => a.delta - b.delta)[0]?.buoy
      ?? null;

    if (!fallbackBuoy) {
      return;
    }

    const center = enforceSpeciesOffshoreBuffer(
      { latitude: fallbackBuoy.latitude, longitude: fallbackBuoy.longitude },
      item.sp.name,
      marineBuoys
    );

    if (isLikelyNearshoreInvalid(center)) {
      return;
    }

    const requiredOffshoreNm = minOffshoreNmForSpecies(item.sp.name);
    const offshoreNm = offshoreDistanceFromAtlanticCoastNm(center);
    if (offshoreNm !== null && offshoreNm < requiredOffshoreNm) {
      return;
    }

    const fallbackTempF = toTempF(fallbackBuoy.waterTempC) ?? item.sp.optimalTemp;
    const fallbackScore = fallbackCandidate
      ? Math.max(28, Math.min(55, Math.round(24 + (fallbackCandidate.raw * 46))))
      : 32;

    entries.push({
      species: item.sp.name,
      score: fallbackScore,
      confidence: "low",
      recommended: false,
      bestLatitude: center.latitude,
      bestLongitude: center.longitude,
      bestLocationLabel: `Scout near buoy ${fallbackBuoy.stationId}`,
      radiusNm: 2.6,
      temperatureRangeF: { min: item.sp.tempMin, max: item.sp.tempMax },
      color: item.sp.color,
      depthBand: item.sp.depthBand,
      currentSignal: item.sp.currentSignal,
      factors: {
        sst: {
          label: "Sea surface temp",
          value: `${fallbackTempF.toFixed(1)} F (target ${item.sp.tempMin}-${item.sp.tempMax} F)`,
          score: fallbackCandidate ? Math.round(fallbackCandidate.sstFit * 100) : 45
        },
        sstFront: {
          label: "SST front strength",
          value: fallbackCandidate?.bestFront
            ? `${Math.max(1, Math.round(fallbackCandidate.frontGradient * 2.1))}/4 - ${fallbackCandidate.frontGradient.toFixed(1)} F / 10 NM`
            : "Scout: no strong front lock",
          score: fallbackCandidate ? Math.round(fallbackCandidate.frontFit * 100) : 34
        },
        convergence: {
          label: "Current convergence",
          value: fallbackCandidate
            ? (fallbackCandidate.convergenceFit > 0.34 ? "Moderate" : "Light")
            : "Light",
          score: fallbackCandidate ? Math.round(Math.min(1, fallbackCandidate.convergenceFit) * 100) : 35
        },
        chlorophyllProxy: {
          label: "Productivity proxy",
          value: "Scout-grade signal",
          score: fallbackCandidate ? Math.round((fallbackCandidate.frontFit * 0.5 + Math.min(1, fallbackCandidate.convergenceFit) * 0.5) * 100) : 36
        },
        dataAge: {
          label: "Data age",
          value: `${Math.round((now - new Date(fallbackBuoy.observedAt).getTime()) / 60000)} min`,
          score: fallbackCandidate ? Math.round(fallbackCandidate.dataAgeFit * 100) : 78
        },
        catchHistory: {
          label: "Catch history",
          value: item.speciesCatches.length > 0 ? `${item.speciesCatches.length} logged catches` : "No history yet",
          score: Math.min(100, Math.round(item.recentStrength * 30))
        }
      },
      points: buildCirclePolygon(center.latitude, center.longitude, 2.6),
      notes: [
        "Scout fallback: maintaining full species coverage for tactical planning",
        `SST: ${fallbackTempF.toFixed(1)} F`,
        offshoreNm !== null
          ? `Offshore distance: ${offshoreNm.toFixed(1)} NM from shoreline`
          : "Offshore distance unavailable at this latitude",
        `Offshore guardrail target: >= ${requiredOffshoreNm} NM from shoreline`
      ]
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    referenceLatitude: payload.context?.referenceLatitude ?? null,
    referenceLongitude: payload.context?.referenceLongitude ?? null,
    buoyCount: marineBuoys.length,
    frontCount: oceanSignals.fronts.length,
    species: entries,
    oceanSignals
  };
}

function getSpeciesTemperatureRangeF(species: string) {
  const normalized = species.trim().toLowerCase();
  const ranges: Record<string, { min: number; max: number }> = {
    bluefin: { min: 58, max: 68 },
    yellowfin: { min: 72, max: 82 },
    "mahi mahi": { min: 76, max: 84 },
    wahoo: { min: 72, max: 82 },
    swordfish: { min: 68, max: 78 },
    billfish: { min: 74, max: 84 },
    kingfish: { min: 72, max: 82 },
    sailfish: { min: 74, max: 82 },
    marlin: { min: 74, max: 84 },
    tuna: { min: 70, max: 80 }
  };

  return ranges[normalized] ?? { min: 70, max: 82 };
}

function getSpeciesFrontPreference(species: string) {
  const normalized = species.trim().toLowerCase();
  const preferences: Record<string, { sst: number; convergence: number }> = {
    tuna: { sst: 1.05, convergence: 0.95 },
    billfish: { sst: 0.9, convergence: 1.1 },
    swordfish: { sst: 0.82, convergence: 1.18 },
    kingfish: { sst: 1.12, convergence: 0.9 },
    wahoo: { sst: 1.2, convergence: 0.82 },
    "mahi mahi": { sst: 0.92, convergence: 1.08 },
    yellowfin: { sst: 1.1, convergence: 0.9 },
    marlin: { sst: 0.9, convergence: 1.1 },
    sailfish: { sst: 0.92, convergence: 1.08 }
  };

  return preferences[normalized] ?? { sst: 1, convergence: 1 };
}

function minOffshoreNmForSpecies(species: string) {
  const normalized = species.trim().toLowerCase();
  const speciesMap: Record<string, number> = {
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

  return speciesMap[normalized] ?? 12;
}

function toTempF(tempC: number | null) {
  if (tempC === null) {
    return null;
  }

  return (tempC * 9 / 5) + 32;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function distanceNm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);

  const hav = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const centralAngle = 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
  const km = earthRadiusKm * centralAngle;

  return km * 0.539957;
}

const LAND_POLYGONS: Array<[number, number][]> = [
  // Florida peninsula
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
  // Gulf Coast TX to FL
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
  // Pamlico + Albemarle Sound (approximate envelope; blocks offshore species placement in sounds)
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

// US Atlantic coast: minimum longitude to be in open ocean at each latitude.
// The East Coast faces east — "more east" = less negative longitude = more offshore.
// Any point with longitude LESS THAN this boundary is on land or inshore water.
const ATLANTIC_COAST_MIN_LON: Array<[number, number]> = [
  [30, -81.5],  // FL/GA Atlantic coast
  [31, -81.4],  // GA coast — Golden Isles
  [32, -80.9],  // Savannah / Hilton Head SC
  [33, -79.2],  // Myrtle Beach SC
  [34, -77.9],  // Cape Fear NC — Wilmington sits at ~-77.95 (inland)
  [35, -76.5],  // Morehead City / Cape Lookout NC
  [36, -75.8],  // Kitty Hawk / Kill Devil Hills NC
  [37, -75.7],  // Virginia Beach / Chincoteague
  [38, -75.0],  // Ocean City MD / Delaware coast
  [39, -74.4],  // Atlantic City NJ
  [40, -74.0],  // Sandy Hook NJ
  [41, -72.6],  // Long Island Sound entrance
  [42, -70.8],  // Cape Cod MA
  [43, -70.3],  // NH / southern ME
  [44, -68.6],  // Mid-coast ME
  [45, -67.0],  // Downeast ME / Canadian border
];

function atlanticCoastMinLon(latitude: number): number | null {
  if (latitude < 30 || latitude > 45) {
    return null;
  }
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
  // Atlantic East Coast: reject points west of the approximate outer shoreline
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

function pushPointOffshore(point: GeoPoint, buoys: OceanBuoyObservation[]) {
  if (!isLikelyNearshoreInvalid(point)) {
    return point;
  }

  // Use only buoys that are themselves verified offshore
  const offshoreAnchor = buoys
    .filter((b) => !isLikelyNearshoreInvalid({ latitude: b.latitude, longitude: b.longitude }))
    .map((b) => ({
      latitude: b.latitude,
      longitude: b.longitude,
      distance: distanceNm(point.latitude, point.longitude, b.latitude, b.longitude)
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (offshoreAnchor) {
    return { latitude: offshoreAnchor.latitude, longitude: offshoreAnchor.longitude };
  }

  // Fallback: push ~15 NM east of the coast boundary for this latitude
  const minLon = atlanticCoastMinLon(point.latitude);
  if (minLon !== null) {
    const lngPerNm = 1 / (60 * Math.max(0.1, Math.cos(point.latitude * Math.PI / 180)));
    return { latitude: point.latitude, longitude: minLon + 15 * lngPerNm };
  }

  return point;
}

function offshoreDistanceFromAtlanticCoastNm(point: GeoPoint) {
  const coastLon = atlanticCoastMinLon(point.latitude);
  if (coastLon === null) {
    return null;
  }

  const lngPerNm = 1 / (60 * Math.max(0.1, Math.cos(point.latitude * Math.PI / 180)));
  return Math.max(0, (point.longitude - coastLon) / lngPerNm);
}

function enforceSpeciesOffshoreBuffer(point: GeoPoint, species: string, buoys: OceanBuoyObservation[]) {
  const pushed = pushPointOffshore(point, buoys);
  const requiredNm = minOffshoreNmForSpecies(species);
  const offshoreNm = offshoreDistanceFromAtlanticCoastNm(pushed);

  if (offshoreNm === null || offshoreNm >= requiredNm) {
    return pushed;
  }

  const coastLon = atlanticCoastMinLon(pushed.latitude);
  if (coastLon === null) {
    return pushed;
  }

  const lngPerNm = 1 / (60 * Math.max(0.1, Math.cos(pushed.latitude * Math.PI / 180)));
  const shifted = {
    latitude: pushed.latitude,
    longitude: coastLon + (requiredNm * lngPerNm)
  };

  if (!isLikelyNearshoreInvalid(shifted)) {
    return shifted;
  }

  return pushPointOffshore(shifted, buoys);
}

function filterBuoysToMarineRegion(payload: {
  buoys: OceanBuoyObservation[];
  context: FishingAdvisorContext | null;
}) {
  if (!payload.context) {
    return payload.buoys;
  }

  const { referenceLatitude, referenceLongitude, maxRadiusNm } = payload.context;
  return payload.buoys.filter((buoy) => {
    return distanceNm(referenceLatitude, referenceLongitude, buoy.latitude, buoy.longitude) <= maxRadiusNm;
  });
}

function hasEnoughOffshoreBuoyCoverage(payload: {
  buoys: OceanBuoyObservation[];
  context: FishingAdvisorContext | null;
  minimumCount: number;
}) {
  const marine = filterBuoysToMarineRegion({
    buoys: payload.buoys,
    context: payload.context
  }).filter((buoy) => buoy.waterTempC !== null && !isLikelyNearshoreInvalid({ latitude: buoy.latitude, longitude: buoy.longitude }));

  return marine.length >= payload.minimumCount;
}

function buildBuoySignalFronts(payload: {
  buoys: OceanBuoyObservation[];
  species: string;
  temperatureRangeF: { min: number; max: number };
}): FishingOceanSignals {
  const buoysWithTemp = payload.buoys.filter((buoy) => buoy.waterTempC !== null);
  const pairSignals: Array<{
    a: OceanBuoyObservation;
    b: OceanBuoyObservation;
    distance: number;
    midpoint: { latitude: number; longitude: number };
    gradientFPer10Nm: number;
    tempWindowFit: number;
    convergenceScore: number;
    score: number;
    notes: string[];
  }> = [];

  for (let i = 0; i < buoysWithTemp.length; i += 1) {
    const a = buoysWithTemp[i];
    if (!a) {
      continue;
    }

    for (let j = i + 1; j < buoysWithTemp.length; j += 1) {
      const b = buoysWithTemp[j];
      if (!b) {
        continue;
      }

      const pairDistanceNm = distanceNm(a.latitude, a.longitude, b.latitude, b.longitude);
      if (pairDistanceNm < 5 || pairDistanceNm > 260) {
        continue;
      }

      const aTempF = toTempF(a.waterTempC);
      const bTempF = toTempF(b.waterTempC);
      if (aTempF === null || bTempF === null) {
        continue;
      }

      const gradientFPer10Nm = Math.abs(aTempF - bTempF) / Math.max(1, pairDistanceNm / 10);
      const midpoint = {
        latitude: (a.latitude + b.latitude) / 2,
        longitude: (a.longitude + b.longitude) / 2
      };

      if (isLikelyNearshoreInvalid(midpoint)) {
        continue;
      }

      const targetTemp = (payload.temperatureRangeF.min + payload.temperatureRangeF.max) / 2;
      const midpointTemp = (aTempF + bTempF) / 2;
      const tempWindowFit = Math.max(0, 1 - (Math.abs(midpointTemp - targetTemp) / 16));

      const windDiff = Math.abs((a.windSpeedMps ?? 0) - (b.windSpeedMps ?? 0));
      const pressureDiff = Math.abs((a.pressureHpa ?? 1013) - (b.pressureHpa ?? 1013));
      const waveDiff = Math.abs((a.waveHeightM ?? 0) - (b.waveHeightM ?? 0));
      const convergenceScore = Math.min(1, ((windDiff / 4) + (pressureDiff / 8) + (waveDiff / 1.5)) / 3);

      const score = Math.round((gradientFPer10Nm * 36) + (tempWindowFit * 42) + (convergenceScore * 22));
      pairSignals.push({
        a,
        b,
        distance: pairDistanceNm,
        midpoint,
        gradientFPer10Nm,
        tempWindowFit,
        convergenceScore,
        score,
        notes: [
          `SST gradient ${gradientFPer10Nm.toFixed(2)} F per 10 NM`,
          `Midpoint temp ${(midpointTemp).toFixed(1)} F vs target ${(targetTemp).toFixed(1)} F`,
          `Convergence proxy ${(convergenceScore * 100).toFixed(0)} from wind/pressure/wave spread`
        ]
      });
    }
  }

  const ranked = pairSignals.sort((a, b) => b.score - a.score).slice(0, 20);
  const fronts: FishingOceanSignalFront[] = ranked.map((pair, index) => {
    const kind: "sst" | "convergence" = pair.convergenceScore >= 0.45 ? "convergence" : "sst";
    const strength: "high" | "medium" | "low" = pair.score >= 88 ? "high" : pair.score >= 66 ? "medium" : "low";

    return {
      id: `signal-${kind}-${index + 1}`,
      kind,
      label: kind === "convergence"
        ? `Convergence lane ${index + 1}`
        : `Thermal edge ${index + 1}`,
      strength,
      score: Math.min(99, Math.max(35, pair.score)),
      gradientFPer10Nm: Number(pair.gradientFPer10Nm.toFixed(2)),
      distanceNm: Number(pair.distance.toFixed(1)),
      midpoint: pair.midpoint,
      points: [
        [pair.a.latitude, pair.a.longitude],
        [pair.b.latitude, pair.b.longitude]
      ],
      notes: [
        `${pair.a.stationId} to ${pair.b.stationId}`,
        ...pair.notes
      ]
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    buoyCount: payload.buoys.length,
    evaluatedPairs: pairSignals.length,
    fronts
  };
}

function buildFishingAdvisor(payload: {
  species: string;
  catches: AdvisorCatchInput[];
  buoys: OceanBuoyObservation[];
  context: FishingAdvisorContext | null;
}): FishingAdvisorResult {
  const normalizedSpecies = payload.species === "All fish" ? "Yellowfin" : payload.species;
  const tempRange = getSpeciesTemperatureRangeF(normalizedSpecies);
  const frontPreference = getSpeciesFrontPreference(normalizedSpecies);
  const now = Date.now();
  const marineBuoys = filterBuoysToMarineRegion({
    buoys: payload.buoys,
    context: payload.context
  }).filter((buoy) => !isLikelyNearshoreInvalid({ latitude: buoy.latitude, longitude: buoy.longitude }));
  const oceanSignals = buildBuoySignalFronts({
    buoys: marineBuoys,
    species: normalizedSpecies,
    temperatureRangeF: tempRange
  });

  const catches = payload.catches.filter((catchItem) => {
    return catchItem.latitude !== null
      && catchItem.longitude !== null
      && catchItem.species.toLowerCase().includes(normalizedSpecies.toLowerCase())
      && !isLikelyNearshoreInvalid({ latitude: catchItem.latitude, longitude: catchItem.longitude });
  });

  const buoyTempValues = marineBuoys
    .filter((buoy) => buoy.waterTempC !== null)
    .map((buoy) => ({
      ...buoy,
      tempF: ((buoy.waterTempC as number) * 9 / 5) + 32
    }));

  const strongestFrontScore = oceanSignals.fronts[0]?.score ?? 48;
  const frontStrength = strongestFrontScore >= 82 ? 4 : strongestFrontScore >= 70 ? 3 : strongestFrontScore >= 58 ? 2 : 1;
  const currentConvergence = marineBuoys.some((buoy) => buoy.windSpeedMps !== null && buoy.windSpeedMps > 4)
    ? "strong"
    : marineBuoys.some((buoy) => buoy.windSpeedMps !== null && buoy.windSpeedMps > 2)
      ? "moderate"
      : "light";

  const bucketByCell = new Map<string, AdvisorCatchInput[]>();
  catches.forEach((catchItem) => {
    const lat = catchItem.latitude as number;
    const lng = catchItem.longitude as number;
    const key = `${Math.round(lat * 4) / 4}:${Math.round(lng * 4) / 4}`;
    const existing = bucketByCell.get(key) ?? [];
    existing.push(catchItem);
    bucketByCell.set(key, existing);
  });

  const zones: FishingAdvisorZone[] = Array.from(bucketByCell.entries()).map(([id, group]) => {
    const latitude = group.reduce((sum, catchItem) => sum + (catchItem.latitude as number), 0) / group.length;
    const longitude = group.reduce((sum, catchItem) => sum + (catchItem.longitude as number), 0) / group.length;
    const offshoreCenter = enforceSpeciesOffshoreBuffer({ latitude, longitude }, normalizedSpecies, marineBuoys);
    const requiredOffshoreNm = minOffshoreNmForSpecies(normalizedSpecies);
    const offshoreNmAtCenter = offshoreDistanceFromAtlanticCoastNm(offshoreCenter);
    if (offshoreNmAtCenter !== null && offshoreNmAtCenter < requiredOffshoreNm) {
      return null;
    }
    const recency = group.reduce((sum, catchItem) => {
      const ageDays = Math.max(0, (now - new Date(catchItem.timestamp).getTime()) / (1000 * 60 * 60 * 24));
      return sum + Math.exp(-ageDays / 8);
    }, 0) / group.length;

    const nearbyBuoy = marineBuoys
      .map((buoy) => ({
        buoy,
        distance: Math.hypot(buoy.latitude - offshoreCenter.latitude, buoy.longitude - offshoreCenter.longitude)
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.buoy;

    const nearestFront = oceanSignals.fronts
      .map((front) => ({
        front,
        weightedScore: front.score * (front.kind === "sst" ? frontPreference.sst : frontPreference.convergence),
        distance: distanceNm(front.midpoint.latitude, front.midpoint.longitude, offshoreCenter.latitude, offshoreCenter.longitude)
      }))
      .sort((a, b) => {
        const aValue = (a.weightedScore / 100) - (a.distance / 60);
        const bValue = (b.weightedScore / 100) - (b.distance / 60);
        return bValue - aValue;
      })[0];

    let tempFit = 0.4;
    if (nearbyBuoy?.waterTempC !== null && nearbyBuoy?.waterTempC !== undefined) {
      const waterTempF = (nearbyBuoy.waterTempC * 9 / 5) + 32;
      if (waterTempF >= tempRange.min && waterTempF <= tempRange.max) {
        tempFit = 1;
      } else {
        const miss = Math.min(Math.abs(waterTempF - tempRange.min), Math.abs(waterTempF - tempRange.max));
        tempFit = Math.max(0.2, 1 - (miss / 18));
      }
    }

    const frontFit = nearestFront
      ? Math.max(0, 1 - (nearestFront.distance / 28))
        * ((nearestFront.weightedScore / 100))
      : 0.22;

    const offshoreFit = offshoreNmAtCenter === null
      ? 0.5
      : offshoreNmAtCenter >= requiredOffshoreNm
        ? Math.min(1, 0.6 + ((offshoreNmAtCenter - requiredOffshoreNm) / Math.max(20, requiredOffshoreNm)) * 0.4)
        : Math.max(0, offshoreNmAtCenter / requiredOffshoreNm);

    const score = Math.min(99, Math.round((group.length * 14) + (recency * 33) + (tempFit * 29) + (frontFit * 24) + (offshoreFit * 18)));
    const confidence: "high" | "medium" | "low" = score >= 72 ? "high" : score >= 52 ? "medium" : "low";
    const baseRadiusNm = Math.min(14, 4 + (group.length * 1.6));
    const shoreSafeRadiusNm = offshoreNmAtCenter === null
      ? baseRadiusNm
      : Math.max(2.8, Math.min(baseRadiusNm, Math.max(2.8, offshoreNmAtCenter - (requiredOffshoreNm * 0.45))));

    const lures = Array.from(new Set(group.map((catchItem) => catchItem.bait.split(" (")[0]?.trim() || "Unknown lure"))).slice(0, 3);
    const nearbyTempF = nearbyBuoy?.waterTempC !== null && nearbyBuoy?.waterTempC !== undefined
      ? (nearbyBuoy.waterTempC * 9 / 5 + 32)
      : null;
    const reasoning = [
      `${group.length} historical ${normalizedSpecies} catches near this lane`,
      `SST front strength ${frontStrength}/4 based on nearby public buoy temperature gradient`,
      `Current convergence: ${currentConvergence}`,
      nearbyBuoy && nearbyTempF !== null
        ? `Nearby buoy ${nearbyBuoy.stationId} SST ${nearbyTempF.toFixed(1)} F`
        : "No nearby buoy SST reading, scoring from catch history only",
      nearestFront
        ? `Nearest public-data front ${nearestFront.front.label} (${nearestFront.front.strength.toUpperCase()}) at ${nearestFront.distance.toFixed(1)} NM, weighted ${nearestFront.weightedScore.toFixed(0)} for ${normalizedSpecies}`
        : "No resolved buoy front near this lane",
      `Top lure signals: ${lures.join(", ")}`
    ];

    return {
      id,
      label: `${normalizedSpecies} lane ${id}`,
      latitude: offshoreCenter.latitude,
      longitude: offshoreCenter.longitude,
      radiusNm: Number(shoreSafeRadiusNm.toFixed(1)),
      score,
      confidence,
      reasoning
    };
  }).filter((zone): zone is FishingAdvisorZone => zone !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (zones.length === 0) {
    const buoyFallback = marineBuoys
      .filter((buoy) => buoy.waterTempC !== null)
      .map((buoy) => ({
        buoy,
        delta: Math.abs((((buoy.waterTempC as number) * 9) / 5 + 32) - ((tempRange.min + tempRange.max) / 2))
      }))
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 3);

    buoyFallback.forEach((entry, index) => {
      const offshoreCenter = enforceSpeciesOffshoreBuffer({ latitude: entry.buoy.latitude, longitude: entry.buoy.longitude }, normalizedSpecies, marineBuoys);
      const requiredOffshoreNm = minOffshoreNmForSpecies(normalizedSpecies);
      const offshoreNmAtCenter = offshoreDistanceFromAtlanticCoastNm(offshoreCenter);
      if (offshoreNmAtCenter !== null && offshoreNmAtCenter < requiredOffshoreNm) {
        return;
      }
      const baseRadiusNm = 6 + index;
      const shoreSafeRadiusNm = offshoreNmAtCenter === null
        ? baseRadiusNm
        : Math.max(3, Math.min(baseRadiusNm, Math.max(3, offshoreNmAtCenter - (requiredOffshoreNm * 0.45))));
      zones.push({
        id: `buoy-${entry.buoy.stationId}`,
        label: `${normalizedSpecies} temp window near ${entry.buoy.stationId}`,
        latitude: offshoreCenter.latitude,
        longitude: offshoreCenter.longitude,
        radiusNm: Number(shoreSafeRadiusNm.toFixed(1)),
        score: Math.max(45, 74 - Math.round(entry.delta * 3)),
        confidence: index === 0 ? "medium" : "low",
        reasoning: [
          `Fallback from buoy thermal window matching ${tempRange.min}-${tempRange.max} F`,
          `Buoy SST ${(((entry.buoy.waterTempC as number) * 9) / 5 + 32).toFixed(1)} F`
        ]
      });
    });
  }

  const primaryZone = zones[0];
  const bestWindow = "Run edges 90-150 minutes around first-light and tide transition for highest strike probability.";

  return {
    generatedAt: new Date().toISOString(),
    species: normalizedSpecies,
    summary: primaryZone
      ? `${normalizedSpecies} probability is strongest around ${primaryZone.label} with confidence ${primaryZone.confidence.toUpperCase()}.`
      : `Not enough geotagged ${normalizedSpecies} catches yet. Using temperature windows from nearby buoys.`,
    recommendation: primaryZone
      ? `Start your first pass inside the ${primaryZone.radiusNm.toFixed(0)} NM ring around ${primaryZone.label}, then ladder outward until temperature breaks and bait concentrations overlap.`
      : `Build 3-5 more geotagged catches for ${normalizedSpecies} to unlock higher-confidence lane prediction.`,
    bestWindow,
    temperatureRangeF: tempRange,
    zones,
    oceanSignals,
    notes: [
      `Public-data blend: NOAA NDBC buoy SST + current proxy + catch-history clustering + species temperature fit.`,
      `Observed front signal: ${frontStrength}/4 on the nearest public SST gradient with ${currentConvergence} current convergence.`,
      `Marine filter retained ${marineBuoys.length} buoys inside the local advisory radius.`,
      `Resolved ${oceanSignals.fronts.length} buoy-network fronts from ${oceanSignals.evaluatedPairs} buoy-pair gradients in this viewport.`
    ]
  };
}

async function buildSummary() {
  const baseSummary = structuredClone(dashboardSummary) as any;
  const nmea = await getNmeaTelemetry();
  const weatherPoint = resolveWeatherReferencePoint(nmea.telemetry);
  const externalWeather = weatherPoint
    ? await loadExternalMarineWeather(weatherPoint.latitude, weatherPoint.longitude).catch(() => null)
    : null;
  baseSummary.camera = getCameraRuntimeStatus();
  baseSummary.connectivity.nmea = nmea.status;

  if (externalWeather && externalWeather.windKnots !== null) {
    baseSummary.weather.wind = `${Math.round(externalWeather.windKnots)} kt`;
  }

  if (externalWeather && externalWeather.barometerHpa !== null) {
    baseSummary.weather.barometer = `${externalWeather.barometerHpa.toFixed(1)} hPa`;
  }

  if (externalWeather && externalWeather.tideFeet !== null) {
    baseSummary.weather.tide = formatTideLabel(externalWeather.tideFeet, externalWeather.tideTrend);
  }

  if (externalWeather && externalWeather.waterTempF !== null) {
    baseSummary.weather.waterTemp = `${externalWeather.waterTempF.toFixed(1)} F`;
  }

  if (weatherPoint && !nmea.telemetry?.latitude && !nmea.telemetry?.longitude) {
    baseSummary.connectivity.gps = `${weatherPoint.latitude.toFixed(5)}, ${weatherPoint.longitude.toFixed(5)} (${weatherPoint.source})`;
  }

  if (nmea.telemetry) {
    const { speedKnots, headingDegrees, depthFeet, waterTempF, latitude, longitude } = nmea.telemetry;

    if (speedKnots !== null) {
      setMetricValue(baseSummary, "Speed", speedKnots.toFixed(1), "kt");
    }

    if (headingDegrees !== null) {
      setMetricValue(baseSummary, "Heading", Math.round(headingDegrees).toString(), "deg");
    }

    if (depthFeet !== null) {
      setMetricValue(baseSummary, "Depth", depthFeet.toFixed(0), "ft");
    }

    if (waterTempF !== null) {
      baseSummary.weather.waterTemp = `${waterTempF.toFixed(1)} F`;
    }

    if (latitude !== null && longitude !== null) {
      baseSummary.vesselPosition = {
        latitude,
        longitude,
        source: nmea.telemetry.source,
        updatedAt: nmea.telemetry.updatedAt
      };
      baseSummary.connectivity.gps = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    }
  }

  return {
    ...baseSummary,
    update: await resolveUpdateStatus(currentVersion, currentChannel)
  };
}

async function readRequestJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  const text = Buffer.concat(chunks).toString("utf-8");
  return text.length > 0 ? JSON.parse(text) as Record<string, unknown> : null;
}

async function readRequestBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

async function proxySignalkRequest(req: http.IncomingMessage, res: http.ServerResponse, pathWithQuery: string) {
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? null : await readRequestBody(req);
  const upstreamHeaders: Record<string, string> = {};

  Object.entries(req.headers).forEach(([key, value]) => {
    if (!value) {
      return;
    }

    const lowerKey = key.toLowerCase();
    if (lowerKey === "host" || lowerKey === "connection" || lowerKey === "content-length") {
      return;
    }

    upstreamHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
  });

  try {
    const upstream = await fetch(`${SIGNALK_PROXY_BASE_URL}${pathWithQuery}`, {
      method,
      headers: upstreamHeaders,
      body,
      signal: AbortSignal.timeout(20000)
    });

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === "transfer-encoding"
        || lowerKey === "connection"
        || lowerKey === "content-length"
        || lowerKey === "content-encoding"
      ) {
        return;
      }

      responseHeaders[key] = value;
    });

    res.writeHead(upstream.status, responseHeaders);
    if (method === "HEAD") {
      res.end();
      return;
    }

    const payload = Buffer.from(await upstream.arrayBuffer());
    res.end(payload);
  } catch (error) {
    json(res, 502, {
      error: "Signal K upstream unavailable",
      detail: error instanceof Error ? error.message : "Unknown proxy error"
    });
  }
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function json(res: http.ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendFile(filePath: string, res: http.ServerResponse) {
  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": contentType.startsWith("image/") ? "public, max-age=86400" : "no-cache"
  });
  createReadStream(filePath).pipe(res);
}

function removeCameraClient(res: http.ServerResponse) {
  if (!cameraStreamClients.delete(res)) {
    return;
  }

  if (cameraStreamClients.size > 0) {
    return;
  }

  if (cameraStreamStopTimer) {
    clearTimeout(cameraStreamStopTimer);
  }

  cameraStreamStopTimer = setTimeout(() => {
    if (cameraStreamClients.size > 0) {
      return;
    }

    if (cameraStreamProcess) {
      try {
        cameraStreamProcess.kill("SIGTERM");
      } catch {
        // Process is already gone.
      }
      cameraStreamProcess = null;
    }
  }, CAMERA_STREAM_STOP_DELAY_MS);
}

function toIsoOrNull(value: number) {
  return value > 0 ? new Date(value).toISOString() : null;
}

function getCameraDeviceCandidates() {
  const configured = (process.env.PALMER_LOU_CAMERA_DEVICE ?? "").trim();
  const configuredList = (process.env.PALMER_LOU_CAMERA_DEVICE_CANDIDATES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const fallback = ["/dev/video0", "/dev/video1", "/dev/video2"];
  const deduped = new Set<string>();

  if (configured.length > 0) {
    deduped.add(configured);
  }
  for (const candidate of configuredList) {
    deduped.add(candidate);
  }
  for (const candidate of fallback) {
    deduped.add(candidate);
  }

  return Array.from(deduped);
}

function getCameraRuntimeStatus() {
  const now = Date.now();
  const candidates = cameraLastCandidateList.length > 0 ? cameraLastCandidateList : getCameraDeviceCandidates();
  const selectedDevice = candidates.find((candidate) => existsSync(candidate)) ?? null;
  const frameAgeMs = cameraLastFrameAt > 0 ? Math.max(0, now - cameraLastFrameAt) : null;
  const streamActive = cameraStreamProcess !== null && frameAgeMs !== null && frameAgeMs < 6000;
  const clientCount = cameraStreamClients.size;
  const status = !selectedDevice
    ? "Offline"
    : streamActive
      ? "Live"
      : clientCount > 0
        ? "Degraded"
        : "Ready";

  return {
    ...dashboardSummary.camera,
    status,
    recording: streamActive,
    latencyMs: frameAgeMs ?? 0,
    streamActive,
    activeClients: clientCount,
    selectedDevice,
    candidates,
    devicePresent: selectedDevice !== null,
    processRunning: cameraStreamProcess !== null,
    startedAt: toIsoOrNull(cameraLastStartAt),
    lastFrameAt: toIsoOrNull(cameraLastFrameAt),
    restartCount: cameraRestartCount,
    lastExitCode: cameraLastExitCode,
    lastExitSignal: cameraLastExitSignal,
    lastError: cameraLastError,
    lastStderr: cameraLastStderr
  };
}

function startCameraBroadcast() {
  if (cameraStreamProcess) {
    return;
  }

  const candidates = getCameraDeviceCandidates();
  cameraLastCandidateList = candidates;
  const device = candidates.find((candidate) => existsSync(candidate));
  if (!device) {
    cameraLastError = `Camera device not found. Checked: ${candidates.join(", ")}`;
    for (const client of cameraStreamClients) {
      if (client.writableEnded || client.destroyed) {
        continue;
      }
      client.write(`--ffmpeg\r\nContent-Type: text/plain\r\n\r\n${cameraLastError}\r\n`);
      client.end();
    }
    cameraStreamClients.clear();
    return;
  }

  cameraLastStartAt = Date.now();
  cameraRestartCount += 1;
  cameraLastExitCode = null;
  cameraLastExitSignal = null;
  cameraLastStderr = "";

  const ff = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-f", "v4l2",
    "-thread_queue_size", "128",
    "-framerate", "30",
    "-i", device,
    "-vf", "scale=960:-2",
    "-f", "mpjpeg",
    "-q:v", "8",
    "-"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  cameraStreamProcess = ff;

  ff.stdout.on("data", (chunk: Buffer) => {
    cameraLastFrameAt = Date.now();
    cameraLastError = null;
    for (const client of Array.from(cameraStreamClients)) {
      if (client.writableEnded || client.destroyed) {
        removeCameraClient(client);
        continue;
      }

      try {
        client.write(chunk);
      } catch {
        try {
          client.end();
        } catch {
          // Ignore close errors.
        }
        removeCameraClient(client);
      }
    }
  });

  ff.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").trim();
    if (text.length === 0) {
      return;
    }

    cameraLastStderr = text.split(/\r?\n/).slice(-4).join(" | ");
    cameraLastError = cameraLastStderr;
    console.warn(`[camera] ${cameraLastStderr}`);
  });

  const handleCameraExit = (code?: number | null, signal?: NodeJS.Signals | null, errorMessage?: string) => {
    if (cameraStreamProcess === ff) {
      cameraStreamProcess = null;
    }

    if (typeof code === "number") {
      cameraLastExitCode = code;
    }
    if (signal) {
      cameraLastExitSignal = signal;
    }
    if (cameraStreamClients.size === 0 && code === 255 && !signal && !errorMessage) {
      // ffmpeg exits 255 on normal stdin/pipe teardown in some builds.
      cameraLastError = null;
      cameraLastStderr = "";
    } else if (errorMessage && errorMessage.length > 0) {
      cameraLastError = errorMessage;
    } else if (cameraLastError === null) {
      cameraLastError = `ffmpeg exited${typeof code === "number" ? ` code ${code}` : ""}${signal ? ` signal ${signal}` : ""}`;
    }

    if (cameraStreamClients.size > 0) {
      setTimeout(() => {
        if (cameraStreamClients.size > 0 && !cameraStreamProcess) {
          startCameraBroadcast();
        }
      }, 1200);
    }
  };

  ff.on("close", (code, signal) => {
    handleCameraExit(code, signal ?? null);
  });
  ff.on("error", (error) => {
    const message = error instanceof Error ? error.message : "Unknown ffmpeg spawn error";
    handleCameraExit(null, null, message);
  });
}

function attachCameraClient(req: http.IncomingMessage, res: http.ServerResponse) {
  if (cameraStreamStopTimer) {
    clearTimeout(cameraStreamStopTimer);
    cameraStreamStopTimer = null;
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Connection": "keep-alive"
  });

  cameraStreamClients.add(res);
  startCameraBroadcast();

  const cleanup = () => removeCameraClient(res);
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function withinUiDist(filePath: string) {
  const resolved = path.resolve(filePath);
  return resolved === uiDist || resolved.startsWith(`${uiDist}${path.sep}`);
}

async function serveUi(reqPath: string, res: http.ServerResponse) {
  const candidate = path.resolve(uiDist, `.${reqPath}`);
  if (existsSync(candidate) && withinUiDist(candidate) && statSync(candidate).isFile()) {
    sendFile(candidate, res);
    return true;
  }

  const indexPath = path.resolve(uiDist, "index.html");
  if (existsSync(indexPath)) {
    sendFile(indexPath, res);
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const { pathname } = url;

  if (pathname === "/signalk" || pathname.startsWith("/signalk/") || pathname.startsWith("/plugins/")) {
    await proxySignalkRequest(req, res, `${pathname}${url.search}`);
    return;
  }

  if (pathname === "/api/bluetooth/action" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const action = payload?.action;
      const mac = typeof payload?.mac === "string" ? payload.mac.toUpperCase().trim() : "";
      const name = typeof payload?.name === "string" ? payload.name.trim() : "";

      if (action !== "pair" && action !== "reconnect" && action !== "route-audio" && action !== "disconnect") {
        json(res, 400, { error: "Invalid Bluetooth action" });
        return;
      }

      if (mac && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
        json(res, 400, { error: "Invalid MAC address format — expected AA:BB:CC:DD:EE:FF" });
        return;
      }

      json(res, 200, await applyBluetoothAction(action as BluetoothAction, mac || undefined, name || undefined));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to apply Bluetooth action",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/bluetooth/diagnostics" && req.method === "POST") {
    try {
      json(res, 200, await runBluetoothDiagnostics());
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to run Bluetooth diagnostics",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/bluetooth/scan" && req.method === "GET") {
    const devices = await scanBluetoothDevices();
    json(res, 200, { devices });
    return;
  }

  if (pathname === "/api/bluetooth/configure" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const mac = (typeof payload?.mac === "string" ? payload.mac : "").toUpperCase().trim();
      const deviceName = typeof payload?.name === "string" ? payload.name : mac;
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
        json(res, 400, { error: "Invalid MAC address format — expected AA:BB:CC:DD:EE:FF" });
        return;
      }
      await configureBluetoothDevice(mac, deviceName);
      json(res, 200, await getBluetoothState());
      return;
    } catch (error) {
      json(res, 400, {
        error: "Failed to configure Bluetooth device",
        detail: error instanceof Error ? error.message : "Invalid request"
      });
      return;
    }
  }

  if (pathname === "/api/wifi" && req.method === "GET") {
    try {
      const shouldScan = url.searchParams.get("scan") === "1";
      json(res, 200, await scanWifiNetworks(shouldScan));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to scan Wi‑Fi networks",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/wifi/connect" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const ssid = typeof payload?.ssid === "string" ? payload.ssid.trim() : "";
      const password = typeof payload?.password === "string" ? payload.password : "";

      if (!ssid) {
        json(res, 400, { error: "Missing Wi‑Fi SSID" });
        return;
      }

      json(res, 200, await joinWifiNetwork(ssid, password));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to connect to Wi‑Fi network",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/wifi/disconnect" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const ssid = typeof payload?.ssid === "string" ? payload.ssid.trim() : "";

      json(res, 200, await disconnectWifiNetwork(ssid || undefined));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to disconnect from Wi‑Fi network",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/camera/stream" && req.method === "GET") {
    attachCameraClient(req, res);
    return;
  }

  if (pathname === "/api/launch/app" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const appId = typeof payload?.appId === "string" ? payload.appId : "";
      const name = typeof payload?.name === "string" ? payload.name : "";
      const launchUrl = typeof payload?.launchUrl === "string" ? payload.launchUrl : "";
      const launchLabel = typeof payload?.launchLabel === "string" ? payload.launchLabel : "Launch app";
      const requestSource = payload?.requestSource === "remote" ? "remote" : "kiosk";

      if (!appId || !name || !launchUrl) {
        json(res, 400, { error: "Invalid launch request" });
        return;
      }

      json(res, 200, await launchApp({ appId, name, launchUrl, launchLabel, requestSource }));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to launch app",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/launch/return" && req.method === "POST") {
    try {
      json(res, 200, await returnToHome());
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to return home",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/launch/kill" && req.method === "POST") {
    try {
      json(res, 200, await killLaunchedApp());
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to kill launched app",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/remote/access/action" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const action = payload?.action;

      if (action !== "start" && action !== "stop" && action !== "restart" && action !== "status") {
        json(res, 400, { error: "Invalid remote tunnel action" });
        return;
      }

      json(res, 200, await runTunnelAction(action));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to run remote tunnel action",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/remote/control/action" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const action = payload?.action;
      const targetAppId = typeof payload?.appId === "string" ? payload.appId.trim() : "";
      const controlModeRaw = typeof payload?.controlMode === "string" ? payload.controlMode.trim().toLowerCase() : "";
      const controlMode = controlModeRaw === "keys" ? "keys" : "cursor";
      const repeatRaw = Number(payload?.repeat ?? 1);
      const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.min(8, Math.floor(repeatRaw))) : 1;

      const validActions: RemoteControlAction[] = ["up", "down", "left", "right", "select", "back", "home", "playpause", "volup", "voldown", "mute", "backspace"];
      if (typeof action !== "string" || !validActions.includes(action as RemoteControlAction)) {
        json(res, 400, { error: "Invalid remote control action" });
        return;
      }

      if (action === "home") {
        json(res, 200, await returnToHome());
        return;
      }

      json(res, 200, await runRemoteControlAction(
        action as RemoteControlAction,
        repeat,
        {
          ...(targetAppId ? { targetAppId } : {}),
          controlMode
        }
      ));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to run remote control action",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/remote/type" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const text = typeof payload?.text === "string" ? payload.text : "";
      if (!text) {
        json(res, 400, { error: "Missing text" });
        return;
      }
      json(res, 200, await runRemoteTypeAction(text));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to type text",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/remote/update/apply" && req.method === "POST") {
    try {
      json(res, 200, await runRemoteUpdate(repoRoot));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to run remote update",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/fishing/advisor" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const species = typeof payload?.species === "string" ? payload.species : "Yellowfin";
      const catches = Array.isArray(payload?.catches) ? payload.catches as AdvisorCatchInput[] : [];
      const providedBuoys = Array.isArray(payload?.buoys) ? payload.buoys as OceanBuoyObservation[] : [];
      const referenceLatitude = typeof payload?.referenceLatitude === "number" ? payload.referenceLatitude : null;
      const referenceLongitude = typeof payload?.referenceLongitude === "number" ? payload.referenceLongitude : null;
      const requestedRadius = typeof payload?.maxRadiusNm === "number" ? payload.maxRadiusNm : 1400;
      const context = referenceLatitude !== null && referenceLongitude !== null
        ? {
            referenceLatitude,
            referenceLongitude,
            maxRadiusNm: Math.max(80, Math.min(2200, requestedRadius))
          }
        : null;

      void providedBuoys;
      const buoys = await loadBuoyObservations();

      json(res, 200, buildFishingAdvisor({ species, catches, buoys, context }));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to compute fishing advisor",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/fishing/species-intel" && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      const catches = Array.isArray(payload?.catches) ? payload.catches as AdvisorCatchInput[] : [];
      const providedBuoys = Array.isArray(payload?.buoys) ? payload.buoys as OceanBuoyObservation[] : [];
      const referenceLatitude = typeof payload?.referenceLatitude === "number" ? payload.referenceLatitude : null;
      const referenceLongitude = typeof payload?.referenceLongitude === "number" ? payload.referenceLongitude : null;
      const requestedRadius = typeof payload?.maxRadiusNm === "number" ? payload.maxRadiusNm : 1600;
      const context = referenceLatitude !== null && referenceLongitude !== null
        ? { referenceLatitude, referenceLongitude, maxRadiusNm: Math.max(80, Math.min(2200, requestedRadius)) }
        : null;
      void providedBuoys;
      const buoys = await loadBuoyObservations();

      json(res, 200, buildAllSpeciesIntel({ buoys, catches, context }));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to build species intel",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method !== "GET") {
    if (pathname === "/api/home-port-config" && req.method === "POST") {
      const payload = await readRequestJson(req);
      const saved = writeHomePortConfig(payload);
      json(res, 200, saved);
      return;
    }

    res.writeHead(405, { Allow: "GET" });
    res.end("Method not allowed");
    return;
  }

  if (pathname === "/api/home-port-config") {
    json(res, 200, readHomePortConfig());
    return;
  }

  if (pathname === "/api/health") {
    json(res, 200, { ok: true, service: "palmer-lou-backend" });
    return;
  }

  if (pathname === "/api/time") {
    const formatter = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short"
    });

    json(res, 200, {
      iso: new Date().toISOString(),
      epochMs: Date.now(),
      locale: formatter.resolvedOptions().locale,
      timeZone: formatter.resolvedOptions().timeZone,
      label: formatter.format(new Date())
    });
    return;
  }

  if (pathname === "/api/summary") {
    json(res, 200, await buildSummary());
    return;
  }

  if (pathname === "/api/version") {
    json(res, 200, await resolveUpdateStatus(currentVersion, currentChannel));
    return;
  }

  if (pathname === "/api/update/check") {
    json(res, 200, await resolveUpdateStatus(currentVersion, currentChannel));
    return;
  }

  if (pathname === "/api/remote/access") {
    const status: RemoteAccessStatus = await getRemoteAccessStatus();
    json(res, 200, status);
    return;
  }

  if (pathname === "/api/remote/update") {
    json(res, 200, getRemoteUpdateStatus(repoRoot));
    return;
  }

  if (pathname === "/api/ocean/buoys") {
    try {
      const minLat = Number.parseFloat(url.searchParams.get("minLat") ?? "-90");
      const maxLat = Number.parseFloat(url.searchParams.get("maxLat") ?? "90");
      const minLng = Number.parseFloat(url.searchParams.get("minLng") ?? "-180");
      const maxLng = Number.parseFloat(url.searchParams.get("maxLng") ?? "180");
      const limit = Math.max(1, Math.min(180, Number.parseInt(url.searchParams.get("limit") ?? "64", 10)));

      const allBuoys = await loadBuoyObservations();
      const centerLat = (minLat + maxLat) / 2;
      const centerLng = (minLng + maxLng) / 2;

      const filtered = allBuoys
        .filter((buoy) => buoy.latitude >= minLat && buoy.latitude <= maxLat && buoy.longitude >= minLng && buoy.longitude <= maxLng)
        .filter((buoy) => buoy.waterTempC !== null || buoy.windSpeedMps !== null || buoy.waveHeightM !== null)
        .sort((a, b) => {
          const distanceA = Math.hypot(a.latitude - centerLat, a.longitude - centerLng);
          const distanceB = Math.hypot(b.latitude - centerLat, b.longitude - centerLng);
          return distanceA - distanceB;
        })
        .slice(0, limit);

      json(res, 200, {
        generatedAt: new Date().toISOString(),
        source: "NOAA NDBC latest_obs",
        count: filtered.length,
        buoys: filtered
      });
      return;
    } catch (error) {
      json(res, 502, {
        error: "Failed to load buoy observations",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/ocean/currents") {
    try {
      const bounds = parseOceanBounds(url);
      const limit = Math.max(12, Math.min(180, Number.parseInt(url.searchParams.get("limit") ?? "96", 10)));
      const result = await loadOceanCurrentVectors(bounds, limit);

      json(res, 200, {
        generatedAt: new Date().toISOString(),
        source: result.source,
        count: result.vectors.length,
        vectors: result.vectors
      });
      return;
    } catch (error) {
      json(res, 502, {
        error: "Failed to load ocean current vectors",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/weather/radar/frame") {
    try {
      const radar = await loadStormRadarFrame();
      if (!radar.frame) {
        json(res, 200, {
          available: false,
          source: "RainViewer",
          message: "No radar frame available"
        });
        return;
      }

      json(res, 200, {
        available: true,
        source: "RainViewer",
        observedAt: radar.frame.time ? new Date(radar.frame.time * 1000).toISOString() : null,
        tileUrlTemplate: `/api/weather/radar/tiles/{z}/{x}/{y}.png?path=${encodeURIComponent(radar.frame.path)}`,
        timeline: radar.timeline.map((frame) => ({
          kind: frame.kind,
          observedAt: frame.time ? new Date(frame.time * 1000).toISOString() : null,
          tileUrlTemplate: `/api/weather/radar/tiles/{z}/{x}/{y}.png?path=${encodeURIComponent(frame.path)}`
        }))
      });
      return;
    } catch (error) {
      json(res, 502, {
        available: false,
        source: "RainViewer",
        message: "Failed to fetch storm radar frame",
        detail: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (pathname === "/api/weather/forecast") {
    try {
      const result = await loadWindyForecast();
      if (result.cards.length > 0) {
        json(res, 200, {
          available: result.available,
          source: result.source,
          cards: result.cards
        });
        return;
      }

      const nmea = await getNmeaTelemetry();
      const weatherPoint = resolveWeatherReferencePoint(nmea.telemetry);
      if (weatherPoint) {
        const externalWeather = await loadExternalMarineWeather(weatherPoint.latitude, weatherPoint.longitude).catch(() => null);
        if (externalWeather && externalWeather.cards.length > 0) {
          json(res, 200, {
            available: true,
            source: externalWeather.source,
            cards: externalWeather.cards
          });
          return;
        }
      }

      json(res, 200, {
        available: false,
        source: result.source,
        cards: []
      });
      return;
    } catch {
      const nmea = await getNmeaTelemetry().catch(() => ({ telemetry: null }));
      const weatherPoint = resolveWeatherReferencePoint(nmea.telemetry);
      if (weatherPoint) {
        const externalWeather = await loadExternalMarineWeather(weatherPoint.latitude, weatherPoint.longitude).catch(() => null);
        if (externalWeather && externalWeather.cards.length > 0) {
          json(res, 200, {
            available: true,
            source: externalWeather.source,
            cards: externalWeather.cards
          });
          return;
        }
      }

      json(res, 200, {
        available: false,
        source: "Signal K Windy / Open-Meteo fallback",
        cards: []
      });
      return;
    }
  }

  const stormRadarTileMatch = pathname.match(/^\/api\/weather\/radar\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (stormRadarTileMatch) {
    const requestedZ = Number.parseInt(stormRadarTileMatch[1] ?? "0", 10);
    const requestedX = Number.parseInt(stormRadarTileMatch[2] ?? "0", 10);
    const requestedY = Number.parseInt(stormRadarTileMatch[3] ?? "0", 10);

    const z = Math.max(0, Math.min(STORM_RADAR_MAX_NATIVE_ZOOM, requestedZ));
    const zoomFactor = requestedZ > z ? 2 ** (requestedZ - z) : 1;
    const x = Math.floor(requestedX / zoomFactor);
    const y = Math.floor(requestedY / zoomFactor);
    const maxTileIndex = (2 ** z) - 1;

    if (!Number.isFinite(requestedZ) || !Number.isFinite(requestedX) || !Number.isFinite(requestedY) || !Number.isFinite(x) || !Number.isFinite(y)) {
      json(res, 400, { error: "Invalid radar tile coordinates" });
      return;
    }

    if (x < 0 || y < 0 || x > maxTileIndex || y > maxTileIndex) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=120",
        "X-PalmerLou-Radar-Cache": "OUT_OF_RANGE"
      });
      res.end(TRANSPARENT_PNG_BUFFER);
      return;
    }

    try {
      const radar = await loadStormRadarFrame();
      const pathFromQuery = (url.searchParams.get("path") ?? "").trim();
      const framePath = pathFromQuery || radar.frame?.path;
      if (!framePath) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=120" });
        res.end(TRANSPARENT_PNG_BUFFER);
        return;
      }

      const host = radar.host;
      const cacheKey = `${framePath}:${z}:${x}:${y}`;
      const now = Date.now();
      const cached = stormRadarTileCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        res.writeHead(200, {
          "Content-Type": cached.contentType,
          "Cache-Control": "public, max-age=180",
          "X-PalmerLou-Radar-Cache": "HIT"
        });
        res.end(cached.body);
        return;
      }

      const remoteUrl = buildStormRadarTileUrl(host, framePath, z, x, y);
      const remoteResponse = await fetch(remoteUrl, {
        headers: {
          "User-Agent": "Palmer-Lou-OS/1.0 (+storm-radar-proxy)"
        },
        signal: AbortSignal.timeout(12000)
      });

      const contentType = (remoteResponse.headers.get("content-type") ?? "").toLowerCase();
      if (!remoteResponse.ok || !contentType.startsWith("image/")) {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=120",
          "X-PalmerLou-Radar-Cache": "MISS_EMPTY"
        });
        res.end(TRANSPARENT_PNG_BUFFER);
        return;
      }

      const responseContentType = remoteResponse.headers.get("content-type") ?? "image/png";
      const body = Buffer.from(await remoteResponse.arrayBuffer());
      stormRadarTileCache.set(cacheKey, {
        expiresAt: now + STORM_RADAR_TILE_CACHE_TTL_MS,
        contentType: responseContentType,
        body
      });
      pruneStormRadarTileCache();

      res.writeHead(200, {
        "Content-Type": responseContentType,
        "Cache-Control": "public, max-age=180",
        "X-PalmerLou-Radar-Cache": "MISS"
      });
      res.end(body);
      return;
    } catch {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=120",
        "X-PalmerLou-Radar-Cache": "UNAVAILABLE"
      });
      res.end(TRANSPARENT_PNG_BUFFER);
      return;
    }
  }

  const oceanTileRouteMatch = pathname.match(/^\/api\/ocean\/tiles\/(sst|chlorophyll|currents)\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (oceanTileRouteMatch) {
    const source = oceanTileRouteMatch[1] as OceanTileSource;
    const z = Number.parseInt(oceanTileRouteMatch[2] ?? "0", 10);
    const x = Number.parseInt(oceanTileRouteMatch[3] ?? "0", 10);
    const y = Number.parseInt(oceanTileRouteMatch[4] ?? "0", 10);

    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
      json(res, 400, { error: "Invalid tile coordinates" });
      return;
    }

    const date = normalizeOceanOverlayDate(url.searchParams.get("date"));
    const cacheKey = `${source}:${date}:${z}:${x}:${y}`;
    const cached = oceanTileCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      res.writeHead(200, {
        "Content-Type": cached.contentType,
        "Cache-Control": "public, max-age=600",
        "X-PalmerLou-Cache": "HIT"
      });
      res.end(cached.body);
      return;
    }

    try {
      const remoteUrls = buildOceanTileUrls(source, z, x, y, date);
      let body: Buffer | null = null;
      let contentType = "image/png";

      for (const remoteUrl of remoteUrls) {
        try {
          const response = await fetch(remoteUrl, {
            headers: {
              "User-Agent": "Palmer-Lou-OS/1.0 (+ocean-overlay-proxy)"
            },
            signal: AbortSignal.timeout(12000)
          });

          if (!response.ok) {
            continue;
          }

          const candidateContentType = response.headers.get("content-type") ?? "image/png";
          if (!candidateContentType.toLowerCase().startsWith("image/")) {
            continue;
          }

          body = Buffer.from(await response.arrayBuffer());
          contentType = candidateContentType;
          break;
        } catch {
          continue;
        }
      }

      if (!body) {
        body = TRANSPARENT_PNG_BUFFER;
        contentType = "image/png";
      }

      oceanTileCache.set(cacheKey, {
        expiresAt: now + OCEAN_TILE_CACHE_TTL_MS,
        contentType,
        body
      });
      pruneOceanTileCache();

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=600",
        "X-PalmerLou-Cache": "MISS"
      });
      res.end(body);
      return;
    } catch {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Ocean overlay source unavailable");
      return;
    }
  }

  if (pathname === "/api/apps") {
    json(res, 200, dashboardSummary.apps);
    return;
  }

  if (pathname === "/api/trips") {
    try {
      const result = await loadCruiseReportTrips();
      json(res, 200, result.trips);
      return;
    } catch {
      json(res, 200, dashboardSummary.trips);
    }
    return;
  }

  if (pathname === "/api/integrations/signalk") {
    try {
      json(res, 200, await getSignalKIntegrationStatus());
      return;
    } catch {
      json(res, 200, {
        signalKBaseUrl: process.env.PALMER_LOU_SIGNALK_BASE_URL ?? "http://127.0.0.1:3000",
        installedPlugins: [],
        cruiseReport: { candidates: ["signalk-cruisereport", "signalk-cruise-report"], active: null },
        windy: { candidates: ["signalk-windy-plugin", "windy-plugin"], active: null }
      });
      return;
    }
    return;
  }

  if (pathname === "/api/camera/status") {
    json(res, 200, getCameraRuntimeStatus());
    return;
  }

  if (pathname === "/api/bluetooth") {
    json(res, 200, await getBluetoothState());
    return;
  }

  if (pathname === "/api/launcher") {
    json(res, 200, await getLauncherState());
    return;
  }

  if (pathname === "/api/remote/app-url") {
    json(res, 200, { url: (process.env.PALMER_LOU_REMOTE_APP_URL ?? "").trim() });
    return;
  }

  if (pathname === "/brand/logo.png") {
    if (existsSync(brandArtwork)) {
      sendFile(brandArtwork, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Brand artwork not found");
    return;
  }

  if (pathname === "/brand/remote-qr.svg") {
    const remoteAppUrl = (process.env.PALMER_LOU_REMOTE_APP_URL ?? "").trim();
    if (remoteAppUrl) {
      try {
        const { default: QRCode } = await import("qrcode");
        const svg = await (QRCode as any).toString(remoteAppUrl, { type: "svg", margin: 2 });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
        res.end(svg);
        return;
      } catch {
        // fall through to static file
      }
    }
  }

  if (pathname === "/favicon.ico") {
    const faviconSvg = path.resolve(uiDist, "favicon.svg");
    if (existsSync(faviconSvg)) {
      sendFile(faviconSvg, res);
      return;
    }
  }

  if (pathname === "/") {
    if (await serveUi("/", res)) {
      return;
    }
  }

  if (pathname.startsWith("/assets/") || pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".svg") || pathname.endsWith(".png") || pathname.endsWith(".ico")) {
    if (await serveUi(pathname, res)) {
      return;
    }
  }

  const accept = req.headers.accept ?? "";
  if (accept.includes("text/html")) {
    if (await serveUi(pathname, res)) {
      return;
    }
  }

  json(res, 404, { error: "Not found", path: pathname });
});

async function startServer() {
  if (requireBluetoothReady) {
    const bluetoothState = await getBluetoothState();
    const diagnostics = await runBluetoothDiagnostics();

    if (!bluetoothState.ready || !diagnostics.ready) {
      const missing = bluetoothState.config.missingCommands.join(", ");
      console.error("Bluetooth readiness check failed. Set PALMER_LOU_REQUIRE_BLUETOOTH_READY=false to bypass for development.");
      console.error(`Missing or unresolved Bluetooth configuration: ${missing || "none"}`);

      diagnostics.checks
        .filter((check) => !check.ok)
        .forEach((check) => {
          console.error(`- ${check.id}: ${check.detail}`);
        });

      process.exit(1);
    }
  }

  server.listen(port, "0.0.0.0", () => {
    console.log(`Palmer Lou backend running on http://127.0.0.1:${port}`);

    // Auto-reconnect to the saved Bluetooth stereo 8 s after startup
    const savedMac = process.env.PALMER_LOU_BT_DEVICE_MAC?.trim();
    if (process.platform === "linux" && savedMac) {
      setTimeout(() => {
        applyBluetoothAction("reconnect").catch(() => {});
      }, 8000);

      // Keep trying in the background so the stereo link self-recovers.
      setInterval(() => {
        getBluetoothState()
          .then((state) => {
            if (!state.connected) {
              return applyBluetoothAction("reconnect")
                .then(() => applyBluetoothAction("route-audio"))
                .catch(() => undefined);
            }

            if (state.connected && state.audioRoute !== "Stereo route active") {
              return applyBluetoothAction("route-audio").catch(() => undefined);
            }

            return undefined;
          })
          .catch(() => undefined);
      }, 45000);
    }
  });
}

startServer().catch((error) => {
  console.error("Failed to start backend server", error);
  process.exit(1);
});
