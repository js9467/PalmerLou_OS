export type TripBreadcrumb = {
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

export type TripLog = {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  tag: string;
  source: string;
  breadcrumbs: TripBreadcrumb[];
  distanceNm: number;
  maxSpeedKnots: number;
  averageSpeedKnots: number;
  averageDepthFeet: number;
  averageWaterTempF: number;
  maxRpmTotal: number;
  averageRpmTotal: number;
  maxEngineTempF: number;
  averageEngineTempF: number;
  averageFuelBurnGph: number;
};

function haversineNm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusNm = 3440.065;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * earthRadiusNm * Math.asin(Math.sqrt(h));
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeTripTitle() {
  const stamp = new Date().toISOString().slice(0, 10);
  return `Trip ${stamp}`;
}

export function startTripLog(input: {
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
}): TripLog {
  const now = new Date().toISOString();
  const breadcrumb: TripBreadcrumb = {
    time: now,
    latitude: input.latitude,
    longitude: input.longitude,
    speedKnots: input.speedKnots,
    headingDegrees: input.headingDegrees,
    depthFeet: input.depthFeet,
    waterTempF: input.waterTempF,
    engineRpmTotal: input.engineRpmTotal,
    engineTempAvgF: input.engineTempAvgF,
    engineTempMaxF: input.engineTempMaxF,
    fuelBurnGph: input.fuelBurnGph,
    engineVoltageAvg: input.engineVoltageAvg,
    portRpm: input.portRpm,
    centerRpm: input.centerRpm,
    starboardRpm: input.starboardRpm,
    wind: input.wind,
    barometer: input.barometer,
    networkStatus: input.networkStatus,
    source: input.source
  };

  return {
    id: `trip-${now}`,
    title: makeTripTitle(),
    startedAt: now,
    endedAt: null,
    tag: "Trip live",
    source: input.source,
    breadcrumbs: [breadcrumb],
    distanceNm: 0,
    maxSpeedKnots: input.speedKnots ?? 0,
    averageSpeedKnots: input.speedKnots ?? 0,
    averageDepthFeet: input.depthFeet ?? 0,
    averageWaterTempF: input.waterTempF ?? 0,
    maxRpmTotal: input.engineRpmTotal ?? 0,
    averageRpmTotal: input.engineRpmTotal ?? 0,
    maxEngineTempF: input.engineTempMaxF ?? 0,
    averageEngineTempF: input.engineTempAvgF ?? 0,
    averageFuelBurnGph: input.fuelBurnGph ?? 0
  } satisfies TripLog;
}

export function appendTripBreadcrumb(
  trip: TripLog,
  input: {
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
  }
): TripLog {
  const previous = trip.breadcrumbs.at(-1);
  const nextBreadcrumb: TripBreadcrumb = {
    time: new Date().toISOString(),
    latitude: input.latitude,
    longitude: input.longitude,
    speedKnots: input.speedKnots,
    headingDegrees: input.headingDegrees,
    depthFeet: input.depthFeet,
    waterTempF: input.waterTempF,
    engineRpmTotal: input.engineRpmTotal,
    engineTempAvgF: input.engineTempAvgF,
    engineTempMaxF: input.engineTempMaxF,
    fuelBurnGph: input.fuelBurnGph,
    engineVoltageAvg: input.engineVoltageAvg,
    portRpm: input.portRpm,
    centerRpm: input.centerRpm,
    starboardRpm: input.starboardRpm,
    wind: input.wind,
    barometer: input.barometer,
    networkStatus: input.networkStatus,
    source: input.source
  };

  const breadcrumbs = [...trip.breadcrumbs, nextBreadcrumb];
  const distanceNm = previous
    ? breadcrumbs.reduce((total, point, index) => {
        if (index === 0) {
          return total;
        }

        const prev = breadcrumbs[index - 1];
        if (!prev) {
          return total;
        }

        return total + haversineNm(prev.latitude, prev.longitude, point.latitude, point.longitude);
      }, 0)
    : 0;

  const speedValues = breadcrumbs
    .map((point) => point.speedKnots)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const depthValues = breadcrumbs
    .map((point) => point.depthFeet)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const tempValues = breadcrumbs
    .map((point) => point.waterTempF)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const rpmValues = breadcrumbs
    .map((point) => point.engineRpmTotal)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const engineTempValues = breadcrumbs
    .map((point) => point.engineTempAvgF)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const engineTempMaxValues = breadcrumbs
    .map((point) => point.engineTempMaxF)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const fuelBurnValues = breadcrumbs
    .map((point) => point.fuelBurnGph)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    ...trip,
    breadcrumbs,
    distanceNm: Number(distanceNm.toFixed(2)),
    maxSpeedKnots: speedValues.length > 0 ? Math.max(...speedValues) : 0,
    averageSpeedKnots: Number(average(speedValues).toFixed(2)),
    averageDepthFeet: Number(average(depthValues).toFixed(2)),
    averageWaterTempF: Number(average(tempValues).toFixed(2)),
    maxRpmTotal: rpmValues.length > 0 ? Math.max(...rpmValues) : 0,
    averageRpmTotal: Number(average(rpmValues).toFixed(2)),
    maxEngineTempF: engineTempMaxValues.length > 0 ? Math.max(...engineTempMaxValues) : 0,
    averageEngineTempF: Number(average(engineTempValues).toFixed(2)),
    averageFuelBurnGph: Number(average(fuelBurnValues).toFixed(2)),
    source: input.source,
    tag: "Trip live"
  };
}

