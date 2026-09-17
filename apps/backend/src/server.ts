import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyBluetoothAction, getBluetoothState, runBluetoothDiagnostics, scanBluetoothDevices, configureBluetoothDevice, type BluetoothAction } from "./bluetooth.js";
import { dashboardSummary } from "./mock-data.js";
import { getNmeaTelemetry } from "./nmea.js";
import { getLauncherState, killLaunchedApp, launchApp, returnToHome } from "./launcher.js";
import { getRemoteAccessStatus, getRemoteUpdateStatus, runRemoteControlAction, runRemoteUpdate, runTunnelAction, type RemoteAccessStatus, type RemoteControlAction } from "./remote.js";
import { resolveUpdateStatus } from "./update.js";
import { disconnectWifiNetwork, joinWifiNetwork, scanWifiNetworks } from "./wifi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const uiDist = path.resolve(repoRoot, "apps/ui/dist");
const brandArtwork = path.resolve(repoRoot, "images/Palmer Lou Artwork.png");
const port = Number(process.env.PORT ?? 8787);
const requireBluetoothReady = (process.env.PALMER_LOU_REQUIRE_BLUETOOTH_READY ?? "false").toLowerCase() === "true";
const currentVersion = dashboardSummary.version.currentVersion;
const currentChannel = dashboardSummary.version.channel;
const oceanTileCache = new Map<string, { expiresAt: number; contentType: string; body: Buffer }>();
const OCEAN_TILE_CACHE_TTL_MS = 1000 * 60 * 15;
const OCEAN_TILE_CACHE_LIMIT = 1200;
const TRANSPARENT_PNG_BUFFER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgBqWcN0AAAAASUVORK5CYII=", "base64");

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
    color: "#ff5b8a",
    depthBand: "140–600 ft contour edge",
    currentSignal: "Fast current lane and bait stacking"
  },
  {
    name: "Mahi Mahi",
    tempMin: 74, tempMax: 86, optimalTemp: 80,
    sstWeight: 0.9, convWeight: 1.1,
    color: "#6ad8a2",
    depthBand: "Surface to 200 ft over structure",
    currentSignal: "Surface slick with debris and convergence"
  },
  {
    name: "Tuna",
    tempMin: 70, tempMax: 80, optimalTemp: 75,
    sstWeight: 1.05, convWeight: 0.95,
    color: "#00c0c0",
    depthBand: "120–600 ft temp break",
    currentSignal: "Cross-current seam with stable break"
  },
  {
    name: "Billfish",
    tempMin: 74, tempMax: 84, optimalTemp: 79,
    sstWeight: 0.85, convWeight: 1.15,
    color: "#b58dff",
    depthBand: "200–1000+ ft canyon edge",
    currentSignal: "Warm current push with pronounced seam"
  },
  {
    name: "Swordfish",
    tempMin: 65, tempMax: 78, optimalTemp: 71,
    sstWeight: 0.8, convWeight: 1.2,
    color: "#f0c96b",
    depthBand: "300–1200 ft outside edge",
    currentSignal: "Offshore break and eddy shoulder"
  },
  {
    name: "Kingfish",
    tempMin: 68, tempMax: 82, optimalTemp: 75,
    sstWeight: 1.15, convWeight: 0.85,
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
    .filter((b) => b.waterTempC !== null && !isLikelyLand({ latitude: b.latitude, longitude: b.longitude }));

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

      const frontFit = Math.min(1, bestFrontEntry?.weightedScore ?? 0);
      const frontGradient = bestFrontEntry?.front.gradientFPer10Nm ?? 0;

      const ownWind = b.windSpeedMps ?? 0;
      const nearbyWindValues = marineBuoys
        .filter((nb) => nb !== b && nb.windSpeedMps !== null && distanceNm(b.latitude, b.longitude, nb.latitude, nb.longitude) < 55)
        .map((nb) => nb.windSpeedMps as number);
      const windSpread = nearbyWindValues.length > 0
        ? nearbyWindValues.reduce((s, w) => s + Math.abs(w - ownWind), 0) / nearbyWindValues.length
        : 0;
      const convergenceFit = Math.min(1, windSpread / 3.8) * sp.convWeight;

      const buoyAgeMin = (now - new Date(b.observedAt).getTime()) / 60000;
      const dataAgeFit = Math.max(0.08, 1 - buoyAgeMin / (60 * 16));

      const raw = (sstFit * 0.42) + (frontFit * 0.3) + (convergenceFit * 0.17) + (dataAgeFit * 0.11);

      return {
        buoy: b,
        tempF,
        sstFit,
        frontFit,
        frontGradient,
        bestFront: bestFrontEntry?.front ?? null,
        convergenceFit,
        dataAgeFit,
        recentStrength,
        raw
      };
    }).sort((a, b) => b.raw - a.raw).slice(0, 10);

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
        const proximityPenalty = nearestChosenNm < 18 ? (18 - nearestChosenNm) / 75 : 0;
        const effectiveRaw = candidate.raw - stationPenalty - proximityPenalty;
        return { candidate, effectiveRaw };
      })
      .sort((a, b) => b.effectiveRaw - a.effectiveRaw)[0];

    if (!best || best.effectiveRaw < 0.2) {
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
    const center = pushPointOffshore({ latitude: pick.candidate.buoy.latitude, longitude: pick.candidate.buoy.longitude }, marineBuoys);
    const normalized = (pick.effectiveRaw - minRaw) / spread;
    const historyBonus = Math.min(0.14, pick.recentStrength / 24);
    const score = Math.max(22, Math.min(97, Math.round(30 + ((normalized + historyBonus) * 64))));
    const confidence: "high" | "medium" | "low" = score >= 74 ? "high" : score >= 53 ? "medium" : "low";
    const recommended = score >= 56;

    const frontStrength4 = pick.candidate.bestFront
      ? Math.min(4, Math.max(1, Math.round(pick.candidate.frontGradient * 2.1)))
      : 0;

    const convergenceLabel = pick.candidate.convergenceFit > 0.58 ? "Strong" : pick.candidate.convergenceFit > 0.34 ? "Moderate" : "Light";
    const buoyAgeMin = (now - new Date(pick.candidate.buoy.observedAt).getTime()) / 60000;
    const ageLabel = buoyAgeMin < 60 ? `${Math.round(buoyAgeMin)} min` : `${(buoyAgeMin / 60).toFixed(1)} h`;
    const radiusNm = recommended
      ? Math.max(4, Math.min(6, 2 + score / 18))
      : 2.5;

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
        `Convergence: ${convergenceLabel.toLowerCase()}`
      ]
    } as SpeciesIntelEntry;
  }).sort((a, b) => b.score - a.score);

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

