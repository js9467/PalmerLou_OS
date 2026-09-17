import { exec, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type WifiSecurity = "open" | "wep" | "wpa2" | "wpa3" | "wpa-wpa2" | "unknown";

export type WifiNetwork = {
  ssid: string;
  bssid: string;
  signal: number;
  security: WifiSecurity;
  connected: boolean;
  channel: number | null;
};

function commandExists(command: string) {
  if (process.platform !== "linux") {
    return false;
  }

  const probe = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function normalizeSecurity(raw: string): WifiSecurity {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "--" || value === "none") {
    return "open";
  }

  if (value.includes("wpa3")) {
    return "wpa3";
  }

  if (value.includes("wpa2")) {
    return "wpa2";
  }

  if (value.includes("wpa") && value.includes("wpa2")) {
    return "wpa-wpa2";
  }

  if (value.includes("wep")) {
    return "wep";
  }

  if (value.includes("wpa")) {
    return "wpa2";
  }

  return "unknown";
}

function cleanCell(value: string | undefined) {
  return (value ?? "").trim();
}

function quoteShell(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function normalizeConnectionName(name: string) {
  return name.replace(/\s+\d+$/, "").trim();
}

function formatExecError(error: unknown) {
  if (!error || typeof error !== "object") {
    return "Unknown error";
  }

  const candidate = error as { message?: string; stdout?: string; stderr?: string };
  const combined = `${candidate.stdout ?? ""}\n${candidate.stderr ?? ""}`.trim();
  if (combined) {
    return combined;
  }

  return candidate.message ?? "Unknown error";
}

function sanitizeWifiError(detail: string) {
  const redacted = detail
    .replace(/password\s+"[^"]*"/gi, "password \"[redacted]\"")
    .replace(/password\s+\S+/gi, "password [redacted]")
    .replace(/Command failed:\s*nmcli[^\n]*/gi, "")
    .trim();

  if (/invalid secrets|wrong password|802-11-wireless-security\.psk|authentication/i.test(redacted)) {
    return "Incorrect Wi-Fi password.";
  }

  if (/No network with SSID|not found/i.test(redacted)) {
    return "Network not found. Scan and try again.";
  }

  if (/not authorized|permission denied/i.test(redacted)) {
    return "Network change blocked by host permissions.";
  }

  return redacted || "Unable to switch Wi-Fi network.";
}

async function loadActiveWifiConnectionName() {
  try {
    const { stdout } = await execAsync("nmcli -t -f NAME,TYPE connection show --active 2>/dev/null", {
      timeout: 8000,
      env: process.env
    });

    const activeWifi = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(":"))
      .find((parts) => {
        const type = (parts[1] ?? "").toLowerCase();
        return type.includes("wireless") || type.includes("wifi");
      });

    const rawName = (activeWifi?.[0] ?? "").trim();
    if (!rawName) {
      return null;
    }

    return {
      raw: rawName,
      normalized: normalizeConnectionName(rawName)
    };
  } catch {
    return null;
  }
}

