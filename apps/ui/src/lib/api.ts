import type { DashboardSummary, FishingAdvisorResponse, AllSpeciesIntelResponse, OceanBuoyObservation, RemoteAccessStatus, RemoteUpdateStatus, BluetoothState, WifiJoinResult, WifiNetwork } from "../types";

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function loadSystemTime() {
  const response = await fetch("/api/time", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load system time: ${response.status}`);
  }

  return response.json() as Promise<{
    iso: string;
    epochMs: number;
    locale: string;
    timeZone: string;
    label: string;
  }>;
}

export async function loadBluetoothState() {
  const response = await fetch("/api/bluetooth", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load Bluetooth state: ${response.status}`);
  }

  return response.json() as Promise<{
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
  }>;
}

export async function sendBluetoothAction(
  action: "pair" | "reconnect" | "route-audio" | "disconnect",
  options?: { mac?: string; name?: string }
) {
  const response = await fetch("/api/bluetooth/action", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action, ...(options ?? {}) })
  });

  if (!response.ok) {
    throw new Error(`Failed to send Bluetooth action: ${response.status}`);
  }

  return response.json() as Promise<{
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
  }>;
}

export async function runBluetoothDiagnostics() {
  const response = await fetch("/api/bluetooth/diagnostics", {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to run Bluetooth diagnostics: ${response.status}`);
  }

  return response.json() as Promise<{
    checkedAt: string;
    ready: boolean;
    checks: {
      id: string;
      ok: boolean;
      detail: string;
    }[];
  }>;
}

export async function scanBluetoothDevices(): Promise<{ devices: Array<{ mac: string; name: string }> }> {
  const response = await fetch("/api/bluetooth/scan");
  if (!response.ok) {
    throw new Error(`Bluetooth scan failed: ${response.status}`);
  }
  return response.json() as Promise<{ devices: Array<{ mac: string; name: string }> }>;
}

export async function configureBluetoothDevice(mac: string, name: string): Promise<BluetoothState> {
  const response = await fetch("/api/bluetooth/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac, name })
  });
  if (!response.ok) {
    throw new Error(`Bluetooth configure failed: ${response.status}`);
  }
  return response.json() as Promise<BluetoothState>;
}

export async function loadWifiNetworks(scan = false): Promise<{ networks: WifiNetwork[] }> {
  const response = await fetchWithTimeout(scan ? "/api/wifi?scan=1" : "/api/wifi", {
    headers: {
      Accept: "application/json"
    }
  }, 15000);

  if (!response.ok) {
    throw new Error(`Failed to load Wi‑Fi networks: ${response.status}`);
  }

  return response.json() as Promise<{ networks: WifiNetwork[] }>;
}

export async function joinWifiNetwork(ssid: string, password?: string): Promise<WifiJoinResult> {
  const response = await fetchWithTimeout("/api/wifi/connect", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ssid, password: password ?? "" })
  }, 35000);

  if (!response.ok) {
    throw new Error(`Failed to join Wi‑Fi network: ${response.status}`);
  }

  return response.json() as Promise<WifiJoinResult>;
}

export async function disconnectWifiNetwork(ssid?: string): Promise<WifiJoinResult> {
  const response = await fetchWithTimeout("/api/wifi/disconnect", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ssid: ssid ?? "" })
  }, 20000);

  if (!response.ok) {
    throw new Error(`Failed to disconnect Wi‑Fi network: ${response.status}`);
  }

  return response.json() as Promise<WifiJoinResult>;
}

export async function loadLauncherState() {
  const response = await fetch("/api/launcher", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load launcher state: ${response.status}`);
  }

  return response.json() as Promise<{
    appId: string;
    name: string;
    subtitle: string;
    runtime: string;
    status: string;
    message: string;
    launchMethod: string;
    startedAt: string;
  }>;
}

export async function sendLaunchRequest(payload: {
  appId: string;
  name: string;
  launchUrl: string;
  launchLabel: string;
  requestSource?: "kiosk" | "remote";
}) {
  const response = await fetch("/api/launch/app", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to launch app: ${response.status}`);
  }

  return response.json() as Promise<{
    appId: string;
    name: string;
    subtitle: string;
    runtime: string;
    status: string;
    message: string;
    launchMethod: string;
    startedAt: string;
  }>;
}

export async function sendReturnHomeRequest() {
  const response = await fetch("/api/launch/return", {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to return home: ${response.status}`);
  }

  return response.json() as Promise<{
    appId: string;
    name: string;
    subtitle: string;
    runtime: string;
    status: string;
    message: string;
    launchMethod: string;
    startedAt: string;
  }>;
}

