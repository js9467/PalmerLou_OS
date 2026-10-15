type TripBreadcrumb = {
  time: string;
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  headingDegrees: number | null;
  depthFeet: number | null;
  waterTempF: number | null;
  engineRpmTotal: number | null;
  engineTempAvgF: number | null;
  engineTempMaxF: number | null;
  fuelBurnGph: number | null;
  engineVoltageAvg: number | null;
  portRpm: number | null;
  centerRpm: number | null;
  starboardRpm: number | null;
  wind: string;
  barometer: string;
  networkStatus: string;
  source: string;
};

type TripDescriptor = {
  id: string;
  title: string;
  detail: string;
  tag: string;
  distanceNm: number;
  startedAt: string;
  endedAt: string | null;
  maxSpeedKnots: number;
  averageSpeedKnots: number;
  averageDepthFeet: number;
  averageWaterTempF: number;
  maxRpmTotal: number;
  averageRpmTotal: number;
  maxEngineTempF: number;
  averageEngineTempF: number;
  averageFuelBurnGph: number;
  breadcrumbs: TripBreadcrumb[];
  origin: "cruisereport";
};

type PluginDescriptor = {
  id: string;
  name: string;
  packageName: string;
  version: string;
};

export type WindyForecastCard = {
  label: string;
  windKnots: number;
  waveFeet: number;
  outlook: string;
  observedAt: string | null;
};

const SIGNALK_BASE_URL = (process.env.PALMER_LOU_SIGNALK_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SIGNALK_TIMEOUT_MS = Number.parseInt(process.env.PALMER_LOU_SIGNALK_TIMEOUT_MS ?? "4200", 10);

let pluginCache: { expiresAt: number; plugins: PluginDescriptor[] } | null = null;

async function fetchJson(pathname: string, timeoutMs = SIGNALK_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1200, timeoutMs));

  try {
    const response = await fetch(`${SIGNALK_BASE_URL}${pathname}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Palmer-Lou-OS/1.0 (+signalk-integrations)"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Signal K ${pathname} responded ${response.status}`);
    }

    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractByPath(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;

  for (const key of path) {
    const asObj = asObject(current);
    if (!asObj) {
      return undefined;
    }

    current = asObj[key];
  }

  return current;
}

