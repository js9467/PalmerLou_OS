import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { spawnSync } from "node:child_process";

const execAsync = promisify(exec);

export type BluetoothScannedDevice = { mac: string; name: string };

export type BluetoothAction = "pair" | "reconnect" | "route-audio" | "disconnect";

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

export type BluetoothDiagnostics = {
  checkedAt: string;
  ready: boolean;
  checks: {
    id: string;
    ok: boolean;
    detail: string;
  }[];
};

type BluetoothConfig = BluetoothState["config"] & {
  ready: boolean;
};

type ResolvedCommand = {
  configured: boolean;
  id: string;
  command?: string;
  source: "hardcoded" | "missing";
  reason: string;
};

function readConfiguredDeviceName() {
  return process.env.PALMER_LOU_BT_DEVICE_NAME?.trim() || "Vessel Stereo";
}

function readConfiguredDeviceMac() {
  return process.env.PALMER_LOU_BT_DEVICE_MAC?.trim() ?? "";
}

function resolveBluetoothDeviceLabel() {
  const configuredDeviceName = readConfiguredDeviceName();
  const configuredDeviceMac = readConfiguredDeviceMac();

  if (configuredDeviceName && configuredDeviceName.trim().length > 0) {
    return configuredDeviceName.trim();
  }

  if (configuredDeviceMac && configuredDeviceMac.trim().length > 0) {
    return `Stereo ${configuredDeviceMac.trim()}`;
  }

  return "Unconfigured stereo";
}

function isConfigured(command: string | undefined) {
  return typeof command === "string" && command.trim().length > 0;
}

function timeoutForCommandId(id: string) {
  switch (id) {
    case "pair-command":
      return 20000;
    case "reconnect-command":
      return 18000;
    case "route-command":
      return 15000;
    case "disconnect-command":
      return 12000;
    case "status-command":
      return 7000;
    default:
      return 12000;
  }
}