export function shouldEndTripAtHome(homeLatitude: number, homeLongitude: number, nextLatitude: number, nextLongitude: number, radiusNm = 0.15) {
  return haversineNm(homeLatitude, homeLongitude, nextLatitude, nextLongitude) <= radiusNm;
}

export function finalizeTripLog(trip: TripLog): TripLog {
  return {
    ...trip,
    endedAt: new Date().toISOString(),
    tag: "Trip complete"
  };
}

export function summarizeTripLog(trip: TripLog) {
  return `${trip.title}: ${trip.distanceNm.toFixed(2)} NM, ${trip.maxSpeedKnots.toFixed(1)} kt max, ${trip.averageDepthFeet.toFixed(1)} ft avg depth, ${trip.averageRpmTotal.toFixed(0)} avg RPM`;
}

type StoredTripDescriptor = {
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
};

function asFiniteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStoredTrip(item: unknown): StoredTripDescriptor | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const candidate = item as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.title !== "string") {
    return null;
  }

  const breadcrumbs = Array.isArray(candidate.breadcrumbs) ? candidate.breadcrumbs as TripBreadcrumb[] : [];

  return {
    id: candidate.id,
    title: candidate.title,
    detail: typeof candidate.detail === "string" ? candidate.detail : `${candidate.title}`,
    tag: typeof candidate.tag === "string" ? candidate.tag : "Trip complete",
    distanceNm: asFiniteNumber(candidate.distanceNm),
    startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : new Date().toISOString(),
    endedAt: typeof candidate.endedAt === "string" || candidate.endedAt === null ? candidate.endedAt : null,
    maxSpeedKnots: asFiniteNumber(candidate.maxSpeedKnots),
    averageSpeedKnots: asFiniteNumber(candidate.averageSpeedKnots),
    averageDepthFeet: asFiniteNumber(candidate.averageDepthFeet),
    averageWaterTempF: asFiniteNumber(candidate.averageWaterTempF),
    maxRpmTotal: asFiniteNumber(candidate.maxRpmTotal),
    averageRpmTotal: asFiniteNumber(candidate.averageRpmTotal),
    maxEngineTempF: asFiniteNumber(candidate.maxEngineTempF),
    averageEngineTempF: asFiniteNumber(candidate.averageEngineTempF),
    averageFuelBurnGph: asFiniteNumber(candidate.averageFuelBurnGph),
    breadcrumbs
  };
}

export function readStoredTrips() {
  if (typeof window === "undefined") {
    return [] as StoredTripDescriptor[];
  }

  try {
    const stored = window.localStorage.getItem("palmer-lou-trip-log");
    if (!stored) {
      return [] as StoredTripDescriptor[];
    }

    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) {
      return [] as StoredTripDescriptor[];
    }

    return parsed.map(normalizeStoredTrip).filter((item): item is StoredTripDescriptor => item !== null);
  } catch {
    return [] as StoredTripDescriptor[];
  }
}

export function writeStoredTrips(trips: StoredTripDescriptor[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem("palmer-lou-trip-log", JSON.stringify(trips.slice(0, 24)));
}