async function getInstalledPlugins(): Promise<PluginDescriptor[]> {
  const now = Date.now();
  if (pluginCache && pluginCache.expiresAt > now) {
    return pluginCache.plugins;
  }

  try {
    const payload = await fetchJson("/plugins/");
    const list = Array.isArray(payload) ? payload : [];
    const plugins = list
      .map((entry) => asObject(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({
        id: asString(entry.id) ?? "",
        name: asString(entry.name) ?? "",
        packageName: asString(entry.packageName) ?? "",
        version: asString(entry.version) ?? ""
      }))
      .filter((entry) => entry.id.length > 0);

    pluginCache = {
      expiresAt: now + 60_000,
      plugins
    };

    return plugins;
  } catch {
    return pluginCache?.plugins ?? [];
  }
}

function findPluginIds(plugins: PluginDescriptor[], keywords: string[], defaults: string[]): string[] {
  const matches = plugins
    .filter((plugin) => {
      const haystack = `${plugin.id} ${plugin.name} ${plugin.packageName}`.toLowerCase();
      return keywords.every((keyword) => haystack.includes(keyword));
    })
    .map((plugin) => plugin.id);

  const merged = [...matches, ...defaults];
  return [...new Set(merged.filter((id) => id.length > 0))];
}

function pickDate(value: unknown): string | null {
  const stringValue = asString(value);
  if (!stringValue) {
    return null;
  }

  const parsed = Date.parse(stringValue);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function normalizeTripPoint(raw: unknown, sourceLabel: string): TripBreadcrumb | null {
  const point = asObject(raw);
  if (!point) {
    return null;
  }

  const latitude = asNumber(point.latitude) ?? asNumber(point.lat) ?? asNumber(extractByPath(point, ["position", "latitude"]));
  const longitude = asNumber(point.longitude) ?? asNumber(point.lon) ?? asNumber(point.lng) ?? asNumber(extractByPath(point, ["position", "longitude"]));

  if (latitude === null || longitude === null) {
    return null;
  }

  const timestamp = pickDate(point.time) ?? pickDate(point.timestamp) ?? pickDate(point.observedAt) ?? new Date().toISOString();
  const speedKnots = asNumber(point.speedKnots) ?? asNumber(point.sog) ?? asNumber(point.speed);
  const headingDegrees = asNumber(point.headingDegrees) ?? asNumber(point.heading) ?? asNumber(point.cog);

  return {
    time: timestamp,
    latitude,
    longitude,
    speedKnots,
    headingDegrees,
    depthFeet: asNumber(point.depthFeet),
    waterTempF: asNumber(point.waterTempF),
    engineRpmTotal: asNumber(point.engineRpmTotal) ?? asNumber(point.rpmTotal),
    engineTempAvgF: asNumber(point.engineTempAvgF),
    engineTempMaxF: asNumber(point.engineTempMaxF),
    fuelBurnGph: asNumber(point.fuelBurnGph),
    engineVoltageAvg: asNumber(point.engineVoltageAvg),
    portRpm: asNumber(point.portRpm),
    centerRpm: asNumber(point.centerRpm),
    starboardRpm: asNumber(point.starboardRpm),
    wind: asString(point.wind) ?? "Unknown",
    barometer: asString(point.barometer) ?? "Unknown",
    networkStatus: asString(point.networkStatus) ?? "Signal K",
    source: sourceLabel
  };
}

function extractTripPoints(candidate: Record<string, unknown>, sourceLabel: string): TripBreadcrumb[] {
  const arraysToTry: unknown[] = [
    candidate.breadcrumbs,
    candidate.track,
    candidate.points,
    candidate.positions,
    candidate.log,
    extractByPath(candidate, ["data", "track"]),
    extractByPath(candidate, ["data", "positions"])
  ];

  for (const value of arraysToTry) {
    if (!Array.isArray(value)) {
      continue;
    }

    const points = value
      .map((entry) => normalizeTripPoint(entry, sourceLabel))
      .filter((entry): entry is TripBreadcrumb => entry !== null);

    if (points.length > 0) {
      return points;
    }
  }

  return [];
}

function toTripDescriptor(candidate: Record<string, unknown>, index: number, sourceLabel: string): TripDescriptor | null {
  const points = extractTripPoints(candidate, sourceLabel);
  const startedAt = pickDate(candidate.startedAt)
    ?? pickDate(candidate.startTime)
    ?? pickDate(candidate.start)
    ?? points[0]?.time
    ?? null;

  if (!startedAt) {
    return null;
  }

  const endedAt = pickDate(candidate.endedAt)
    ?? pickDate(candidate.endTime)
    ?? pickDate(candidate.end)
    ?? points.at(-1)?.time
    ?? null;

  const distanceNm = asNumber(candidate.distanceNm)
    ?? asNumber(candidate.distance)
    ?? asNumber(candidate.totalDistanceNm)
    ?? 0;

  const title = asString(candidate.title)
    ?? asString(candidate.name)
    ?? `Cruise ${new Date(startedAt).toLocaleString()}`;

  const id = asString(candidate.id)
    ?? asString(candidate.uuid)
    ?? `${sourceLabel.toLowerCase().replace(/\s+/g, "-")}-${index}-${Date.parse(startedAt)}`;

  const maxSpeedKnots = asNumber(candidate.maxSpeedKnots) ?? 0;
  const averageSpeedKnots = asNumber(candidate.averageSpeedKnots) ?? 0;

  return {
    id,
    title,
    detail: `${distanceNm.toFixed(2)} NM from ${new Date(startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    tag: asString(candidate.tag) ?? "Cruise report",
    distanceNm,
    startedAt,
    endedAt,
    maxSpeedKnots,
    averageSpeedKnots,
    averageDepthFeet: asNumber(candidate.averageDepthFeet) ?? 0,
    averageWaterTempF: asNumber(candidate.averageWaterTempF) ?? 0,
    maxRpmTotal: asNumber(candidate.maxRpmTotal) ?? 0,
    averageRpmTotal: asNumber(candidate.averageRpmTotal) ?? 0,
    maxEngineTempF: asNumber(candidate.maxEngineTempF) ?? 0,
    averageEngineTempF: asNumber(candidate.averageEngineTempF) ?? 0,
    averageFuelBurnGph: asNumber(candidate.averageFuelBurnGph) ?? 0,
    breadcrumbs: points,
    origin: "cruisereport"
  };
}

function parseTripsPayload(payload: unknown, sourceLabel: string): TripDescriptor[] {
  const collections: unknown[] = [];

  if (Array.isArray(payload)) {
    collections.push(payload);
  }

  const objectPayload = asObject(payload);
  if (objectPayload) {
    collections.push(
      objectPayload.trips,
      objectPayload.voyages,
      objectPayload.reports,
      objectPayload.logs,
      objectPayload.items,
      extractByPath(objectPayload, ["data", "trips"]),
      extractByPath(objectPayload, ["data", "voyages"])
    );
  }

  for (const collection of collections) {
    if (!Array.isArray(collection)) {
      continue;
    }

    const normalized = collection
      .map((entry) => asObject(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry, index) => toTripDescriptor(entry, index, sourceLabel))
      .filter((entry): entry is TripDescriptor => entry !== null)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

async function fetchPluginPayload(pluginId: string, pathSuffix: string): Promise<unknown> {
  const safeSuffix = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
  return await fetchJson(`/plugins/${pluginId}${safeSuffix}`);
}

export async function loadCruiseReportTrips(): Promise<{ trips: TripDescriptor[]; source: string; available: boolean }> {
  const plugins = await getInstalledPlugins();
  const pluginIds = findPluginIds(plugins, ["cruise", "report"], ["signalk-cruisereport", "signalk-cruise-report"]);

  const candidatePaths = [
    "/api/trips",
    "/trips",
    "/api/voyages",
    "/voyages",
    "/api/logs",
    "/logs",
    ""
  ];

  for (const pluginId of pluginIds) {
    for (const candidatePath of candidatePaths) {
      try {
        const payload = await fetchPluginPayload(pluginId, candidatePath);
        const sourceLabel = `Signal K ${pluginId}`;
        const trips = parseTripsPayload(payload, sourceLabel);
        if (trips.length > 0) {
          return {
            trips,
            source: sourceLabel,
            available: true
          };
        }
      } catch {
        continue;
      }
    }
  }

  const available = pluginIds.some((id) => plugins.some((plugin) => plugin.id === id));
  return {
    trips: [],
    source: available ? "Signal K Cruise Report" : "Signal K Cruise Report (not active)",
    available
  };
}

function pullNumericFromCandidate(candidate: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(candidate[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function normalizeWindKnots(value: number, fieldName: string): number {
  const key = fieldName.toLowerCase();
  if (key.includes("mps") || key.includes("m/s") || key.includes("ms")) {
    return value * 1.94384;
  }

  if (key.includes("kmh") || key.includes("kph")) {
    return value * 0.539957;
  }

  return value;
}

function normalizeWaveFeet(value: number, fieldName: string): number {
  const key = fieldName.toLowerCase();
  if (key.includes("meter") || key.endsWith("m") || key.includes("waveheightm")) {
    return value * 3.28084;
  }

  return value;
}

function summarizeOutlook(windKnots: number, waveFeet: number): string {
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

function parseWindyForecast(payload: unknown): WindyForecastCard[] {
  const pools: unknown[] = [];
  if (Array.isArray(payload)) {
    pools.push(payload);
  }

  const objectPayload = asObject(payload);
  if (objectPayload) {
    pools.push(
      objectPayload.forecast,
      objectPayload.forecasts,
      objectPayload.hourly,
      objectPayload.hours,
      objectPayload.timeline,
      extractByPath(objectPayload, ["data", "forecast"]),
      extractByPath(objectPayload, ["data", "hourly"]),
      extractByPath(objectPayload, ["model", "forecast"])
    );
  }

  let entries: Array<{ observedAt: string; windKnots: number; waveFeet: number }> = [];

  for (const pool of pools) {
    if (!Array.isArray(pool)) {
      continue;
    }

    const candidateEntries = pool
      .map((entry) => asObject(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => {
        const observedAt = pickDate(entry.time) ?? pickDate(entry.timestamp) ?? pickDate(entry.date) ?? pickDate(entry.datetime);
        if (!observedAt) {
          return null;
        }

        const windFieldCandidates = [
          ["windKnots", "windKnots"],
          ["windKts", "windKts"],
          ["wind", "wind"],
          ["windSpeed", "windSpeed"],
          ["windSpeedKmh", "windSpeedKmh"],
          ["windSpeedMps", "windSpeedMps"],
          ["windMps", "windMps"]
        ] as const;

        let windKnots: number | null = null;
        for (const [fieldName, sourceName] of windFieldCandidates) {
          const value = asNumber(entry[fieldName]);
          if (value !== null) {
            windKnots = normalizeWindKnots(value, sourceName);
            break;
          }
        }

        const nestedWind = asObject(entry.wind);
        if (windKnots === null && nestedWind) {
          const nestedValue = pullNumericFromCandidate(nestedWind, ["speedKnots", "speed", "kts", "kmh", "mps"]);
          if (nestedValue !== null) {
            windKnots = normalizeWindKnots(nestedValue, Object.keys(nestedWind).join("-"));
          }
        }

        const waveFieldCandidates = [
          ["waveFeet", "waveFeet"],
          ["waveFt", "waveFt"],
          ["waveHeightFeet", "waveHeightFeet"],
          ["waveHeightM", "waveHeightM"],
          ["waveHeight", "waveHeight"],
          ["waves", "waves"]
        ] as const;

        let waveFeet: number | null = null;
        for (const [fieldName, sourceName] of waveFieldCandidates) {
          const value = asNumber(entry[fieldName]);
          if (value !== null) {
            waveFeet = normalizeWaveFeet(value, sourceName);
            break;
          }
        }

        const nestedWave = asObject(entry.wave);
        if (waveFeet === null && nestedWave) {
          const nestedValue = pullNumericFromCandidate(nestedWave, ["heightFeet", "height", "meters", "m"]);
          if (nestedValue !== null) {
            waveFeet = normalizeWaveFeet(nestedValue, Object.keys(nestedWave).join("-"));
          }
        }

        if (windKnots === null && waveFeet === null) {
          return null;
        }

        return {
          observedAt,
          windKnots: Math.max(0, windKnots ?? 0),
          waveFeet: Math.max(0.5, waveFeet ?? 0.5)
        };
      })
      .filter((entry): entry is { observedAt: string; windKnots: number; waveFeet: number } => entry !== null)
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

    if (candidateEntries.length > 0) {
      entries = candidateEntries;
      break;
    }
  }

  if (entries.length === 0) {
    return [];
  }

  const now = Date.now();
  const nearestByOffset = (hours: number) => {
    const target = now + (hours * 60 * 60 * 1000);
    const sorted = [...entries].sort((a, b) => Math.abs(Date.parse(a.observedAt) - target) - Math.abs(Date.parse(b.observedAt) - target));
    return sorted[0] ?? entries[0];
  };

  const offsets = [
    { label: "Now", hours: 0 },
    { label: "+6h", hours: 6 },
    { label: "+12h", hours: 12 }
  ];
  const fallbackEntry = entries[0];

  if (!fallbackEntry) {
    return [];
  }

  return offsets.map((offset) => {
    const selected = nearestByOffset(offset.hours) ?? fallbackEntry;
    return {
      label: offset.label,
      windKnots: selected.windKnots,
      waveFeet: selected.waveFeet,
      observedAt: selected.observedAt,
      outlook: summarizeOutlook(selected.windKnots, selected.waveFeet)
    };
  });
}

export async function loadWindyForecast(): Promise<{ cards: WindyForecastCard[]; source: string; available: boolean }> {
  const plugins = await getInstalledPlugins();
  const pluginIds = findPluginIds(plugins, ["windy"], ["signalk-windy-plugin", "windy-plugin"]);

  const candidatePaths = [
    "/api/forecast",
    "/forecast",
    "/api/weather",
    "/weather",
    "/api",
    ""
  ];

  for (const pluginId of pluginIds) {
    for (const candidatePath of candidatePaths) {
      try {
        const payload = await fetchPluginPayload(pluginId, candidatePath);
        const cards = parseWindyForecast(payload);
        if (cards.length > 0) {
          return {
            cards,
            source: `Signal K ${pluginId}`,
            available: true
          };
        }
      } catch {
        continue;
      }
    }
  }

  const available = pluginIds.some((id) => plugins.some((plugin) => plugin.id === id));
  return {
    cards: [],
    source: available ? "Signal K Windy" : "Signal K Windy (not active)",
    available
  };
}

export async function getSignalKIntegrationStatus() {
  const plugins = await getInstalledPlugins();
  const cruiseCandidates = findPluginIds(plugins, ["cruise", "report"], ["signalk-cruisereport", "signalk-cruise-report"]);
  const windyCandidates = findPluginIds(plugins, ["windy"], ["signalk-windy-plugin", "windy-plugin"]);

  return {
    signalKBaseUrl: SIGNALK_BASE_URL,
    installedPlugins: plugins,
    cruiseReport: {
      candidates: cruiseCandidates,
      active: cruiseCandidates.find((id) => plugins.some((plugin) => plugin.id === id)) ?? null
    },
    windy: {
      candidates: windyCandidates,
      active: windyCandidates.find((id) => plugins.some((plugin) => plugin.id === id)) ?? null
    }
  };
}