function commandExists(command: string) {
  if (process.platform !== "linux") {
    return false;
  }

  const probe = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function resolveBuiltinCommand(action: BluetoothAction, mac: string) {
  if (!commandExists("bluetoothctl")) {
    return null;
  }

  if (action === "pair") {
    return `bluetoothctl power on; bluetoothctl pairable on; bluetoothctl discoverable on; bluetoothctl agent on; bluetoothctl default-agent; bluetoothctl pair \"${mac}\"; bluetoothctl trust \"${mac}\"; bluetoothctl connect \"${mac}\"`;
  }

  if (action === "reconnect") {
    return `bluetoothctl power on; bluetoothctl trust \"${mac}\"; bluetoothctl connect \"${mac}\"`;
  }

    if (action === "disconnect") {
      return `bluetoothctl disconnect "${mac}" >/dev/null 2>&1 || true; bluetoothctl untrust "${mac}" >/dev/null 2>&1 || true; bluetoothctl remove "${mac}" >/dev/null 2>&1 || true; if bluetoothctl info "${mac}" >/dev/null 2>&1; then echo "Bluetooth device still present after remove: ${mac}" >&2; exit 1; fi; echo removed`;
  }

  if (action === "route-audio") {
    const hasWpctl = commandExists("wpctl");
    const hasPactl = commandExists("pactl");

    if (!hasWpctl && !hasPactl) {
      return `DEVICE_MAC="${mac}"; bluetoothctl power on; bluetoothctl connect "$DEVICE_MAC" >/dev/null 2>&1 || true; bluetoothctl info "$DEVICE_MAC" | grep -qi "Connected: yes" && echo connected || (echo "Bluetooth connect failed for $DEVICE_MAC" >&2; exit 1)`;
    }

    return `DEVICE_MAC="${mac}"; RUN_AS_USER="${(process.env.PALMER_LOU_LAUNCH_USER ?? "palmerlou").trim() || "palmerlou"}"; AUDIO_RUNTIME_DIR="${(process.env.PALMER_LOU_LAUNCH_XDG_RUNTIME_DIR ?? "/run/user/1000").trim() || "/run/user/1000"}"; bluetoothctl power on; bluetoothctl connect "$DEVICE_MAC" >/dev/null 2>&1 || true; if bluetoothctl info "$DEVICE_MAC" | grep -qi "Connected: yes"; then :; else echo "Bluetooth connect failed for $DEVICE_MAC" >&2; exit 1; fi; SINK_PATTERN="bluez_output.${mac.replaceAll(":", "_")}"; WPCTL_CMD=""; PACTL_CMD=""; if command -v wpctl >/dev/null 2>&1; then WPCTL_CMD="sudo -u $RUN_AS_USER XDG_RUNTIME_DIR=$AUDIO_RUNTIME_DIR wpctl"; fi; if command -v pactl >/dev/null 2>&1; then PACTL_CMD="sudo -u $RUN_AS_USER XDG_RUNTIME_DIR=$AUDIO_RUNTIME_DIR pactl"; fi; if [ -n "$WPCTL_CMD" ]; then SINK_ID=$(eval "$WPCTL_CMD status" 2>/dev/null | grep -Ei "$SINK_PATTERN(\\.a2dp)?" | head -n1 | sed -E 's/.* ([0-9]+)\\..*/\\1/' || true); if [ -n "$SINK_ID" ]; then eval "$WPCTL_CMD set-default $SINK_ID" || true; eval "$WPCTL_CMD set-mute $SINK_ID 0" || true; fi; fi; if [ -n "$PACTL_CMD" ]; then SINK_NAME=$(eval "$PACTL_CMD list short sinks" 2>/dev/null | awk '{print $2}' | grep -Ei "$SINK_PATTERN(\\.a2dp)?" | head -n1 || true); if [ -n "$SINK_NAME" ]; then eval "$PACTL_CMD set-default-sink $SINK_NAME" || true; eval "$PACTL_CMD set-sink-mute $SINK_NAME 0" || true; fi; fi; echo connected; exit 0`;
  }

  return null;
}

function resolveBuiltinStatusCommand(mac: string) {
  if (!commandExists("bluetoothctl")) {
    return null;
  }

  return `bluetoothctl info \"${mac}\" | grep -qi \"Connected: yes\" && echo connected || echo not connected`;
}

function resolveActionCommand(action: BluetoothAction, targetMac?: string): ResolvedCommand {
  const idMap: Record<BluetoothAction, string> = {
    pair: "pair-command",
    reconnect: "reconnect-command",
    "route-audio": "route-command",
    disconnect: "disconnect-command"
  };

  const mac = (targetMac?.trim() || readConfiguredDeviceMac()).trim();
  if (process.platform !== "linux") {
    return {
      configured: false,
      id: idMap[action],
      source: "missing",
      reason: `Bluetooth ${action} requires Linux runtime`
    };
  }

  if (!mac) {
    return {
      configured: false,
      id: idMap[action],
      source: "missing",
      reason: `No Bluetooth device MAC configured for ${action}`
    };
  }

  const builtin = resolveBuiltinCommand(action, mac);
  if (builtin) {
    return {
      configured: true,
      id: idMap[action],
      command: builtin,
      source: "hardcoded",
      reason: `Using built-in Linux ${action} command`
    };
  }

  return {
    configured: false,
    id: idMap[action],
    source: "missing",
    reason: `Required Bluetooth tools are unavailable for ${action}`
  };
}

function resolveStatusCommand(): ResolvedCommand {
  const id = "status-command";

  const mac = readConfiguredDeviceMac().trim();
  if (process.platform !== "linux") {
    return {
      configured: false,
      id,
      source: "missing",
      reason: "Bluetooth status requires Linux runtime"
    };
  }

  if (!mac) {
    return {
      configured: false,
      id,
      source: "missing",
      reason: "No Bluetooth device MAC configured for status checks"
    };
  }

  const builtin = resolveBuiltinStatusCommand(mac);
  if (builtin) {
    return {
      configured: true,
      id,
      command: builtin,
      source: "hardcoded",
      reason: "Using built-in Linux status command"
    };
  }

  return {
    configured: false,
    id,
    source: "missing",
    reason: "Required Bluetooth tools are unavailable for status checks"
  };
}

function getBluetoothConfig() {
  const pairResolver = resolveActionCommand("pair");
  const reconnectResolver = resolveActionCommand("reconnect");
  const routeResolver = resolveActionCommand("route-audio");
  const disconnectResolver = resolveActionCommand("disconnect");
  const statusResolver = resolveStatusCommand();

  const pairConfigured = pairResolver.configured;
  const reconnectConfigured = reconnectResolver.configured;
  const routeConfigured = routeResolver.configured;
  const disconnectConfigured = disconnectResolver.configured;
  const statusConfigured = statusResolver.configured;

  const missingCommands: string[] = [];
  if (!pairConfigured) {
    missingCommands.push(pairResolver.id);
  }
  if (!reconnectConfigured) {
    missingCommands.push(reconnectResolver.id);
  }
  if (!routeConfigured) {
    missingCommands.push(routeResolver.id);
  }
  if (!disconnectConfigured) {
    missingCommands.push(disconnectResolver.id);
  }
  if (!statusConfigured) {
    missingCommands.push(statusResolver.id);
  }

  return {
    pairConfigured,
    reconnectConfigured,
    routeConfigured,
    disconnectConfigured,
    statusConfigured,
    missingCommands,
    ready: missingCommands.length === 0
  };
}

function resolveAudioRouteLabel(config: BluetoothConfig, connected: boolean) {
  const configuredMac = readConfiguredDeviceMac().trim();
  if (!configuredMac) {
    return "Select stereo to enable audio routing";
  }

  if (!config.routeConfigured) {
    return "Route command missing";
  }

  if (!config.statusConfigured) {
    return connected ? "Route active (status unverified)" : "Route status unverified";
  }

  return connected ? "Stereo route active" : "Not routed";
}

let bluetoothState: BluetoothState = {
  status: getBluetoothConfig().ready ? "Ready" : "Bluetooth not configured",
  device: resolveBluetoothDeviceLabel(),
  audioRoute: resolveAudioRouteLabel(getBluetoothConfig(), false),
  connected: false,
  ready: getBluetoothConfig().ready,
  config: getBluetoothConfig(),
  lastAction: "Idle",
  updatedAt: new Date().toISOString(),
  lastError: getBluetoothConfig().ready ? null : "Bluetooth commands are not fully configured"
};

async function runCommand(command: string | undefined, timeoutMs = 12000) {
  if (!command || command.trim().length === 0) {
    throw new Error("Bluetooth command is not configured");
  }

  const result = await execAsync(command, {
    timeout: timeoutMs,
    windowsHide: true
  });

  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

async function runResolvedCommand(resolved: ResolvedCommand) {
  if (!resolved.configured || !resolved.command) {
    throw new Error(`${resolved.id} is unavailable`);
  }

  return runCommand(resolved.command, timeoutForCommandId(resolved.id));
}

function parseConnected(output: string) {
  const normalized = output.toLowerCase();

  if (/(^|\W)(disconnected|not connected|false|no|down|offline)(\W|$)/.test(normalized)) {
    return false;
  }

  if (/(^|\W)(connected|true|yes|up|online)(\W|$)/.test(normalized)) {
    return true;
  }

  return null;
}

async function readConnectedState() {
  const statusResolver = resolveStatusCommand();
  if (!statusResolver.configured || !statusResolver.command) {
    return null;
  }

  const output = await runResolvedCommand(statusResolver);
  if (!output) {
    return null;
  }

  return parseConnected(output);
}

export async function getBluetoothState() {
  const config = getBluetoothConfig();

  try {
    const connected = config.statusConfigured ? await readConnectedState() : null;
    if (connected !== null) {
      bluetoothState = {
        ...bluetoothState,
        status: config.ready ? bluetoothState.status : "Bluetooth not configured",
        device: resolveBluetoothDeviceLabel(),
        audioRoute: resolveAudioRouteLabel(config, connected),
        connected,
        ready: config.ready,
        config,
        updatedAt: new Date().toISOString(),
        lastError: config.ready ? null : "Bluetooth commands are not fully configured"
      };
    } else {
      bluetoothState = {
        ...bluetoothState,
        status: config.ready ? bluetoothState.status : "Bluetooth not configured",
        device: resolveBluetoothDeviceLabel(),
        audioRoute: resolveAudioRouteLabel(config, false),
        connected: false,
        ready: config.ready,
        config,
        updatedAt: new Date().toISOString(),
        lastError: config.ready ? bluetoothState.lastError : "Bluetooth commands are not fully configured"
      };
    }
  } catch (error) {
    bluetoothState = {
      ...bluetoothState,
      status: config.ready ? bluetoothState.status : "Bluetooth not configured",
      device: resolveBluetoothDeviceLabel(),
      audioRoute: resolveAudioRouteLabel(config, false),
      connected: false,
      ready: config.ready,
      config,
      lastError: error instanceof Error ? error.message : "Unknown Bluetooth status error",
      updatedAt: new Date().toISOString()
    };
  }

  return bluetoothState;
}

export async function applyBluetoothAction(action: BluetoothAction, targetMac?: string, targetName?: string) {
  const actionLabel: Record<BluetoothAction, string> = {
    pair: "Pair requested",
    reconnect: "Reconnect requested",
    "route-audio": "Audio routed to stereo",
    disconnect: "Disconnected"
  };

  const normalizedTargetMac = (targetMac ?? "").trim().toUpperCase();
  const normalizedTargetName = (targetName ?? "").trim();

  if (action === "pair" && normalizedTargetMac) {
    await configureBluetoothDevice(normalizedTargetMac, normalizedTargetName || `Stereo ${normalizedTargetMac}`);
  }

  const config = getBluetoothConfig();

  const actionResolverMap: Record<BluetoothAction, ResolvedCommand> = {
    pair: resolveActionCommand("pair", normalizedTargetMac),
    reconnect: resolveActionCommand("reconnect"),
    "route-audio": resolveActionCommand("route-audio"),
    disconnect: resolveActionCommand("disconnect")
  };

  if (!actionResolverMap[action].configured) {
    bluetoothState = {
      ...bluetoothState,
      status: "Bluetooth not configured",
      device: resolveBluetoothDeviceLabel(),
      audioRoute: resolveAudioRouteLabel(config, false),
      connected: false,
      ready: config.ready,
      config,
      lastAction: actionLabel[action],
      updatedAt: new Date().toISOString(),
      lastError: `${actionResolverMap[action].id} is unavailable`
    };

    return bluetoothState;
  }

  try {
    await runResolvedCommand(actionResolverMap[action]);

    const connectedState = config.statusConfigured ? await readConnectedState() : null;
    const connected = connectedState !== null ? connectedState : false;

    bluetoothState = {
      status: config.ready ? actionLabel[action] : "Bluetooth not configured",
      device: resolveBluetoothDeviceLabel(),
      audioRoute: action === "disconnect" ? "Not routed" : resolveAudioRouteLabel(config, connected),
      connected,
      ready: config.ready,
      config,
      lastAction: actionLabel[action],
      updatedAt: new Date().toISOString(),
      lastError: config.ready ? null : "Bluetooth commands are not fully configured"
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown Bluetooth error";
    const notConfigured = detail.toLowerCase().includes("not configured");
    const connectedState = await readConnectedState().catch(() => null);
    const connected = connectedState === true;

    bluetoothState = {
      ...bluetoothState,
      status: notConfigured ? "Bluetooth not configured" : `Bluetooth action failed: ${actionLabel[action]}`,
      device: resolveBluetoothDeviceLabel(),
      audioRoute: resolveAudioRouteLabel(config, connected),
      lastAction: actionLabel[action],
      connected,
      ready: config.ready,
      config,
      updatedAt: new Date().toISOString(),
      lastError: detail
    };
  }

  return bluetoothState;
}

export async function runBluetoothDiagnostics(): Promise<BluetoothDiagnostics> {
  const checks: BluetoothDiagnostics["checks"] = [];
  const config = getBluetoothConfig();
  const pairResolver = resolveActionCommand("pair");
  const reconnectResolver = resolveActionCommand("reconnect");
  const routeResolver = resolveActionCommand("route-audio");
  const disconnectResolver = resolveActionCommand("disconnect");
  const statusResolver = resolveStatusCommand();

  const mac = readConfiguredDeviceMac();
  checks.push({
    id: "device-mac",
    ok: true,
    detail: `Hardcoded stereo MAC: ${mac?.trim() ?? "unset"}`
  });

  checks.push({
    id: "pair-command",
    ok: config.pairConfigured,
    detail: config.pairConfigured ? pairResolver.reason : pairResolver.reason
  });

  checks.push({
    id: "reconnect-command",
    ok: config.reconnectConfigured,
    detail: config.reconnectConfigured ? reconnectResolver.reason : reconnectResolver.reason
  });

  checks.push({
    id: "route-command",
    ok: config.routeConfigured,
    detail: config.routeConfigured ? routeResolver.reason : routeResolver.reason
  });

  checks.push({
    id: "disconnect-command",
    ok: config.disconnectConfigured,
    detail: config.disconnectConfigured ? disconnectResolver.reason : disconnectResolver.reason
  });

  checks.push({
    id: "status-command",
    ok: config.statusConfigured,
    detail: config.statusConfigured ? statusResolver.reason : statusResolver.reason
  });

  if (config.statusConfigured) {
    try {
      const connected = await readConnectedState();
      checks.push({
        id: "status-read",
        ok: connected !== null,
        detail: connected === null
          ? "Status command ran but did not return a recognizable connected or disconnected value"
          : connected
            ? "Status command reports connected"
            : "Status command reports not connected"
      });
    } catch (error) {
      checks.push({
        id: "status-read",
        ok: false,
        detail: error instanceof Error ? error.message : "Status command failed"
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    ready: checks.every((check) => check.ok),
    checks
  };
}

export async function scanBluetoothDevices(): Promise<BluetoothScannedDevice[]> {
  if (process.platform !== "linux") {
    return [];
  }
  try {
    await execAsync("bluetoothctl power on 2>/dev/null || true");
    await execAsync("bluetoothctl pairable on 2>/dev/null || true");
    await execAsync("bluetoothctl discoverable on 2>/dev/null || true");

    // Seed results with already-paired/known devices so they always appear even when not broadcasting.
    const knownOutput = await execAsync("bluetoothctl devices 2>/dev/null").then((r) => r.stdout).catch(() => "");
    const seeded = new Map<string, BluetoothScannedDevice>();
    for (const line of knownOutput.split("\n")) {
      const m = line.match(/^Device\s+((?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+(.+)$/);
      if (m) {
        const mac = (m[1] ?? "").toUpperCase();
        const name = (m[2] ?? "").trim() || mac;
        if (mac) seeded.set(mac, { mac, name });
      }
    }

    // Give adapter a little more time to discover nearby devices.
    const scanOutput = await runCommand("timeout 12 bluetoothctl --timeout 10 scan on 2>&1", 15000).catch(() => "");

    const discovered = new Map<string, BluetoothScannedDevice>(seeded);
    const normalizedOutput = scanOutput
      .replace(/\x1B\[[0-9;]*m/g, "")
      .replace(/\r/g, "");
    const lines = normalizedOutput.split("\n");

    lines.forEach((line) => {
      const eventMatch = line.match(/^\[(NEW|CHG)\]\s+Device\s+((?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})(?:\s+(.+))?$/);
      if (!eventMatch) {
        return;
      }

      const eventType = eventMatch[1] ?? "";
      const mac = (eventMatch[2] ?? "").toUpperCase();
      if (!mac) {
        return;
      }

      // Keep the latest friendly label seen during this scan window.
      const label = (eventMatch[3] ?? "").trim();
      const prior = discovered.get(mac);

      const isNameField = /^(Name:|Alias:)\s*/i.test(label);
      const looksLikePropertyUpdate = /^[A-Za-z][A-Za-z0-9._-]*:\s*/.test(label) && !isNameField;

      const directName = isNameField
        ? label.replace(/^(Name:|Alias:)\s*/i, "").trim()
        : label;

      let name = prior?.name ?? mac;
      if (directName && !looksLikePropertyUpdate) {
        name = directName;
      } else if (!prior && eventType === "NEW") {
        name = mac;
      }

      discovered.set(mac, { mac, name: name || mac });
    });

    return [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function configureBluetoothDevice(mac: string, name: string): Promise<void> {
  process.env.PALMER_LOU_BT_DEVICE_MAC = mac.toUpperCase();
  process.env.PALMER_LOU_BT_DEVICE_NAME = name;

  const envFile = "/etc/palmer-lou/backend.env";
  try {
    let content = readFileSync(envFile, "utf8");
    const setLine = (key: string, val: string) => {
      const re = new RegExp(`^${key}=.*$`, "m");
      if (re.test(content)) {
        content = content.replace(re, `${key}=${val}`);
      } else {
        content = `${content.trimEnd()}\n${key}=${val}\n`;
      }
    };
    setLine("PALMER_LOU_BT_DEVICE_MAC", mac.toUpperCase());
    setLine("PALMER_LOU_BT_DEVICE_NAME", name);
    writeFileSync(envFile, content, "utf8");
  } catch {
    // In-memory update is live; file write requires correct permissions
  }
}