export async function sendKillLaunchedAppRequest() {
  const response = await fetch("/api/launch/kill", {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to kill launched app: ${response.status}`);
  }

  return response.json() as Promise<{
    appId: string;
    name: string;
    subtitle: string;
    runtime: string;
    status: string;
    message: string;
    launchMethod: string;
    startedAt: string;
  }>;
}

export async function loadVersionStatus() {
  const response = await fetch("/api/update/check", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load version status: ${response.status}`);
  }

  return response.json() as Promise<DashboardSummary["update"]>;
}

export async function loadSummary(): Promise<DashboardSummary> {
  const response = await fetch("/api/summary", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load summary: ${response.status}`);
  }

  return response.json() as Promise<DashboardSummary>;
}

export async function loadRemoteAccessStatus() {
  const response = await fetch("/api/remote/access", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load remote access status: ${response.status}`);
  }

  return response.json() as Promise<RemoteAccessStatus>;
}

export async function sendRemoteTunnelAction(action: "start" | "stop" | "restart" | "status") {
  const response = await fetch("/api/remote/access/action", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action })
  });

  if (!response.ok) {
    throw new Error(`Failed to run remote tunnel action: ${response.status}`);
  }

  return response.json() as Promise<RemoteAccessStatus>;
}

export async function loadRemoteUpdateStatus() {
  const response = await fetch("/api/remote/update", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load remote update status: ${response.status}`);
  }

  return response.json() as Promise<RemoteUpdateStatus>;
}

export async function runRemoteUpdateApply() {
  const response = await fetch("/api/remote/update/apply", {
    method: "POST",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to run remote update apply: ${response.status}`);
  }

  return response.json() as Promise<RemoteUpdateStatus>;
}

export async function sendRemoteControlAction(action: "up" | "down" | "left" | "right" | "select" | "back" | "home" | "playpause" | "volup" | "voldown" | "mute", repeat = 1) {
  const response = await fetch("/api/remote/control/action", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action, repeat })
  });

  if (!response.ok) {
    throw new Error(`Failed remote control action: ${response.status}`);
  }

  return response.json() as Promise<{
    action: string;
    command: string;
    configured: boolean;
    success: boolean;
    status: string;
    output: string | null;
    executedAt: string;
  }>;
}

export async function loadOceanBuoys(bounds: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  limit?: number;
}) {
  const query = new URLSearchParams({
    minLat: bounds.minLat.toString(),
    maxLat: bounds.maxLat.toString(),
    minLng: bounds.minLng.toString(),
    maxLng: bounds.maxLng.toString(),
    limit: String(bounds.limit ?? 64)
  });

  const response = await fetch(`/api/ocean/buoys?${query.toString()}`, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load ocean buoys: ${response.status}`);
  }

  return response.json() as Promise<{
    generatedAt: string;
    source: string;
    count: number;
    buoys: OceanBuoyObservation[];
  }>;
}

export async function requestFishingAdvisor(payload: {
  species: string;
  catches: Array<{
    species: string;
    bait: string;
    timestamp: string;
    latitude: number | null;
    longitude: number | null;
  }>;
  buoys: OceanBuoyObservation[];
  referenceLatitude?: number;
  referenceLongitude?: number;
  maxRadiusNm?: number;
}) {
  const response = await fetch("/api/fishing/advisor", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to run fishing advisor: ${response.status}`);
  }

  return response.json() as Promise<FishingAdvisorResponse>;
}

export async function loadSpeciesIntel(payload: {
  catches: Array<{
    species: string;
    bait: string;
    timestamp: string;
    latitude: number | null;
    longitude: number | null;
  }>;
  buoys: OceanBuoyObservation[];
  referenceLatitude?: number;
  referenceLongitude?: number;
  maxRadiusNm?: number;
}) {
  const response = await fetch("/api/fishing/species-intel", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to load species intel: ${response.status}`);
  }

  return response.json() as Promise<AllSpeciesIntelResponse>;
}