export function parseNmcliWifiOutput(raw: string): WifiNetwork[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith("ssid") && !line.toLowerCase().startsWith("in-use") && !line.toLowerCase().startsWith("bssid"));

  const networks: WifiNetwork[] = [];

  for (const line of lines) {
    const normalizedLine = line.replace(/\\:/g, ":");
    const isColonDelimited = normalizedLine.includes(":") && !normalizedLine.includes("\t") && !/\s{2,}/.test(normalizedLine);

    let ssid = "";
    let bssid = "";
    let signalCell = "";
    let securityCell = "";
    let channelCell = "";
    let connected = false;

    if (isColonDelimited) {
      const firstColon = normalizedLine.indexOf(":");
      ssid = normalizedLine.slice(0, firstColon).trim();
      const rest = normalizedLine.slice(firstColon + 1).split(":");
      if (rest.length >= 10) {
        bssid = rest.slice(0, 6).join(":");
        signalCell = rest[6] ?? "";
        securityCell = rest[7] ?? "";
        channelCell = rest[8] ?? "";
        connected = rest[9] === "*" || normalizedLine.endsWith(":*");
      } else if (rest.length >= 8) {
        bssid = rest.slice(0, 6).join(":");
        signalCell = rest[6] ?? "";
        securityCell = rest[7] ?? "";
        channelCell = rest[8] ?? "";
      }
    } else {
      const columns = line.split(/\s{2,}|\t+/).map(cleanCell).filter(Boolean);
      if (columns.length < 4) {
        continue;
      }

      const maybeStarIndex = columns[0] === "*" ? 1 : 0;
      ssid = columns[maybeStarIndex] ?? "";
      bssid = columns[maybeStarIndex + 1] ?? "";
      signalCell = columns[maybeStarIndex + 2] ?? "";
      securityCell = columns[maybeStarIndex + 3] ?? "";
      channelCell = columns[maybeStarIndex + 4] ?? "";
      connected = columns[columns.length - 1] === "*" || columns[0] === "*" || line.trimStart().startsWith("*");
    }

    if (!ssid || !bssid || !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(bssid)) {
      continue;
    }

    const signal = Number.parseInt(signalCell.replace(/%/g, ""), 10);

    networks.push({
      ssid,
      bssid,
      signal: Number.isFinite(signal) ? signal : 0,
      security: normalizeSecurity(securityCell),
      connected,
      channel: channelCell && /^\d+$/.test(channelCell) ? Number.parseInt(channelCell, 10) : null
    });
  }

  const deduped = new Map<string, WifiNetwork>();
  for (const network of networks) {
    if (!network.ssid || network.ssid === "--") {
      continue;
    }

    const key = network.ssid;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, network);
      continue;
    }

    const preferCandidate = (
      network.connected && !existing.connected
    ) || (
      network.connected === existing.connected && network.signal > existing.signal
    );

    if (preferCandidate) {
      deduped.set(key, network);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => (b.connected === a.connected ? b.signal - a.signal : Number(b.connected) - Number(a.connected)));
}

export async function scanWifiNetworks(rescan = false): Promise<{ networks: WifiNetwork[] }> {
  if (!commandExists("nmcli")) {
    return { networks: [] };
  }

  try {
    const rescanMode = rescan ? "yes" : "no";
    const { stdout } = await execAsync(`nmcli -t -f SSID,BSSID,SIGNAL,SECURITY,CHAN,IN-USE dev wifi list --rescan ${rescanMode} 2>/dev/null`, {
      timeout: 20000,
      env: process.env
    });

    const parsed = parseNmcliWifiOutput(stdout);
    if (parsed.some((network) => network.connected)) {
      return { networks: parsed };
    }

    const activeWifi = await loadActiveWifiConnectionName();
    if (!activeWifi) {
      return { networks: parsed };
    }

    const matched = parsed.find((network) => (
      network.ssid === activeWifi.raw
      || network.ssid === activeWifi.normalized
      || activeWifi.raw.startsWith(`${network.ssid} `)
    ));

    if (matched) {
      const withConnected = parsed.map((network) => ({
        ...network,
        connected: network.ssid === matched.ssid
      }));

      return {
        networks: withConnected.sort((a, b) => (b.connected === a.connected ? b.signal - a.signal : Number(b.connected) - Number(a.connected)))
      };
    }

    return {
      networks: [
        {
          ssid: activeWifi.normalized || activeWifi.raw,
          bssid: "00:00:00:00:00:00",
          signal: 0,
          security: "unknown",
          connected: true,
          channel: null
        },
        ...parsed
      ]
    };
  } catch {
    const activeWifi = await loadActiveWifiConnectionName();
    if (!activeWifi) {
      return { networks: [] };
    }

    return {
      networks: [
        {
          ssid: activeWifi.normalized || activeWifi.raw,
          bssid: "00:00:00:00:00:00",
          signal: 0,
          security: "unknown",
          connected: true,
          channel: null
        }
      ]
    };
  }
}

