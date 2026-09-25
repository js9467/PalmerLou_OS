import { promisify } from "node:util";
import { exec } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

type NmeaTelemetry = {
  speedKnots: number | null;
  headingDegrees: number | null;
  depthFeet: number | null;
  waterTempF: number | null;
  latitude: number | null;
  longitude: number | null;
  source: string;
  updatedAt: string;
  sampledAtMs: number | null;
};

type NmeaResult = {
  telemetry: NmeaTelemetry | null;
  status: string;
};

type CacheRecord = {
  expiresAt: number;
  result: NmeaResult;
};

const execAsync = promisify(exec);

const NMEA_ENABLED = (process.env.PALMER_LOU_NMEA2000_ENABLED ?? "true").toLowerCase() === "true";
const SIGNALK_BASE_URL = process.env.PALMER_LOU_SIGNALK_BASE_URL ?? "http://127.0.0.1:3000";
const SIGNALK_TIMEOUT_MS = Number.parseInt(process.env.PALMER_LOU_SIGNALK_TIMEOUT_MS ?? "1800", 10);
const NMEA_CACHE_MS = Number.parseInt(process.env.PALMER_LOU_NMEA_CACHE_MS ?? "1500", 10);
const NMEA_STALE_MS = Number.parseInt(process.env.PALMER_LOU_NMEA_STALE_MS ?? "15000", 10);
const NMEA0183_ENABLED = (process.env.PALMER_LOU_NMEA0183_ENABLED ?? "true").toLowerCase() === "true";
const NMEA0183_DEVICE = process.env.PALMER_LOU_NMEA0183_DEVICE ?? "auto";
const NMEA0183_BAUD = Number.parseInt(process.env.PALMER_LOU_NMEA0183_BAUD ?? "38400", 10);
const NMEA0183_BAUDS = (process.env.PALMER_LOU_NMEA0183_BAUDS ?? `${NMEA0183_BAUD},115200,9600,4800`)
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value, index, source) => Number.isFinite(value) && value > 0 && source.indexOf(value) === index);
const NMEA0183_READ_SECONDS = Math.max(1, Number.parseInt(process.env.PALMER_LOU_NMEA0183_READ_SECONDS ?? "3", 10));

let cache: CacheRecord | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function pickNumber(source: unknown): number | null {
  if (typeof source === "number" && Number.isFinite(source)) {
    return source;
  }

  if (typeof source === "object" && source && "value" in source) {
    const wrapped = source as { value?: unknown };
    if (typeof wrapped.value === "number" && Number.isFinite(wrapped.value)) {
      return wrapped.value;
    }
  }

  return null;
}

function pickTimestampMs(source: unknown): number | null {
  if (!source || typeof source !== "object" || !("timestamp" in source)) {
    return null;
  }

  const wrapped = source as { timestamp?: unknown };
  if (typeof wrapped.timestamp !== "string") {
    return null;
  }

  const parsed = Date.parse(wrapped.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    const record = current as Record<string, unknown>;
    return record[segment];
  }, source);
}