function pushPointOffshore(point: GeoPoint, buoys: OceanBuoyObservation[]) {
  if (!isLikelyLand(point)) {
    return point;
  }

  // Use only buoys that are themselves verified offshore
  const offshoreAnchor = buoys
    .filter((b) => !isLikelyLand({ latitude: b.latitude, longitude: b.longitude }))
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
      if (pairDistanceNm < 5 || pairDistanceNm > 180) {
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

      if (isLikelyLand(midpoint)) {
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

  const ranked = pairSignals.sort((a, b) => b.score - a.score).slice(0, 8);
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
  });
  const oceanSignals = buildBuoySignalFronts({
    buoys: marineBuoys,
    species: normalizedSpecies,
    temperatureRangeF: tempRange
  });

  const catches = payload.catches.filter((catchItem) => {
    return catchItem.latitude !== null
      && catchItem.longitude !== null
      && catchItem.species.toLowerCase().includes(normalizedSpecies.toLowerCase());
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
    const offshoreCenter = pushPointOffshore({ latitude, longitude }, marineBuoys);
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

    const score = Math.min(99, Math.round((group.length * 16) + (recency * 36) + (tempFit * 30) + (frontFit * 26)));
    const confidence: "high" | "medium" | "low" = score >= 72 ? "high" : score >= 52 ? "medium" : "low";

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
      radiusNm: Math.min(14, 4 + (group.length * 1.6)),
      score,
      confidence,
      reasoning
    };
  }).sort((a, b) => b.score - a.score).slice(0, 4);

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
      const offshoreCenter = pushPointOffshore({ latitude: entry.buoy.latitude, longitude: entry.buoy.longitude }, marineBuoys);
      zones.push({
        id: `buoy-${entry.buoy.stationId}`,
        label: `${normalizedSpecies} temp window near ${entry.buoy.stationId}`,
        latitude: offshoreCenter.latitude,
        longitude: offshoreCenter.longitude,
        radiusNm: 6 + index,
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
  baseSummary.connectivity.nmea = nmea.status;

  if (nmea.telemetry) {
    const { speedKnots, headingDegrees, depthFeet, waterTempF } = nmea.telemetry;

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
    const device = process.env.PALMER_LOU_CAMERA_DEVICE ?? "/dev/video0";
    if (!existsSync(device)) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Camera device not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "close"
    });
    const ff = spawn("ffmpeg", [
      "-f", "v4l2",
      "-framerate", "30",
      "-i", device,
      "-vf", "scale=960:-2",
      "-f", "mpjpeg",
      "-q:v", "8",
      "-"
    ], { stdio: ["ignore", "pipe", "ignore"] });
    ff.stdout.pipe(res);
    const cleanup = () => { try { ff.kill(); } catch { /* already gone */ } };
    req.on("close", cleanup);
    req.on("error", cleanup);
    ff.on("error", cleanup);
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
      const repeatRaw = Number(payload?.repeat ?? 1);
      const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.min(8, Math.floor(repeatRaw))) : 1;

      const validActions: RemoteControlAction[] = ["up", "down", "left", "right", "select", "back", "home", "playpause", "volup", "voldown", "mute"];
      if (typeof action !== "string" || !validActions.includes(action as RemoteControlAction)) {
        json(res, 400, { error: "Invalid remote control action" });
        return;
      }

      json(res, 200, await runRemoteControlAction(action as RemoteControlAction, repeat));
      return;
    } catch (error) {
      json(res, 500, {
        error: "Failed to run remote control action",
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
      const requestedRadius = typeof payload?.maxRadiusNm === "number" ? payload.maxRadiusNm : 220;
      const context = referenceLatitude !== null && referenceLongitude !== null
        ? {
            referenceLatitude,
            referenceLongitude,
            maxRadiusNm: Math.max(40, Math.min(360, requestedRadius))
          }
        : null;

      const buoys = providedBuoys.length > 0 ? providedBuoys : await loadBuoyObservations();

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
      const requestedRadius = typeof payload?.maxRadiusNm === "number" ? payload.maxRadiusNm : 260;
      const context = referenceLatitude !== null && referenceLongitude !== null
        ? { referenceLatitude, referenceLongitude, maxRadiusNm: Math.max(40, Math.min(400, requestedRadius)) }
        : null;
      const buoys = providedBuoys.length > 0 ? providedBuoys : await loadBuoyObservations();

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
    res.writeHead(405, { Allow: "GET" });
    res.end("Method not allowed");
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
    json(res, 200, dashboardSummary.trips);
    return;
  }

  if (pathname === "/api/camera/status") {
    json(res, 200, dashboardSummary.camera);
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

  if (pathname === "/brand/logo.png") {
    if (existsSync(brandArtwork)) {
      sendFile(brandArtwork, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Brand artwork not found");
    return;
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
