export type BluetoothState = {
  status: string;
  device: string;
  audioRoute: string;
  connected: boolean;
  ready: boolean;
  config: {
    pairConfigured: boolean;
    reconnectConfigured: boolean;
    routeConfigured: boolean;
    disconnectConfigured: boolean;
    statusConfigured: boolean;
    missingCommands: string[];
  };
  lastAction: string;
  updatedAt: string;
  lastError: string | null;
};

export type AppDescriptor = {
  id: string;
  name: string;
  subtitle: string;
  launchMethod: string;
  status: string;
  description: string;
};

export type MetricDescriptor = {
  label: string;
  value: string;
  unit: string;
  accent: "aqua" | "teal" | "sand";
};

export type EngineDescriptor = {
  label: string;
  rpm: number;
  gph: number;
  tempF: number;
  voltage: number;
};

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

export type TripDescriptor = {
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

export type UpdateStatus = {
  currentVersion: string;
  channel: string;
  feedUrl: string;
  lastCheckedAt: string;
  latestVersion: string | null;
  available: boolean;
  notes: string;
};

export type BluetoothDiagnostics = {
  checkedAt: string;
  ready: boolean;
  checks: {
    id: string;
    ok: boolean;
    detail: string;
  }[];
};

export type WifiSecurity = "open" | "wep" | "wpa2" | "wpa3" | "wpa-wpa2" | "unknown";

export type WifiNetwork = {
  ssid: string;
  bssid: string;
  signal: number;
  security: WifiSecurity;
  connected: boolean;
  channel: number | null;
};

export type WifiJoinResult = {
  success: boolean;
  ssid: string;
  status: string;
  connected: boolean;
  message: string;
};

export type LauncherState = {
  appId: string;
  name: string;
  subtitle: string;
  runtime: string;
  status: string;
  message: string;
  launchMethod: string;
  startedAt: string;
};

export type FishingCatch = {
  id: string;
  species: string;
  bait: string;
  lureType?: string;
  lureColor?: string;
  fishSizeInches?: number | null;
  notes: string;
  timestamp: string;
  latitude: number | null;
  longitude: number | null;
  locationLabel: string;
  photo: string | null;
};

export type OceanBuoyObservation = {
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

export type FishingAdvisorZone = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  radiusNm: number;
  score: number;
  confidence: "high" | "medium" | "low";
  reasoning: string[];
};

export type FishingOceanSignalFront = {
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

export type FishingOceanSignals = {
  generatedAt: string;
  buoyCount: number;
  evaluatedPairs: number;
  fronts: FishingOceanSignalFront[];
};

export type FishingAdvisorResponse = {
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

export type SpeciesScoreFactor = {
  label: string;
  value: string;
  score: number;
};

export type SpeciesIntelEntry = {
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

export type AllSpeciesIntelResponse = {
  generatedAt: string;
  referenceLatitude: number | null;
  referenceLongitude: number | null;
  buoyCount: number;
  frontCount: number;
  species: SpeciesIntelEntry[];
  oceanSignals: FishingOceanSignals;
};

export type DashboardSummary = {
  vesselName: string;
  harbor: string;
  mode: string;
  connectivity: {
    network: string;
    camera: string;
    gps: string;
    nmea: string;
  };
  system: {
    uptime: string;
    storage: string;
    recording: string;
  };
  bluetooth: {
    status: string;
    device: string;
    audioRoute: string;
  };
  touchscreen: {
    status: string;
    resolution: string;
    calibration: string;
  };
  weather: {
    wind: string;
    barometer: string;
    waterTemp: string;
    tide: string;
  };
  update: UpdateStatus;
  camera: {
    label: string;
    status: string;
    recording: boolean;
    bufferMinutes: number;
    latencyMs: number;
  };
  metrics: MetricDescriptor[];
  engines: EngineDescriptor[];
  apps: AppDescriptor[];
  trips: TripDescriptor[];
  alerts: string[];
};

export type RemoteAccessStatus = {
  mode: "disabled" | "tailscale" | "cloudflared" | "custom";
  label: string;
  viewUrl: string;
  troubleshootUrl: string;
  status: string;
  connected: boolean;
  configured: boolean;
  lastCheckedAt: string;
  lastAction: string;
  lastOutput: string | null;
  commands: {
    statusConfigured: boolean;
    startConfigured: boolean;
    stopConfigured: boolean;
    restartConfigured: boolean;
  };
  notes: string;
};

export type RemoteUpdateStatus = {
  configured: boolean;
  running: boolean;
  command: string;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastSuccess: boolean | null;
  lastOutput: string | null;
  lastError: string | null;
  notes: string;
};