export async function joinWifiNetwork(ssid: string, password?: string) {
  const cleanSsid = ssid.trim();
  if (!cleanSsid) {
    return {
      success: false,
      ssid: cleanSsid,
      status: "No network selected",
      connected: false,
      message: "Select a Wi‑Fi network before trying to connect."
    };
  }

  if (!commandExists("nmcli")) {
    return {
      success: false,
      ssid: cleanSsid,
      status: "Wi‑Fi unavailable",
      connected: false,
      message: "NetworkManager is not available on this host."
    };
  }

  const safePassword = (password ?? "").replace(/"/g, '\\"');

  const buildConnectCommand = () => {
    if (safePassword) {
      return `nmcli dev wifi connect ${quoteShell(cleanSsid)} password ${quoteShell(safePassword)} 2>&1`;
    }

    return `nmcli dev wifi connect ${quoteShell(cleanSsid)} 2>&1`;
  };

  const isActiveTarget = async () => {
    const activeWifi = await loadActiveWifiConnectionName();
    const connected = !!activeWifi
      && (
        activeWifi.raw === cleanSsid
        || activeWifi.normalized === cleanSsid
        || activeWifi.raw.startsWith(`${cleanSsid} `)
      );

    return {
      connected,
      activeLabel: activeWifi?.normalized || activeWifi?.raw || "none"
    };
  };

  const removeStaleProfiles = async () => {
    try {
      const { stdout } = await execAsync("nmcli -t -f NAME connection show 2>/dev/null", {
        timeout: 10000,
        env: process.env
      });

      const matches = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((name) => normalizeConnectionName(name) === cleanSsid);

      for (const name of matches) {
        await execAsync(`nmcli connection delete id ${quoteShell(name)} 2>&1`, {
          timeout: 10000,
          env: process.env
        }).catch(() => undefined);
      }
    } catch {
      // Ignore stale profile cleanup errors; we still return a clear join failure if retry does not work.
    }
  };

  let lastOutput = "";

  try {
    const { stdout, stderr } = await execAsync(buildConnectCommand(), { timeout: 30000, env: process.env });
    lastOutput = `${stdout}\n${stderr}`.trim();
  } catch (error) {
    lastOutput = formatExecError(error);

    if (/key-mgmt: property is missing/i.test(lastOutput)) {
      await removeStaleProfiles();

      try {
        const retry = await execAsync(buildConnectCommand(), { timeout: 30000, env: process.env });
        lastOutput = `${retry.stdout}\n${retry.stderr}`.trim();
      } catch (retryError) {
        lastOutput = formatExecError(retryError);
      }
    }
  }

  const active = await isActiveTarget();
  if (active.connected) {
    return {
      success: true,
      ssid: cleanSsid,
      status: "Connected",
      connected: true,
      message: lastOutput.trim() || `Connected to ${cleanSsid}.`
    };
  }

  const detail = sanitizeWifiError(lastOutput);
  return {
    success: false,
    ssid: cleanSsid,
    status: "Connection failed",
    connected: false,
    message: `${detail} Active network remains ${active.activeLabel}.`
  };
}

export async function disconnectWifiNetwork(ssid?: string) {
  if (!commandExists("nmcli")) {
    return {
      success: false,
      ssid: ssid?.trim() ?? "",
      status: "Wi‑Fi unavailable",
      connected: false,
      message: "NetworkManager is not available on this host."
    };
  }

  const requestedSsid = (ssid ?? "").trim();

  try {
    let targetConnection = requestedSsid;

    if (!targetConnection) {
      const { stdout } = await execAsync("nmcli -t -f NAME,TYPE connection show --active 2>/dev/null", {
        timeout: 10000,
        env: process.env
      });

      const activeWifi = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(":"))
        .find((parts) => {
          const type = (parts[1] ?? "").toLowerCase();
          return type.includes("wireless") || type.includes("wifi");
        });

      targetConnection = (activeWifi?.[0] ?? "").trim();
    }

    if (!targetConnection) {
      return {
        success: true,
        ssid: "",
        status: "Already disconnected",
        connected: false,
        message: "No active Wi‑Fi connection to disconnect."
      };
    }

    const { stdout, stderr } = await execAsync(`nmcli connection down id ${quoteShell(targetConnection)} 2>&1`, {
      timeout: 15000,
      env: process.env
    });

    const output = `${stdout}\n${stderr}`.trim();
    const success = /successfully|deactivated|disconnected|is not active/i.test(output);

    return {
      success,
      ssid: targetConnection,
      status: success ? "Disconnected" : "Disconnect failed",
      connected: false,
      message: output || (success ? `Disconnected from ${targetConnection}.` : `Unable to disconnect ${targetConnection}.`)
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      ssid: requestedSsid,
      status: "Disconnect failed",
      connected: false,
      message: detail || "Unable to disconnect Wi‑Fi network."
    };
  }
}