function firstNumber(source: Record<string, unknown>, paths: string[]) {
  for (const path of paths) {
    const candidate = pickNumber(readPath(source, path));
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

function latestTimestampForPaths(source: Record<string, unknown>, paths: string[]) {
  let latest: number | null = null;

  paths.forEach((path) => {
    const candidate = pickTimestampMs(readPath(source, path));
    if (candidate === null) {
      return;
    }

    if (latest === null || candidate > latest) {
      latest = candidate;
    }
  });

  return latest;
}

function radiansToDegrees(value: number) {
  const degrees = (value * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

function mpsToKnots(value: number) {
  return value * 1.94384449;
}

function metersToFeet(value: number) {
  return value * 3.2808399;
}

function celsiusToFahrenheit(value: number) {
  return (value * 9) / 5 + 32;
}

function kelvinToFahrenheit(value: number) {
  return celsiusToFahrenheit(value - 273.15);
}

function normalizeNmeaSentence(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("$") || trimmed.length < 6) {
    return null;
  }

  const withoutChecksum = trimmed.split("*")[0] ?? "";
  const payload = withoutChecksum.slice(1);
  const fields = payload.split(",");
  if (fields.length === 0) {
    return null;
  }

  const type = (fields[0] ?? "").slice(-3).toUpperCase();
  if (!type) {
    return null;
  }

  return { type, fields };
}

function parseFloatSafe(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNmeaCoordinate(raw: string | undefined, hemisphere: string | undefined, isLatitude: boolean) {
  if (!raw || !hemisphere) {
    return null;
  }

  const normalizedHemisphere = hemisphere.trim().toUpperCase();
  const degreesDigits = isLatitude ? 2 : 3;
  if (raw.length <= degreesDigits) {
    return null;
  }

  const degreesPart = raw.slice(0, degreesDigits);
  const minutesPart = raw.slice(degreesDigits);
  const degrees = Number.parseFloat(degreesPart);
  const minutes = Number.parseFloat(minutesPart);
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) {
    return null;
  }

  const decimal = degrees + (minutes / 60);
  if (!Number.isFinite(decimal)) {
    return null;
  }

  const signed = (normalizedHemisphere === "S" || normalizedHemisphere === "W") ? -decimal : decimal;
  return Number.isFinite(signed) ? signed : null;
}

function pickPosition(source: Record<string, unknown>, paths: string[]) {
  for (const path of paths) {
    const candidate = readPath(source, path);
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const direct = candidate as { latitude?: unknown; longitude?: unknown; value?: unknown };
    const directLat = typeof direct.latitude === "number" && Number.isFinite(direct.latitude) ? direct.latitude : null;
    const directLng = typeof direct.longitude === "number" && Number.isFinite(direct.longitude) ? direct.longitude : null;
    if (directLat !== null && directLng !== null) {
      return { latitude: directLat, longitude: directLng };
    }

    if (direct.value && typeof direct.value === "object") {
      const wrapped = direct.value as { latitude?: unknown; longitude?: unknown };
      const wrappedLat = typeof wrapped.latitude === "number" && Number.isFinite(wrapped.latitude) ? wrapped.latitude : null;
      const wrappedLng = typeof wrapped.longitude === "number" && Number.isFinite(wrapped.longitude) ? wrapped.longitude : null;
      if (wrappedLat !== null && wrappedLng !== null) {
        return { latitude: wrappedLat, longitude: wrappedLng };
      }
    }
  }

  return { latitude: null, longitude: null };
}

function parseNmea0183Telemetry(lines: string[]): NmeaTelemetry | null {
  let speedKnots: number | null = null;
  let headingDegrees: number | null = null;
  let depthFeet: number | null = null;
  let waterTempF: number | null = null;
  let latitude: number | null = null;
  let longitude: number | null = null;

  lines.forEach((line) => {
    const sentence = normalizeNmeaSentence(line);
    if (!sentence) {
      return;
    }

    const { type, fields } = sentence;

    if (type === "RMC") {
      const rmcLat = parseNmeaCoordinate(fields[3], fields[4], true);
      const rmcLng = parseNmeaCoordinate(fields[5], fields[6], false);
      const rmcSpeed = parseFloatSafe(fields[7]);
      const rmcHeading = parseFloatSafe(fields[8]);
      if (rmcLat !== null && rmcLng !== null) {
        latitude = rmcLat;
        longitude = rmcLng;
      }
      if (rmcSpeed !== null) {
        speedKnots = rmcSpeed;
      }
      if (rmcHeading !== null) {
        headingDegrees = ((rmcHeading % 360) + 360) % 360;
      }
      return;
    }

    if (type === "VTG") {
      const vtgHeading = parseFloatSafe(fields[1]);
      const vtgSpeedKnots = parseFloatSafe(fields[5]);
      if (vtgHeading !== null) {
        headingDegrees = ((vtgHeading % 360) + 360) % 360;
      }
      if (vtgSpeedKnots !== null) {
        speedKnots = vtgSpeedKnots;
      }
      return;
    }

    if (type === "HDG" || type === "HDM") {
      const heading = parseFloatSafe(fields[1]);
      if (heading !== null) {
        headingDegrees = ((heading % 360) + 360) % 360;
      }
      return;
    }

    if (type === "DBT") {
      const feet = parseFloatSafe(fields[3]);
      if (feet !== null) {
        depthFeet = feet;
      }
      return;
    }

    if (type === "DPT") {
      const meters = parseFloatSafe(fields[1]);
      if (meters !== null) {
        depthFeet = metersToFeet(meters);
      }
      return;
    }

    if (type === "MTW") {
      const celsius = parseFloatSafe(fields[1]);
      if (celsius !== null) {
        waterTempF = celsiusToFahrenheit(celsius);
      }
    }
  });

  const hasValues = speedKnots !== null || headingDegrees !== null || depthFeet !== null || waterTempF !== null || (latitude !== null && longitude !== null);
  if (!hasValues) {
    return null;
  }

  return {
    speedKnots,
    headingDegrees,
    depthFeet,
    waterTempF,
    latitude,
    longitude,
    source: "NMEA 0183 serial bridge",
    updatedAt: new Date().toISOString(),
    sampledAtMs: Date.now()
  };
}

async function fetchNmea0183Telemetry(mode: "full" | "quick" = "full"): Promise<NmeaTelemetry | null> {
  if (process.platform !== "linux" || !NMEA0183_ENABLED) {
    return null;
  }

  const resolveSerialCandidates = () => {
    if (NMEA0183_DEVICE !== "auto") {
      return [NMEA0183_DEVICE];
    }

    const byId = "/dev/serial/by-id";
    const candidates: string[] = [];

    if (existsSync(byId)) {
      readdirSync(byId)
        .sort()
        .forEach((entry) => {
          candidates.push(`${byId}/${entry}`);
        });
    }

    readdirSync("/dev")
      .filter((entry) => /^tty(USB|ACM)\d+$/.test(entry))
      .sort()
      .forEach((entry) => {
        candidates.push(`/dev/${entry}`);
      });

    return [...new Set(candidates)];
  };

  const readSeconds = mode === "quick" ? 1 : Math.max(1, NMEA0183_READ_SECONDS);
  const candidates = resolveSerialCandidates();
  const baudRates = NMEA0183_BAUDS.length > 0 ? NMEA0183_BAUDS : [NMEA0183_BAUD];
  const maxAttempts = mode === "quick" ? 2 : Number.POSITIVE_INFINITY;
  let attempts = 0;

  for (const devicePath of candidates) {
    for (const baud of baudRates) {
      if (attempts >= maxAttempts) {
        return null;
      }
      attempts += 1;

      // Use plain bash (not login shell) to avoid spawning /etc/profile.d/ scripts on every scan.
      const cmd = `bash -c 'stty -F "${devicePath}" ${baud} raw -echo min 0 time 1 >/dev/null 2>&1 || true; timeout ${readSeconds} cat "${devicePath}" 2>/dev/null | sed -n "1,200p"'`;

      try {
        const output = await execAsync(cmd, {
          timeout: (readSeconds + 2) * 1000,
          windowsHide: true
        });

        const combined = `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
        const lines = combined.split(/\r?\n/).filter((line) => line.trim().length > 0);
        const telemetry = parseNmea0183Telemetry(lines);
        if (telemetry) {
          return {
            ...telemetry,
            source: `NMEA serial bridge (${devicePath} @ ${baud})`
          };
        }
      } catch {
        // Keep trying the next candidate device/baud combination.
      }
    }
  }

  return null;
}

async function fetchSignalKVesselSelf(): Promise<Record<string, unknown> | null> {
  const baseUrl = SIGNALK_BASE_URL.replace(/\/$/, "");
  const endpoint = `${baseUrl}/signalk/v1/api/vessels/self`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIGNALK_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (response.ok) {
      const payload = asRecord((await response.json()) as unknown);
      if (payload) {
        return payload;
      }
    }

    // Some Signal K deployments expose only /signalk/v1/api with a self pointer.
    const rootResponse = await fetch(`${baseUrl}/signalk/v1/api/`, {
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!rootResponse.ok) {
      return null;
    }

    const rootPayload = asRecord((await rootResponse.json()) as unknown);
    if (!rootPayload) {
      return null;
    }

    const selfPath = typeof rootPayload.self === "string" ? rootPayload.self : null;
    if (!selfPath || selfPath.length === 0) {
      return null;
    }

    const resolved = readPath(rootPayload, selfPath);
    return asRecord(resolved);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function toTelemetry(vesselSelf: Record<string, unknown>): NmeaTelemetry {
  const speedPaths = [
    "navigation.speedOverGround",
    "navigation.speedThroughWater",
    "navigation.speedThroughWaterReferenced"
  ];
  const speedMps = firstNumber(vesselSelf, speedPaths);

  const headingPaths = [
    "navigation.headingMagnetic",
    "navigation.courseOverGroundMagnetic",
    "navigation.courseOverGroundTrue",
    "navigation.headingTrue"
  ];
  const headingRadians = firstNumber(vesselSelf, headingPaths);

  const depthPaths = [
    "environment.depth.belowTransducer",
    "environment.depth.belowSurface",
    "environment.depth.surfaceToTransducer"
  ];
  const depthMeters = firstNumber(vesselSelf, depthPaths);

  const waterTempPaths = [
    "environment.water.temperature",
    "environment.water.temp"
  ];
  const waterTemperature = firstNumber(vesselSelf, waterTempPaths);
  const positionPaths = [
    "navigation.position"
  ];
  const position = pickPosition(vesselSelf, positionPaths);

  let waterTempF: number | null = null;
  if (waterTemperature !== null) {
    // Signal K usually reports Kelvin; if value is low enough, treat as Celsius.
    waterTempF = waterTemperature > 150 ? kelvinToFahrenheit(waterTemperature) : celsiusToFahrenheit(waterTemperature);
  }

  const latestSampleMs = [
    latestTimestampForPaths(vesselSelf, speedPaths),
    latestTimestampForPaths(vesselSelf, headingPaths),
    latestTimestampForPaths(vesselSelf, depthPaths),
    latestTimestampForPaths(vesselSelf, waterTempPaths),
    latestTimestampForPaths(vesselSelf, positionPaths)
  ].reduce<number | null>((latest, value) => {
    if (value === null) {
      return latest;
    }
    if (latest === null || value > latest) {
      return value;
    }
    return latest;
  }, null);

  return {
    speedKnots: speedMps === null ? null : mpsToKnots(speedMps),
    headingDegrees: headingRadians === null ? null : radiansToDegrees(headingRadians),
    depthFeet: depthMeters === null ? null : metersToFeet(depthMeters),
    waterTempF,
    latitude: position.latitude,
    longitude: position.longitude,
    source: "NMEA 2000 via Signal K",
    updatedAt: latestSampleMs ? new Date(latestSampleMs).toISOString() : new Date().toISOString(),
    sampledAtMs: latestSampleMs
  };
}

export async function getNmeaTelemetry(): Promise<NmeaResult> {
  if (!NMEA_ENABLED) {
    return {
      telemetry: null,
      status: "NMEA 2000 disabled by configuration"
    };
  }

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.result;
  }

  const vesselSelf = await fetchSignalKVesselSelf();
  if (!vesselSelf) {
    const serialTelemetry = await fetchNmea0183Telemetry();

    const result: NmeaResult = serialTelemetry
      ? {
        telemetry: serialTelemetry,
        status: serialTelemetry.source
      }
      : {
        telemetry: null,
        status: "NMEA feed unavailable (Signal K offline, no serial NMEA data)"
      };

    cache = {
      expiresAt: now + NMEA_CACHE_MS,
      result
    };

    return result;
  }

  const telemetry = toTelemetry(vesselSelf);
  const hasValues = telemetry.speedKnots !== null
    || telemetry.headingDegrees !== null
    || telemetry.depthFeet !== null
    || telemetry.waterTempF !== null
    || (telemetry.latitude !== null && telemetry.longitude !== null);
  const sampleAgeMs = telemetry.sampledAtMs === null ? Number.POSITIVE_INFINITY : now - telemetry.sampledAtMs;
  const hasFreshValues = hasValues && sampleAgeMs >= 0 && sampleAgeMs <= NMEA_STALE_MS;

  if (!hasFreshValues) {
    const quickSerialTelemetry = await fetchNmea0183Telemetry("quick");
    if (quickSerialTelemetry) {
      const quickResult: NmeaResult = {
        telemetry: quickSerialTelemetry,
        status: quickSerialTelemetry.source
      };

      cache = {
        expiresAt: now + NMEA_CACHE_MS,
        result: quickResult
      };

      return quickResult;
    }
  }

  const result: NmeaResult = {
    telemetry: hasFreshValues ? telemetry : null,
    status: hasFreshValues
      ? telemetry.source
      : hasValues
        ? "NMEA 2000 stale data (bridge offline or unplugged)"
        : "NMEA 2000 connected, waiting for PGNs"
  };

  cache = {
    expiresAt: now + NMEA_CACHE_MS,
    result
  };

  return result;
}
