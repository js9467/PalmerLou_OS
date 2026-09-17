import { useEffect, useMemo, useRef, useState } from "react";
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
  loadStormRadarFrame,
  loadBluetoothState,
  loadLauncherState,
  loadRemoteAccessStatus,
  loadRemoteUpdateStatus,
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
  disconnectWifiNetwork,
  joinWifiNetwork
} from "./lib/api";
import { Circle, CircleMarker, MapContainer, Polygon, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import type {
  AllSpeciesIntelResponse,
  BluetoothDiagnostics,
  BluetoothState,
  DashboardSummary,
  FishingAdvisorResponse,
  FishingCatch,
  LauncherState,
  OceanBuoyObservation,
  RemoteAccessStatus,
  RemoteUpdateStatus,
  SpeciesIntelEntry,
  TripDescriptor,
  WifiNetwork
} from "./types";

const FISHING_LOG_STORAGE_KEY = "palmer-lou-fishing-catches";
const HOME_TILE_LAYOUT_STORAGE_KEY = "palmer-lou-home-tile-layout";
const CUSTOM_BAIT_PRESETS_STORAGE_KEY = "palmer-lou-custom-bait-presets";
const FISHING_MAP_PREFS_STORAGE_KEY = "palmer-lou-fishing-map-prefs";
const TRIP_LOG_STORAGE_KEY = "palmer-lou-trip-log";
const pelagicSpecies = ["Tuna", "Billfish", "Swordfish", "Kingfish", "Wahoo", "Mahi Mahi"];
const BAIT_TYPE_FILTERS = ["All types", "Live bait", "Artificial", "Trolling", "Jigging"] as const;
const BAIT_COLOR_FILTERS = ["All colors", "Natural", "Blue/White", "Pink", "Green", "Purple", "Red/Black", "Silver"] as const;
const HOME_TILE_IDS = ["speed", "heading", "depth", "water-temp", "clock", "connection", "camera", "tide", "barometer", "bluetooth"] as const;

type HomeTileId = typeof HOME_TILE_IDS[number];
type BaitType = Exclude<(typeof BAIT_TYPE_FILTERS)[number], "All types">;
type BaitColor = Exclude<(typeof BAIT_COLOR_FILTERS)[number], "All colors">;
type RemoteControlAction = "up" | "down" | "left" | "right" | "select" | "back" | "home" | "playpause" | "volup" | "voldown" | "mute" | "backspace";

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
const DEFAULT_TRIP_HOME_RADIUS_NM = 0.15;
const REMOTE_ACCESS_PATH = "/?remote=1";

function isRemoteModeUrl() {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  const flag = params.get("remote");
  return window.location.pathname.startsWith("/remote") || flag === "1" || flag === "true";
}

function readTripHomeRadius(): number {
  if (typeof window === "undefined") {
    return DEFAULT_TRIP_HOME_RADIUS_NM;
  }

  const raw = window.localStorage.getItem(TRIP_HOME_RADIUS_STORAGE_KEY);
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_TRIP_HOME_RADIUS_NM;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TRIP_HOME_RADIUS_NM;
  }

  return Math.min(Math.max(parsed, 0.05), 2.5);
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

function pushPointOffshore(point: GeoPoint, anchors: Array<{ latitude: number; longitude: number }>) {
  if (!isLikelyLand(point)) {
    return point;
  }

  const anchor = anchors
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

  return point;
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
  overlayDate: string;
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

  useMapEvents({
    dragstart: () => {
      userMovedRef.current = true;
    },
    zoomstart: () => {
      userMovedRef.current = true;
    }
  });

  useEffect(() => {
    if (hasInitializedRef.current || userMovedRef.current) {
      return;
    }

    if (currentPosition) {
      map.setView([currentPosition.latitude, currentPosition.longitude], 8, { animate: false });
      hasInitializedRef.current = true;
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

function FishingIntelViewport({ circles }: { circles: FishMappingCircle[] }) {
  const map = useMap();
  const hasFittedRef = useRef(false);

  useEffect(() => {
    // Only auto-fit once when circles first arrive; never override a user pan/zoom
    if (hasFittedRef.current || circles.length === 0) {
      return;
    }
    hasFittedRef.current = true;
    const lats = circles.map((c) => c.latitude);
    const lngs = circles.map((c) => c.longitude);
    const pad = 0.8;
    map.fitBounds(
      [[Math.min(...lats) - pad, Math.min(...lngs) - pad], [Math.max(...lats) + pad, Math.max(...lngs) + pad]],
      { animate: true, padding: [48, 48], maxZoom: 9 }
    );
  }, [circles, map]);

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

function buildOceanOverlayUrl(source: OceanTileOverlayId, date: string) {
  return `/api/ocean/tiles/${source}/{z}/{x}/{y}.png?date=${encodeURIComponent(date)}`;
}

function readFishingMapPrefs(): FishingMapPrefs {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const defaults: FishingMapPrefs = {
    mapDateFilter: "7d",
    viewMode: "clusters",
    basemap: "nautical",
    overlayDate: yesterday,
    overlayOpacity: 56,
    overlays: {
      sst: true,
      chlorophyll: false,
      currents: false,
      contours: true,
      fronts: true
    }
  };

  const raw = window.localStorage.getItem(FISHING_MAP_PREFS_STORAGE_KEY);
  if (!raw) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<FishingMapPrefs>;
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
      overlayDate: typeof parsed.overlayDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.overlayDate)
        ? parsed.overlayDate
        : defaults.overlayDate,
      overlayOpacity: typeof parsed.overlayOpacity === "number" && parsed.overlayOpacity >= 15 && parsed.overlayOpacity <= 95
        ? parsed.overlayOpacity
        : defaults.overlayOpacity,
      overlays: {
        sst: typeof parsed.overlays?.sst === "boolean" ? parsed.overlays.sst : defaults.overlays.sst,
        chlorophyll: typeof parsed.overlays?.chlorophyll === "boolean" ? parsed.overlays.chlorophyll : defaults.overlays.chlorophyll,
        currents: typeof parsed.overlays?.currents === "boolean" ? parsed.overlays.currents : defaults.overlays.currents,
        contours: typeof parsed.overlays?.contours === "boolean" ? parsed.overlays.contours : defaults.overlays.contours,
        fronts: typeof parsed.overlays?.fronts === "boolean" ? parsed.overlays.fronts : defaults.overlays.fronts
      }
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

export function App() {
  const initialFishingMapPrefs = readFishingMapPrefs();
  const remoteMode = isRemoteModeUrl();
  const remoteAccessUrl = typeof window === "undefined" ? REMOTE_ACCESS_PATH : `${window.location.origin}${REMOTE_ACCESS_PATH}`;
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
  const [showRuntimePanel, setShowRuntimePanel] = useState(false);
  const [selectedNavId, setSelectedNavId] = useState("home");
  const [settingsSubview, setSettingsSubview] = useState<SettingsSubview>("wifi");
  const [fishingSubview, setFishingSubview] = useState<FishingSubview>("map");
  const [fishingCatches, setFishingCatches] = useState<FishingCatch[]>(() => readFishingCatches());
  const [quickSpecies, setQuickSpecies] = useState("Yellowfin");
  const [selectedBaitTypeFilter, setSelectedBaitTypeFilter] = useState<(typeof BAIT_TYPE_FILTERS)[number]>("All types");
  const [selectedBaitColorFilter, setSelectedBaitColorFilter] = useState<(typeof BAIT_COLOR_FILTERS)[number]>("All colors");
  const [selectedBaitId, setSelectedBaitId] = useState(BAIT_PRESETS[0]?.id ?? "live-menhaden");
  const [customBaitPresets, setCustomBaitPresets] = useState<BaitPreset[]>(() => readCustomBaitPresets());
  const [vesselPosition, setVesselPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  const [browserGeoLocation, setBrowserGeoLocation] = useState<[number, number] | null>(null);
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
  const [fishingMapOverlayDate, setFishingMapOverlayDate] = useState(initialFishingMapPrefs.overlayDate);
  const [fishingMapOverlayOpacity, setFishingMapOverlayOpacity] = useState(initialFishingMapPrefs.overlayOpacity);
  const [enabledOceanOverlays, setEnabledOceanOverlays] = useState<Record<OceanOverlayId, boolean>>(initialFishingMapPrefs.overlays);
  const [selectedFishCircleId, setSelectedFishCircleId] = useState<string | null>(null);
  const [fishingMapBounds, setFishingMapBounds] = useState<{ minLat: number; maxLat: number; minLng: number; maxLng: number } | null>(null);
  const [showFishingMapSettings, setShowFishingMapSettings] = useState(false);
  const [fishingMapFullscreen, setFishingMapFullscreen] = useState(false);
  const [fishingMapRenderNonce, setFishingMapRenderNonce] = useState(0);
  const [speciesVisibility, setSpeciesVisibility] = useState<Record<string, boolean>>(() => {
    const defaults: Record<string, boolean> = {};
    pelagicSpecies.forEach((species) => {
      defaults[species] = true;
    });
    return defaults;
  });
  const [oceanBuoys, setOceanBuoys] = useState<OceanBuoyObservation[]>([]);
  const [loadingOceanBuoys, setLoadingOceanBuoys] = useState(false);
  const [weatherRadarFullscreen, setWeatherRadarFullscreen] = useState(false);
  const [stormRadarTileUrl, setStormRadarTileUrl] = useState<string | null>(null);
  const [stormRadarFrameLabel, setStormRadarFrameLabel] = useState<string | null>(null);
  const [loadingStormRadar, setLoadingStormRadar] = useState(false);
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
  const [trendBaseTime] = useState(() => Date.now());
  const [depthTempTrend, setDepthTempTrend] = useState<Array<{ timestamp: string; depthFeet: number | null; waterTempF: number | null }>>([]);
  const [homeTileLayout, setHomeTileLayout] = useState<HomeTileId[]>(() => readHomeTileLayout());
  const [editingHomeTiles, setEditingHomeTiles] = useState(false);
  const [tripHistory, setTripHistory] = useState<TripDescriptor[]>(() => readStoredTrips());
  const [tripSession, setTripSession] = useState<TripLog | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [tripHomeRadiusNm, setTripHomeRadiusNm] = useState<number>(() => readTripHomeRadius());
  const [tripMapFullscreen, setTripMapFullscreen] = useState(false);
  const activeTripRef = useRef<TripLog | null>(null);
  const activeSummary = summary ?? fallbackSummary;

  const vibrateRemote = (pattern: number | number[]) => {
    if (!remoteMode || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      return;
    }

    navigator.vibrate(pattern);
  };

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
    breadcrumbs: trip.breadcrumbs
  });

  function buildTripTelemetrySnapshot() {
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
      wind: activeSummary?.weather.wind ?? "Unknown",
      barometer: activeSummary?.weather.barometer ?? "Unknown",
      networkStatus: activeSummary?.connectivity.network ?? "Unknown",
      source: activeSummary?.connectivity.nmea ?? "Live route"
    };
  }

  function startTripSession() {
    const point = vesselPosition ?? { latitude: 29.5, longitude: -83.2 };
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
      wind: telemetry.wind,
      barometer: telemetry.barometer,
      networkStatus: telemetry.networkStatus,
      source: telemetry.source
    });

    activeTripRef.current = nextTrip;
    setTripSession(nextTrip);
    setSelectedTripId(nextTrip.id);
    setTripHistory((current) => [toTripDescriptor(nextTrip), ...current]);
  }

  function finishTripAtHome(radiusNm?: number) {
    if (!activeTripRef.current || !vesselPosition) {
      return;
    }

    const homePoint = activeTripRef.current.breadcrumbs[0];
    if (!homePoint) {
      return;
    }

    const safeRadius = radiusNm ?? tripHomeRadiusNm;
    const atHome = shouldEndTripAtHome(homePoint.latitude, homePoint.longitude, vesselPosition.latitude, vesselPosition.longitude, safeRadius);
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
  }

  useEffect(() => {
    window.localStorage.setItem(FISHING_LOG_STORAGE_KEY, JSON.stringify(fishingCatches));
  }, [fishingCatches]);

  useEffect(() => {
    window.localStorage.setItem(HOME_TILE_LAYOUT_STORAGE_KEY, JSON.stringify(homeTileLayout));
  }, [homeTileLayout]);

  useEffect(() => {
    window.localStorage.setItem(TRIP_HOME_RADIUS_STORAGE_KEY, String(tripHomeRadiusNm));
  }, [tripHomeRadiusNm]);

  useEffect(() => {
    window.localStorage.setItem(CUSTOM_BAIT_PRESETS_STORAGE_KEY, JSON.stringify(customBaitPresets));
  }, [customBaitPresets]);

  useEffect(() => {
    writeStoredTrips(tripHistory);
  }, [tripHistory]);

  useEffect(() => {
    const prefs: FishingMapPrefs = {
      mapDateFilter: fishingMapDateFilter,
      viewMode: fishingMapViewMode,
      basemap: fishingBasemap,
      overlayDate: fishingMapOverlayDate,
      overlayOpacity: fishingMapOverlayOpacity,
      overlays: enabledOceanOverlays
    };

    window.localStorage.setItem(FISHING_MAP_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  }, [enabledOceanOverlays, fishingBasemap, fishingMapDateFilter, fishingMapOverlayDate, fishingMapOverlayOpacity, fishingMapViewMode]);

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
    let initialized = false;

    const refreshSummary = () => {
      loadSummary()
        .then((data) => {
          if (!active) {
            return;
          }

          setSummary(data);
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

        setVesselPosition(nextPoint);

        if (!activeTripRef.current) {
          return;
        }

        const telemetry = buildTripTelemetrySnapshot();

        const updatedTrip = appendTripBreadcrumb(activeTripRef.current, {
          latitude: nextPoint.latitude,
          longitude: nextPoint.longitude,
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
          wind: telemetry.wind,
          barometer: telemetry.barometer,
          networkStatus: telemetry.networkStatus,
          source: telemetry.source
        });

        activeTripRef.current = updatedTrip;
        setTripSession(updatedTrip);
        setSelectedTripId(updatedTrip.id);
        setTripHistory((current) => [
          toTripDescriptor(updatedTrip),
          ...current.filter((trip) => trip.id !== updatedTrip.id)
        ]);

        const homePoint = updatedTrip.breadcrumbs[0];
        if (homePoint && shouldEndTripAtHome(homePoint.latitude, homePoint.longitude, nextPoint.latitude, nextPoint.longitude, tripHomeRadiusNm)) {
          finishTripAtHome(tripHomeRadiusNm);
        }
      },
      () => {
        setVesselPosition((current) => current ?? { latitude: 29.5, longitude: -83.2 });
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

    const homePoint = activeTripRef.current.breadcrumbs[0];
    if (!homePoint) {
      return;
    }

    if (shouldEndTripAtHome(homePoint.latitude, homePoint.longitude, vesselPosition.latitude, vesselPosition.longitude, tripHomeRadiusNm)) {
      stopTripSession();
    }
  }, [activeSummary, vesselPosition, tripHomeRadiusNm]);

  useEffect(() => {
    let active = true;

    loadLauncherState()
      .then((state) => {
        if (!active) {
          return;
        }

        setLauncherState(state);
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

  const fishingMapCenter = useMemo<[number, number]>(() => {
    if (vesselPosition) {
      return [vesselPosition.latitude, vesselPosition.longitude];
    }

    if (fishingMapPoints.length === 0) {
      return browserGeoLocation ?? [35.5, -75.4];
    }

    const latitudeAverage = fishingMapPoints.reduce((sum, point) => sum + point.mapLatitude, 0) / fishingMapPoints.length;
    const longitudeAverage = fishingMapPoints.reduce((sum, point) => sum + point.mapLongitude, 0) / fishingMapPoints.length;
    return [latitudeAverage, longitudeAverage];
  }, [fishingMapPoints, vesselPosition, browserGeoLocation]);

  const oceanOverlayOpacity = fishingMapOverlayOpacity / 100;
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
  }, [avgBuoyWindKnots, buoyPressureTrend.label, currentWaveFeet, peakWaveFeet, weatherWindValue]);

  useEffect(() => {
    if (selectedNavId !== "weather") {
      return;
    }

    let active = true;
    setLoadingStormRadar(true);

    loadStormRadarFrame()
      .then((payload) => {
        if (!active) {
          return;
        }

        if (!payload.available || !payload.tileUrlTemplate) {
          setStormRadarTileUrl(null);
          setStormRadarFrameLabel("Radar feed unavailable");
          return;
        }

        setStormRadarTileUrl(payload.tileUrlTemplate);
        setStormRadarFrameLabel(
          payload.observedAt
            ? new Date(payload.observedAt).toLocaleString()
            : "Live frame"
        );
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setStormRadarTileUrl(null);
        setStormRadarFrameLabel("Radar feed unavailable");
      })
      .finally(() => {
        if (active) {
          setLoadingStormRadar(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedNavId]);

  const allFishMappingCircles = useMemo<FishMappingCircle[]>(() => {
    // When species intel is available use its independently-scored per-species locations
    if (speciesIntel && speciesIntel.species.length > 0) {
      const now = Date.now();
      const windowMs = dateWindowMsForFilter(fishingMapDateFilter);
      const recentCatches = fishingCatches.filter((c) => now - new Date(c.timestamp).getTime() <= windowMs);

      const mappedCircles: FishMappingCircle[] = speciesIntel.species.filter((entry) => entry.recommended).map((entry) => {
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

        return {
          id: `fish-map-${entry.species.toLowerCase().replace(/\s+/g, "-")}`,
          species: entry.species,
          latitude: entry.bestLatitude,
          longitude: entry.bestLongitude,
          radiusNm: entry.radiusNm,
          score: entry.score,
          confidence: entry.confidence,
          profile,
          supportingCount: recentCatches.filter((c) => c.species === entry.species).length,
          points: entry.points
        };
      }).filter((c): c is FishMappingCircle => c !== null);

      return mappedCircles;
    }

    // Fallback: original logic when intel not loaded
    const now = Date.now();
    const windowMs = dateWindowMsForFilter(fishingMapDateFilter);
    const recentCatches = fishingCatches.filter((catchItem) => now - new Date(catchItem.timestamp).getTime() <= windowMs);
    const marineBuoys = oceanBuoys.filter((buoy) => !isLikelyLand({ latitude: buoy.latitude, longitude: buoy.longitude }));
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

        return !isLikelyLand({ latitude: catchItem.latitude, longitude: catchItem.longitude });
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

      const offshoreCenter = pushPointOffshore({ latitude, longitude }, buoyAnchors);
      if (isLikelyLand(offshoreCenter)) {
        return;
      }

      const score = 48;
      const confidence: "high" | "medium" | "low" = "low";
      const extendedRadius = 10;

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

  const selectedFishCircle = useMemo(() => {
    if (!fishMappingCircles.length) {
      return null;
    }

    if (selectedFishCircleId) {
      return fishMappingCircles.find((circle) => circle.id === selectedFishCircleId) ?? fishMappingCircles[0];
    }

    return fishMappingCircles[0];
  }, [fishMappingCircles, selectedFishCircleId]);

  const fallbackMarineFronts = useMemo(() => {
    const center = vesselPosition ?? { latitude: fishingMapCenter[0], longitude: fishingMapCenter[1] };
    const target = selectedFishCircle?.species ?? quickSpecies;
    return buildMarineFronts(center.latitude, center.longitude, target);
  }, [fishingMapCenter, quickSpecies, selectedFishCircle, vesselPosition]);

  const tacticalFronts = useMemo(() => {
    const fronts = fishingAdvisor?.oceanSignals?.fronts;
    if (!fronts || fronts.length === 0) {
      return fallbackMarineFronts;
    }

    return fronts.map((front) => {
      const convergence = front.kind === "convergence";
      const high = front.strength === "high";
      const medium = front.strength === "medium";
      const color = convergence
        ? (high ? "#6fd9ff" : medium ? "#4ab8e3" : "#2b7da1")
        : (high ? "#ff9b52" : medium ? "#ffbf72" : "#d2a57d");

      return {
        id: front.id,
        label: `${front.label} (${front.score})`,
        color,
        points: front.points,
        weight: high ? 4.2 : medium ? 3.2 : 2.4,
        opacity: high ? 0.94 : medium ? 0.84 : 0.72,
        dashArray: convergence ? "5 8" : high ? "" : "8 7"
      };
    });
  }, [fallbackMarineFronts, fishingAdvisor]);

  const mapDataAvailable = typeof navigator !== "undefined" ? navigator.onLine : true;
  const tacticalMapFallback = !mapDataAvailable;
  const noBuoySignalCoverage = oceanBuoys.length === 0;
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
      setShowFishingMapSettings(false);
    }
  }, [selectedNavId]);

  useEffect(() => {
    if (fishingSubview !== "map") {
      setShowFishingMapSettings(false);
    }
  }, [fishingSubview]);

  // Request browser geolocation once when the user first opens the fishing page
  useEffect(() => {
    if (selectedNavId !== "fishing" || browserGeoLocation !== null || !navigator.geolocation) {
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setBrowserGeoLocation([pos.coords.latitude, pos.coords.longitude]),
      () => {}
    );
  }, [selectedNavId, browserGeoLocation]);

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
      maxRadiusNm: 260
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
      maxRadiusNm: 260
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

      const reconnected = await sendBluetoothAction("reconnect");
      setBluetoothState(reconnected);

      const routed = await sendBluetoothAction("route-audio");
      setBluetoothState(routed);

      const refreshed = await loadBluetoothState();
      setBluetoothState(refreshed);
      setBtScanResults([]);
      setOnline(true);
    } catch {
      const recovered = await sendBluetoothAction("reconnect").catch(() => null);
      if (recovered) {
        const routed = await sendBluetoothAction("route-audio").catch(() => recovered);
        setBluetoothState(routed);
      }
      const refreshed = await loadBluetoothState().catch(() => null);
      if (refreshed) { setBluetoothState(refreshed); }
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
      setFishingMapOverlayOpacity(56);
      setEnabledOceanOverlays({ sst: true, chlorophyll: false, currents: false, contours: true, fronts: true });
      return;
    }

    if (preset === "temp-edge") {
      setFishingBasemap("standard");
      setFishingMapViewMode("heatmap");
      setFishingMapOverlayOpacity(62);
      setEnabledOceanOverlays({ sst: true, chlorophyll: true, currents: false, contours: false, fronts: true });
      return;
    }

    if (preset === "structure") {
      setFishingBasemap("nautical");
      setFishingMapViewMode("points");
      setFishingMapOverlayOpacity(46);
      setEnabledOceanOverlays({ sst: false, chlorophyll: false, currents: false, contours: true, fronts: true });
      return;
    }

    setFishingBasemap("standard");
    setFishingMapViewMode("clusters");
    setFishingMapOverlayOpacity(34);
    setEnabledOceanOverlays({ sst: false, chlorophyll: false, currents: true, contours: false, fronts: true });
  }

  function applySpeciesFishingPreset(species: string) {
    const profile = (SPECIES_FISHMAP_PROFILES[species] ?? SPECIES_FISHMAP_PROFILES.Tuna) as SpeciesFishProfile;
    const frontPreference = SPECIES_FRONT_PREFERENCE[species] ?? { sst: 1, convergence: 1 };

    setFishingMapSpeciesFilter(species);
    setAdvisorSpecies(species);
    setFishingBasemap("nautical");
    setFishingMapViewMode("clusters");
    setFishingMapOverlayOpacity(58);
    setEnabledOceanOverlays({
      sst: profile.temperatureRangeF.max >= 78,
      chlorophyll: profile.chlorophyllSignal.toLowerCase().includes("chlorophyll") || profile.currentSignal.toLowerCase().includes("weed") || profile.currentSignal.toLowerCase().includes("debris"),
      currents: frontPreference.convergence >= 1.05,
      contours: true,
      fronts: true
    });

    const matchingCircle = fishMappingCircles.find((circle) => circle.species === species);
    if (matchingCircle) {
      setSelectedFishCircleId(matchingCircle.id);
    }
  }

  async function handleRemoteControl(action: RemoteControlAction, repeat = 1) {
    setRunningRemoteControlAction(action);

    try {
      const result = await sendRemoteControlAction(action, repeat);
      setRemoteControlStatus(result.success ? `${result.action.toUpperCase()} sent to touchscreen` : `${result.action.toUpperCase()} failed`);
      vibrateRemote(result.success ? [10, 20, 10] : [36, 36, 36]);
    } catch {
      setRemoteControlStatus(`${action.toUpperCase()} failed`);
      vibrateRemote([36, 36, 36]);
    } finally {
      setRunningRemoteControlAction(null);
    }
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
          <button type="button" className="theme-toggle remote-btn" onClick={() => void handleRemoteControl("up")}>▲</button>
          <button type="button" className="theme-toggle remote-btn remote-btn--ghost" onClick={() => void handleRemoteControl("mute")}>Mute</button>

          <button type="button" className="theme-toggle remote-btn" onClick={() => void handleRemoteControl("left")}>◀</button>
          <button type="button" className="theme-toggle theme-toggle--primary remote-btn remote-btn--ok" onClick={() => void handleRemoteControl("select")}>OK</button>
          <button type="button" className="theme-toggle remote-btn" onClick={() => void handleRemoteControl("right")}>▶</button>

          <button type="button" className="theme-toggle remote-btn remote-btn--ghost" onClick={() => void handleRemoteControl("back")}>Back</button>
          <button type="button" className="theme-toggle remote-btn" onClick={() => void handleRemoteControl("down")}>▼</button>
          <button type="button" className="theme-toggle remote-btn remote-btn--ghost" onClick={() => void handleRemoteControl("playpause")}>⏯</button>
        </div>

        <div className="remote-control-row" role="group" aria-label="Volume controls">
          <button type="button" className="theme-toggle remote-btn" onClick={() => void handleRemoteControl("voldown", 2)} disabled={runningRemoteControlAction !== null}>Vol −</button>
          <button type="button" className="theme-toggle remote-btn" onClick={() => void handleRemoteControl("volup", 2)} disabled={runningRemoteControlAction !== null}>Vol +</button>
        </div>

        <div className="keyboard-toggle-row remote-control-row">
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
    return (
      <MapContainer center={fishingMapCenter} zoom={6} className={mapClassName} scrollWheelZoom={false} attributionControl={false}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {stormRadarTileUrl ? (
          <TileLayer url={stormRadarTileUrl} opacity={0.72} zIndex={450} />
        ) : null}
        {nearbyMarineBuoys.map((buoy) => {
          const waveFeet = buoy.waveHeightM === null ? null : buoy.waveHeightM * 3.28084;
          const windKnots = buoy.windSpeedMps === null ? null : buoy.windSpeedMps * 1.94384;
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
              </Tooltip>
            </CircleMarker>
          );
        })}
        {vesselPosition ? (
          <Circle
            center={[vesselPosition.latitude, vesselPosition.longitude]}
            radius={6500}
            pathOptions={{ color: "#59baff", fillColor: "#59baff", fillOpacity: 0.1, weight: 1 }}
          />
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
            {renderWeatherRadarMap("weather-radar-map weather-radar-map--fullscreen")}
            <div className="weather-radar-fullscreen__hud">
              <strong>Storm Doppler radar</strong>
              <span>{stormRadarFrameLabel ? `Radar frame: ${stormRadarFrameLabel}` : "Radar frame unavailable"}</span>
              <span>Buoy sample: {latestBuoyObservationLabel}</span>
            </div>
            <button className="camera-fullscreen__exit" type="button" onClick={() => setWeatherRadarFullscreen(false)}
              aria-label="Exit fullscreen radar">
              ✕
            </button>
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
            <span className={online ? "status-pill status-pill--success" : "status-pill"}>{online ? "Online" : "Fallback"}</span>
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
                  <span className="trip-card__tag">{loadingStormRadar ? "Loading frame" : "Live radar"}</span>
                  <button className="camera-fullscreen-btn" type="button" onClick={() => setWeatherRadarFullscreen(true)}
                    aria-label="Enter fullscreen radar">⛶</button>
                </div>
              </div>

              <div className="weather-radar-map-shell">
                {renderWeatherRadarMap("weather-radar-map")}
              </div>
              <p className="weather-radar-card__note">Radar frame: {stormRadarFrameLabel ?? "Waiting for feed"}</p>
              <p className="weather-radar-card__note">Nearest buoy sample: {latestBuoyObservationLabel}</p>
            </section>

            <section className="weather-forecast" aria-label="Marine forecast">
              <div className="weather-forecast__header">
                <div>
                  <p className="panel__eyebrow">Forecast</p>
                  <h3>12 hour outlook</h3>
                </div>
                <span className="trip-card__tag">{seaStateLabel}</span>
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
      return (
        <section className={`panel drill-panel ${fishingSubview === "map" ? "drill-panel--fishing-map" : "drill-panel--fishing-log"}`}>
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
                        <label className="fishing-field fishing-field--compact">
                          <span>Overlay date</span>
                          <input
                            type="date"
                            value={fishingMapOverlayDate}
                            onChange={(event) => setFishingMapOverlayDate(event.target.value)}
                            max={new Date().toISOString().slice(0, 10)}
                          />
                        </label>

                        <label className="fishing-field fishing-field--compact fishing-field--slider">
                          <span>Overlay opacity ({fishingMapOverlayOpacity}%)</span>
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
                            checked={enabledOceanOverlays.chlorophyll}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, chlorophyll: event.target.checked }))}
                          />
                          <span>Chlorophyll</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.fronts}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, fronts: event.target.checked }))}
                          />
                          <span>Tactical fronts</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.currents}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, currents: event.target.checked }))}
                          />
                          <span>Currents (coarse)</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.contours}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, contours: event.target.checked }))}
                          />
                          <span>Depth contours</span>
                        </label>
                      </div>
                      {enabledOceanOverlays.currents ? (
                        <p className="fishing-map-local-status fishing-map-local-status--warning">
                          Currents layer is low-resolution satellite data. Use it for broad direction only and rely on tactical fronts for fishable seams.
                        </p>
                      ) : null}

                      <div className="fishing-map-confidence-legend" aria-label="Seam confidence legend">
                        <div className="fishing-map-confidence-legend__item">
                          <strong>High</strong>
                          <span>Tight front, repeat bites, strong color edge</span>
                        </div>
                        <div className="fishing-map-confidence-legend__item">
                          <strong>Medium</strong>
                          <span>Useful seam, some supporting signs, worth a pass</span>
                        </div>
                        <div className="fishing-map-confidence-legend__item">
                          <strong>Low</strong>
                          <span>Broad current only, needs more signs before running</span>
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}

                <div className={fishingMapFullscreen ? "fishing-map-shell fishing-map-shell--fullscreen" : "fishing-map-shell"} aria-label="Fishing catch map">
                  {fishingSubview === "map" ? (
                    <button
                      type="button"
                      className="fishing-map-settings-toggle"
                      onClick={() => setShowFishingMapSettings((current) => !current)}
                      aria-expanded={showFishingMapSettings}
                      aria-controls="fishing-map-settings"
                    >
                      {showFishingMapSettings ? "Close map settings" : "Map settings"}
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

                      <label className="fishing-field fishing-field--compact">
                        <span>Overlay date</span>
                        <input
                          type="date"
                          value={fishingMapOverlayDate}
                          onChange={(event) => setFishingMapOverlayDate(event.target.value)}
                          max={new Date().toISOString().slice(0, 10)}
                        />
                      </label>

                      <label className="fishing-field fishing-field--compact fishing-field--slider">
                        <span>Overlay opacity ({fishingMapOverlayOpacity}%)</span>
                        <input
                          type="range"
                          min={15}
                          max={95}
                          step={1}
                          value={fishingMapOverlayOpacity}
                          onChange={(event) => setFishingMapOverlayOpacity(Number(event.target.value))}
                        />
                      </label>

                      <div className="fishing-map-settings__toggles" role="group" aria-label="Ocean overlays">
                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.fronts}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, fronts: event.target.checked }))}
                          />
                          <span>Tactical fronts</span>
                        </label>

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
                            checked={enabledOceanOverlays.chlorophyll}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, chlorophyll: event.target.checked }))}
                          />
                          <span>Chlorophyll</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.currents}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, currents: event.target.checked }))}
                          />
                          <span>Currents (coarse)</span>
                        </label>

                        <label className="fishing-overlay-toggle">
                          <input
                            type="checkbox"
                            checked={enabledOceanOverlays.contours}
                            onChange={(event) => setEnabledOceanOverlays((current) => ({ ...current, contours: event.target.checked }))}
                          />
                          <span>Depth contours</span>
                        </label>
                      </div>

                      <div className="fishing-layer-presets" role="group" aria-label="Fishing map strategy presets">
                        <span className="fishing-layer-presets__label">Quick strategy</span>
                        <button type="button" className="fishing-species-selector__chip" onClick={() => applyFishingMapPreset("search")}>Search water</button>
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
                          <span>Tight front, repeat bites, strong color edge</span>
                        </div>
                        <div className="fishing-map-confidence-legend__item">
                          <strong>Medium</strong>
                          <span>Useful seam, some supporting signs, worth a pass</span>
                        </div>
                        <div className="fishing-map-confidence-legend__item">
                          <strong>Low</strong>
                          <span>Broad current only, needs more signs before running</span>
                        </div>
                      </div>
                    </aside>
                  ) : null}
                  {!fishingMapFullscreen && tacticalMapFallback ? (
                    <div className="fishing-map-local-status">
                      Public tile network unavailable. Local tactical mode active with live vessel GPS, catch history, and species intelligence.
                    </div>
                  ) : null}
                  {!fishingMapFullscreen && noBuoySignalCoverage ? (
                    <div className="fishing-map-local-status fishing-map-local-status--warning">
                      No NOAA buoys returned in this viewport. Signal fronts are running in fallback mode until buoy coverage is found.
                    </div>
                  ) : null}
                    <MapContainer
                      key={`fishing-map-${fishingMapRenderNonce}`}
                      center={fishingMapCenter}
                      zoom={7}
                      minZoom={4}
                      maxZoom={12}
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
                    {vesselPosition ? (
                      <CircleMarker
                        center={[vesselPosition.latitude, vesselPosition.longitude]}
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
                            <strong>Current position</strong>
                            <span>{vesselPosition.latitude.toFixed(4)}°, {vesselPosition.longitude.toFixed(4)}°</span>
                            <small>Live GPS</small>
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
                    {!mapFallbackActive && enabledOceanOverlays.sst ? (
                      <TileLayer
                        url={buildOceanOverlayUrl("sst", fishingMapOverlayDate)}
                        opacity={oceanOverlayOpacity}
                        maxNativeZoom={7}
                      />
                    ) : null}
                    {!mapFallbackActive && enabledOceanOverlays.chlorophyll ? (
                      <TileLayer
                        url={buildOceanOverlayUrl("chlorophyll", fishingMapOverlayDate)}
                        opacity={oceanOverlayOpacity}
                        maxNativeZoom={7}
                      />
                    ) : null}
                    {!mapFallbackActive && enabledOceanOverlays.currents ? (
                      <TileLayer
                        url={buildOceanOverlayUrl("currents", fishingMapOverlayDate)}
                        opacity={Math.min(0.42, oceanOverlayOpacity * 0.52)}
                        maxNativeZoom={5}
                        maxZoom={6}
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
                    {enabledOceanOverlays.fronts ? tacticalFronts.map((front) => (
                      <Polyline
                        key={front.id}
                        positions={front.points}
                        pathOptions={{
                          color: front.color,
                          weight: front.weight,
                          opacity: front.opacity,
                          dashArray: front.dashArray
                        }}
                      >
                        <Popup>
                          <div className="fishing-map-popup">
                            <strong>{front.label}</strong>
                            <small>Public-data tactical front</small>
                          </div>
                        </Popup>
                      </Polyline>
                    )) : null}
                    <FishingMapBoundsReporter onBoundsChange={setFishingMapBounds} />
                    <FishingMapViewport points={fishingMapPoints} currentPosition={vesselPosition ?? null} />
                    <FishingIntelViewport circles={fishMappingCircles} />
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
                    {fishMappingCircles.flatMap((circle) => [
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
                          <div className="fishing-map-popup">
                            <strong>{circle.species}</strong>
                            <span>Score {circle.score} | {circle.confidence.toUpperCase()}</span>
                            <span>{circle.profile.temperatureRangeF.min} F – {circle.profile.temperatureRangeF.max} F</span>
                            <small>{circle.profile.currentSignal}</small>
                          </div>
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
                      />
                    ])}
                    </MapContainer>
                  {!fishingMapFullscreen && fishMappingCircles.length > 0 && (
                    <div className="fishing-map-intel-legend">
                      {fishMappingCircles.map((circle) => {
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
                  {!fishingMapFullscreen ? (
                    <p className="fishing-map-attribution">
                      {fishingBasemap === "nautical"
                        ? "Map data: OpenStreetMap + OpenSeaMap contributors"
                        : fishingBasemap === "satellite"
                          ? "Map data: Esri World Imagery"
                          : "Map data: OpenStreetMap contributors"}
                      {enabledOceanOverlays.sst || enabledOceanOverlays.chlorophyll || enabledOceanOverlays.currents
                        ? ` | Ocean layers: NASA GIBS (${fishingMapOverlayDate})`
                        : ""}
                      {enabledOceanOverlays.contours ? " | Contours: Esri Ocean Reference" : ""}
                      {enabledOceanOverlays.fronts ? " | Fronts: tactical seam model" : ""}
                      {fishingAdvisor?.oceanSignals?.fronts?.length
                        ? ` | Tactical fronts: ${fishingAdvisor.oceanSignals.fronts.length}`
                        : " | Tactical fronts: fallback model"}
                    </p>
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
                              {entry.recommended ? <span className="species-intel-row__flag species-intel-row__flag--go">Go here</span> : <span className="species-intel-row__flag">Monitor</span>}
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
                    <small>cool to warm break</small>
                  </div>
                  <div className="fishing-map-legend__item">
                    <span>Convergence</span>
                    <div className="fishing-map-legend__bar fishing-map-legend__bar--chlorophyll" />
                    <small>current/wind edge</small>
                  </div>
                  <div className="fishing-map-legend__item">
                    <span>Depth contours</span>
                    <div className="fishing-map-legend__bar fishing-map-legend__bar--contours" />
                    <small>shelf breaks and ledge lanes</small>
                  </div>
                  <div className="fishing-map-legend__item">
                    <span>Buoy temp dots</span>
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
        <section className="panel drill-panel">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Vessel</p>
              <h2>Engines and system status</h2>
            </div>
            <span className="status-pill">{activeSummary.system.uptime}</span>
          </div>
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
        </section>
      );
    }

    if (selectedNavId === "trips") {
      const selectedTrip = tripHistory.find((trip) => trip.id === selectedTripId) ?? (tripSession ?? tripHistory[0] ?? null);
      const activeTripPoints = selectedTrip?.breadcrumbs.map((point) => [point.latitude, point.longitude] as [number, number]) ?? [];
      const activeTripCenter = activeTripPoints.length > 0 ? activeTripPoints[0] : [29.5, -83.2] as [number, number];
      const tripDetail = selectedTrip ?? tripSession ?? tripHistory[0] ?? null;
      const breadcrumbRows = tripDetail?.breadcrumbs.slice(-25).reverse() ?? [];

      const renderTripRouteMap = (mapClassName: string) => (
        <MapContainer center={activeTripCenter} zoom={11} scrollWheelZoom={false} attributionControl={false} className={mapClassName}>
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {activeTripPoints.length > 1 ? <Polyline positions={activeTripPoints} pathOptions={{ color: "#39d0ff", weight: 4, opacity: 0.9 }} /> : null}
          {activeTripPoints.map((point, index) => (
            <CircleMarker key={`${point[0]}-${point[1]}-${index}`} center={point} radius={3} pathOptions={{ color: "#fff", fillColor: "#39d0ff", fillOpacity: 1, weight: 1 }} />
          ))}
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
        <section className="panel drill-panel">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Trips</p>
              <h2>Recent runs and summaries</h2>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="status-pill status-pill--success">{tripHistory.length} trips</span>
              <button className="camera-fullscreen-btn" type="button" onClick={() => setTripMapFullscreen(true)}
                aria-label="Enter fullscreen trip map">⛶</button>
            </div>
          </div>

          <div className="trip-controls" style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
            {tripSession ? (
              <button type="button" className="action-btn action-btn--danger" onClick={stopTripSession}>Stop trip</button>
            ) : (
              <button type="button" className="action-btn" onClick={startTripSession}>Start trip</button>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 220, fontSize: 14 }}>
              <span>Home radius</span>
              <input
                type="range"
                min={0.05}
                max={2.5}
                step={0.05}
                value={tripHomeRadiusNm}
                onChange={(event) => setTripHomeRadiusNm(Number.parseFloat(event.target.value) || DEFAULT_TRIP_HOME_RADIUS_NM)}
                aria-label="Trip home radius in nautical miles"
              />
              <strong>{tripHomeRadiusNm.toFixed(2)} NM</strong>
            </label>
          </div>

          {tripDetail ? (
            <div className="trip-detail panel" style={{ marginBottom: 16, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                <div>
                  <p className="panel__eyebrow">Route detail</p>
                  <h3 style={{ margin: "4px 0 0" }}>{tripDetail.title}</h3>
                </div>
                <span className="trip-card__tag">{tripDetail.tag}</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
                <div><strong>{tripDetail.distanceNm.toFixed(2)}</strong><div>NM</div></div>
                <div><strong>{tripDetail.startedAt ? new Date(tripDetail.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--"}</strong><div>started</div></div>
                <div><strong>{tripDetail.endedAt ? new Date(tripDetail.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "live"}</strong><div>ended</div></div>
                <div><strong>{tripDetail.breadcrumbs.length}</strong><div>breadcrumbs</div></div>
                <div><strong>{tripDetail.averageSpeedKnots.toFixed(1)}</strong><div>avg kt</div></div>
                <div><strong>{tripDetail.averageRpmTotal.toFixed(0)}</strong><div>avg RPM</div></div>
                <div><strong>{tripDetail.maxEngineTempF.toFixed(0)}</strong><div>max eng temp F</div></div>
                <div><strong>{tripDetail.averageFuelBurnGph.toFixed(1)}</strong><div>avg gph</div></div>
              </div>
            </div>
          ) : null}

          <div className="trip-route-map-shell">
            {renderTripRouteMap("trip-route-map")}
          </div>

          {breadcrumbRows.length > 0 ? (
            <div className="panel" style={{ marginBottom: 16, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <p className="panel__eyebrow" style={{ margin: 0 }}>Breadcrumb data log</p>
                <span style={{ fontSize: 12, opacity: 0.75 }}>Most recent {breadcrumbRows.length} points</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
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
            {tripHistory.length > 0 ? tripHistory.map((trip) => (
              <TripSummaryCard
                key={trip.id || trip.title}
                trip={trip}
                selected={selectedTripId === trip.id || (!selectedTripId && trip.id === tripDetail?.id)}
                onSelect={setSelectedTripId}
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
          ? "Put the stereo in pairing mode, then tap scan."
          : `${btScanResults.length} device${btScanResults.length === 1 ? "" : "s"} found.`;

      return (
        <section className="panel drill-panel settings-kiosk">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Settings</p>
              <h2>System controls</h2>
            </div>
          </div>

          <div className="settings-kiosk__pager" role="tablist" aria-label="Settings pages">
            <button
              type="button"
              role="tab"
              aria-selected={settingsSubview === "bluetooth"}
              className={settingsSubview === "bluetooth" ? "settings-kiosk__pager-btn settings-kiosk__pager-btn--active" : "settings-kiosk__pager-btn"}
              onClick={() => setSettingsSubview("bluetooth")}
            >
              Bluetooth
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={settingsSubview === "wifi"}
              className={settingsSubview === "wifi" ? "settings-kiosk__pager-btn settings-kiosk__pager-btn--active" : "settings-kiosk__pager-btn"}
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
              onClick={() => setSettingsSubview("remote")}
            >
              Remote
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={settingsSubview === "updates"}
              className={settingsSubview === "updates" ? "settings-kiosk__pager-btn settings-kiosk__pager-btn--active" : "settings-kiosk__pager-btn"}
              onClick={() => setSettingsSubview("updates")}
            >
              Updates
            </button>
          </div>

          <div className="settings-kiosk__body">
            {settingsSubview === "bluetooth" ? (
              <>
                <div className="home-panel__quick-grid settings-kiosk__summary">
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
                  <button className="theme-toggle" type="button" onClick={() => void handleBluetoothAction("disconnect")} disabled={!bluetoothState.config.disconnectConfigured}>Disconnect</button>
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
    setKillingLaunchedApp(true);

    try {
      const state = await sendKillLaunchedAppRequest();
      setLauncherState(state);
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

  const isNativeRuntime = launcherState.runtime.trim().toLowerCase() === "native app process";
  const killTargetName = isNativeRuntime && launcherState.status === "Launched" ? launcherState.name : "";
  const killTargetLogoPath = isNativeRuntime && launcherState.status === "Launched"
    ? [...streamingTargets, ...musicTargets].find((target) => target.id === launcherState.appId)?.logoPath
    : undefined;

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
              onClick={() => setSelectedNavId(item.id)}
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
