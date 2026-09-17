import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

type RemoteAccessMode = "disabled" | "tailscale" | "cloudflared" | "custom";
type TunnelAction = "start" | "stop" | "restart" | "status";
export type RemoteControlAction = "up" | "down" | "left" | "right" | "select" | "back" | "home" | "playpause" | "volup" | "voldown" | "mute" | "backspace";

type ResolvedTunnelCommands = {
  status: string;
  start: string;
  stop: string;
  restart: string;
};

export type RemoteAccessStatus = {
  mode: RemoteAccessMode;
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

export type RemoteControlResult = {
  action: RemoteControlAction;
  command: string;
  configured: boolean;
  success: boolean;
  status: string;
  output: string | null;
  executedAt: string;
};

const MAX_OUTPUT_CHARS = 12000;

let lastTunnelAction = "Idle";
let lastTunnelOutput: string | null = null;
let lastRemoteControlOutput: string | null = null;

const linuxKeyMap: Record<RemoteControlAction, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  select: "Return",
  back: "Escape",
  home: "Super_L",
  playpause: "XF86AudioPlay",
  volup: "XF86AudioRaiseVolume",
  voldown: "XF86AudioLowerVolume",
  mute: "XF86AudioMute",
  backspace: "BackSpace"
};

function parseRemoteControlCommandMap(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {} as Partial<Record<RemoteControlAction, string>>;
  }

  try {
    return JSON.parse(trimmed) as Partial<Record<RemoteControlAction, string>>;
  } catch {
    const normalized = trimmed
      .replace(/^['"]|['"]$/g, "")
      .replace(/\\([,:"{}\[\]])/g, "$1")
      .replace(/\s+/g, " ")
      .replace(/\s*:\s*/g, "\":\"")
      .replace(/\s*,\s*/g, '\",\"');

    try {
      return JSON.parse(`{${normalized}}`) as Partial<Record<RemoteControlAction, string>>;
    } catch {
      return {} as Partial<Record<RemoteControlAction, string>>;
    }
  }
}

function readRemoteControlCommandMap() {
  const raw = (process.env.PALMER_LOU_REMOTE_CONTROL_COMMANDS ?? "").trim();
  if (!raw) {
    return {} as Partial<Record<RemoteControlAction, string>>;
  }

  return parseRemoteControlCommandMap(raw);
}

function resolveRemoteControlCommand(action: RemoteControlAction, repeat: number) {
  const commandMap = readRemoteControlCommandMap();
  const envOverride = process.env[`PALMER_LOU_REMOTE_CONTROL_${action.toUpperCase()}_COMMAND`]?.trim() ?? "";
  const configured = envOverride || commandMap[action] || "";
  if (configured) {
    return configured;
  }

  if (process.platform !== "linux") {
    return "";
  }

  const key = linuxKeyMap[action];
  const display = (process.env.PALMER_LOU_REMOTE_CONTROL_DISPLAY ?? ":0").trim();
  const xauthority = (process.env.PALMER_LOU_REMOTE_CONTROL_XAUTHORITY ?? "").trim();
  const runAsUser = (process.env.PALMER_LOU_REMOTE_CONTROL_USER ?? "palmerlou").trim();
  const repeatCount = Math.max(1, Math.min(8, Math.floor(repeat)));
  const xauthExpr = xauthority
    ? shellQuote(xauthority)
    : "$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)";

  // For navigation/selection keys, activate the launched app window first so
  // keystrokes reach Netflix/YouTube rather than the Palmer Lou browser.
  const needsAppFocus = ["up", "down", "left", "right", "select", "back", "backspace"].includes(action);
  const focusPreamble = needsAppFocus
    ? `FOCUS_PID=$(pgrep -f 'palmer-lou-apps' 2>/dev/null | head -1); [ -z "$FOCUS_PID" ] && FOCUS_PID=$(pgrep -f 'com.spotify.Client' 2>/dev/null | head -1); if [ -n "$FOCUS_PID" ]; then FOCUS_WIN=$(xdotool search --pid "$FOCUS_PID" 2>/dev/null | head -1); [ -n "$FOCUS_WIN" ] && xdotool windowactivate --sync "$FOCUS_WIN" 2>/dev/null || true; fi; `
    : "";

  const core = `XAUTH=${xauthExpr}; DISPLAY=${shellQuote(display)} XAUTHORITY=\"$XAUTH\" ${focusPreamble}xdotool key --clearmodifiers --repeat ${repeatCount} ${shellQuote(key)}`;

  if (!runAsUser) {
    return core;
  }

  return `sudo -u ${shellQuote(runAsUser)} bash -lc ${shellQuote(core)}`;
}

const remoteUpdateState: RemoteUpdateStatus = {
  configured: false,
  running: false,
  command: "",
  lastRunAt: null,
  lastFinishedAt: null,
  lastSuccess: null,
  lastOutput: null,
  lastError: null,
  notes: "Configure a remote update command to apply updates from Settings."
};

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function trimOutput(output: string) {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }

  return output.slice(output.length - MAX_OUTPUT_CHARS);
}

function getRemoteMode(): RemoteAccessMode {
  const mode = (process.env.PALMER_LOU_REMOTE_ACCESS_MODE ?? "tailscale").toLowerCase();

  if (mode === "disabled" || mode === "tailscale" || mode === "cloudflared" || mode === "custom") {
    return mode;
  }

  return "tailscale";
}

function resolveTunnelCommands(mode: RemoteAccessMode): ResolvedTunnelCommands {
  const status = process.env.PALMER_LOU_REMOTE_TUNNEL_STATUS_COMMAND ?? "";
  const start = process.env.PALMER_LOU_REMOTE_TUNNEL_START_COMMAND ?? "";
  const stop = process.env.PALMER_LOU_REMOTE_TUNNEL_STOP_COMMAND ?? "";
  const restart = process.env.PALMER_LOU_REMOTE_TUNNEL_RESTART_COMMAND ?? "";

  if (mode === "custom") {
    return { status, start, stop, restart };
  }

  if (mode === "cloudflared") {
    return {
      status: status || "systemctl status cloudflared --no-pager",
      start: start || "systemctl start cloudflared",
      stop: stop || "systemctl stop cloudflared",
      restart: restart || "systemctl restart cloudflared"
    };
  }

  if (mode === "tailscale") {
    return {
      status: status || "tailscale status",
      start: start || "systemctl start tailscaled",
      stop: stop || "systemctl stop tailscaled",
      restart: restart || "systemctl restart tailscaled"
    };
  }

  return { status: "", start: "", stop: "", restart: "" };
}

function parseTunnelConnected(output: string) {
  const normalized = output.toLowerCase();

  if (normalized.includes("logged out") || normalized.includes("stopped") || normalized.includes("inactive") || normalized.includes("failed")) {
    return false;
  }

  if (normalized.includes("active") || normalized.includes("running") || normalized.includes("online") || normalized.includes("logged in")) {
    return true;
  }

  return null;
}

async function runShell(command: string, timeoutMs = 10000) {
  const result = await execAsync(command, {
    timeout: timeoutMs,
    windowsHide: true,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    maxBuffer: 1024 * 1024 * 2
  });

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return trimOutput(output);
}

function tunnelNotesForMode(mode: RemoteAccessMode) {
  if (mode === "disabled") {
    return "Remote access controls are disabled by PALMER_LOU_REMOTE_ACCESS_MODE.";
  }

  if (mode === "tailscale") {
    return "Tailscale mode uses outbound encrypted overlay networking and does not require port forwarding.";
  }

  if (mode === "cloudflared") {
    return "Cloudflare tunnel mode uses an outbound reverse tunnel suitable for Starlink NAT environments.";
  }

  return "Custom remote tunnel mode uses environment-provided commands.";
}

export async function runRemoteTypeAction(text: string): Promise<{ success: boolean; text: string; executedAt: string }> {
  if (process.platform !== "linux") {
    return { success: false, text, executedAt: new Date().toISOString() };
  }

  // Allow only printable ASCII to prevent shell injection.
  const safe = text.replace(/[^\x20-\x7E]/g, "");
  if (!safe) {
    return { success: false, text, executedAt: new Date().toISOString() };
  }

  const display = (process.env.PALMER_LOU_REMOTE_CONTROL_DISPLAY ?? ":0").trim();
  const runAsUser = (process.env.PALMER_LOU_REMOTE_CONTROL_USER ?? "palmerlou").trim();
  const xauthExpr = "$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)";
  const focusPreamble = `FOCUS_PID=$(pgrep -f 'palmer-lou-apps' 2>/dev/null | head -1); [ -z "$FOCUS_PID" ] && FOCUS_PID=$(pgrep -f 'com.spotify.Client' 2>/dev/null | head -1); if [ -n "$FOCUS_PID" ]; then FOCUS_WIN=$(xdotool search --pid "$FOCUS_PID" 2>/dev/null | head -1); [ -n "$FOCUS_WIN" ] && xdotool windowactivate --sync "$FOCUS_WIN" 2>/dev/null || true; fi; `;
  const core = `XAUTH=${xauthExpr}; DISPLAY=${shellQuote(display)} XAUTHORITY=\"$XAUTH\" ${focusPreamble}xdotool type --clearmodifiers --delay 12 ${shellQuote(safe)}`;
  const cmd = runAsUser ? `sudo -u ${shellQuote(runAsUser)} bash -lc ${shellQuote(core)}` : core;

  try {
    await execAsync(cmd, { timeout: 5000 });
    return { success: true, text: safe, executedAt: new Date().toISOString() };
  } catch {
    return { success: false, text: safe, executedAt: new Date().toISOString() };
  }
}

export async function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  const mode = getRemoteMode();
  const commands = resolveTunnelCommands(mode);
  const label = process.env.PALMER_LOU_REMOTE_ACCESS_LABEL ?? (mode === "tailscale" ? "Tailscale overlay" : mode === "cloudflared" ? "Cloudflare tunnel" : "Custom tunnel");
  const viewUrl = process.env.PALMER_LOU_REMOTE_VIEW_URL ?? "";
  const troubleshootUrl = process.env.PALMER_LOU_REMOTE_TROUBLESHOOT_URL ?? "";

  if (mode === "disabled") {
    return {
      mode,
      label,
      viewUrl,
      troubleshootUrl,
      status: "Disabled",
      connected: false,
      configured: false,
      lastCheckedAt: new Date().toISOString(),
      lastAction: lastTunnelAction,
      lastOutput: lastTunnelOutput,
      commands: {
        statusConfigured: false,
        startConfigured: false,
        stopConfigured: false,
        restartConfigured: false
      },
      notes: tunnelNotesForMode(mode)
    };
  }

  let statusText = "Unknown";
  let connected = false;

  if (commands.status.trim().length > 0) {
    try {
      const output = await runShell(commands.status, 8000);
      lastTunnelOutput = output || null;
      const parsedConnected = parseTunnelConnected(output);
      connected = parsedConnected ?? false;
      statusText = parsedConnected === null ? "Tunnel status returned" : parsedConnected ? "Connected" : "Not connected";
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown command error";
      lastTunnelOutput = trimOutput(detail);
      statusText = "Status command failed";
      connected = false;
    }
  }

  return {
    mode,
    label,
    viewUrl,
    troubleshootUrl,
    status: statusText,
    connected,
    configured: commands.status.trim().length > 0,
    lastCheckedAt: new Date().toISOString(),
    lastAction: lastTunnelAction,
    lastOutput: lastTunnelOutput,
    commands: {
      statusConfigured: commands.status.trim().length > 0,
      startConfigured: commands.start.trim().length > 0,
      stopConfigured: commands.stop.trim().length > 0,
      restartConfigured: commands.restart.trim().length > 0
    },
    notes: tunnelNotesForMode(mode)
  };
}

export async function runTunnelAction(action: TunnelAction): Promise<RemoteAccessStatus> {
  if (action === "status") {
    lastTunnelAction = "Status refresh";
    return getRemoteAccessStatus();
  }

  const mode = getRemoteMode();
  const commands = resolveTunnelCommands(mode);
  const command = commands[action];

  if (!command || command.trim().length === 0) {
    lastTunnelAction = `${action} requested`;
    lastTunnelOutput = `${action} command is not configured.`;
    return getRemoteAccessStatus();
  }

  try {
    const output = await runShell(command, 15000);
    lastTunnelAction = `${action} requested`;
    lastTunnelOutput = output || `${action} command completed.`;
  } catch (error) {
    lastTunnelAction = `${action} requested`;
    lastTunnelOutput = trimOutput(error instanceof Error ? error.message : `${action} command failed`);
  }

  return getRemoteAccessStatus();
}

function resolveUpdateCommand(repoRoot: string) {
  const configured = process.env.PALMER_LOU_REMOTE_UPDATE_COMMAND?.trim() ?? "";
  if (configured) {
    return configured;
  }

  if (process.platform !== "linux") {
    return "";
  }

  const scriptPath = path.resolve(repoRoot, "infrastructure/scripts/update.sh");
  return `PALMER_LOU_REPO_DIR=${shellQuote(repoRoot)} bash ${shellQuote(scriptPath)}`;
}

export function getRemoteUpdateStatus(repoRoot: string): RemoteUpdateStatus {
  const command = resolveUpdateCommand(repoRoot);
  remoteUpdateState.command = command;
  remoteUpdateState.configured = command.trim().length > 0;
  remoteUpdateState.notes = remoteUpdateState.configured
    ? "Run update to fetch, install, and build remotely on the boat machine."
    : "Set PALMER_LOU_REMOTE_UPDATE_COMMAND (or run on Linux for default update.sh).";

  return { ...remoteUpdateState };
}

export async function runRemoteUpdate(repoRoot: string): Promise<RemoteUpdateStatus> {
  const command = resolveUpdateCommand(repoRoot);
  remoteUpdateState.command = command;
  remoteUpdateState.configured = command.trim().length > 0;

  if (!remoteUpdateState.configured) {
    remoteUpdateState.lastError = "No remote update command configured.";
    remoteUpdateState.lastSuccess = false;
    remoteUpdateState.lastFinishedAt = new Date().toISOString();
    return { ...remoteUpdateState };
  }

  if (remoteUpdateState.running) {
    return { ...remoteUpdateState };
  }

  remoteUpdateState.running = true;
  remoteUpdateState.lastRunAt = new Date().toISOString();
  remoteUpdateState.lastError = null;

  try {
    const output = await runShell(command, 1000 * 60 * 20);
    remoteUpdateState.lastOutput = output || "Update command finished with no output.";
    remoteUpdateState.lastSuccess = true;
  } catch (error) {
    remoteUpdateState.lastOutput = null;
    remoteUpdateState.lastError = trimOutput(error instanceof Error ? error.message : "Unknown update command error");
    remoteUpdateState.lastSuccess = false;
  } finally {
    remoteUpdateState.running = false;
    remoteUpdateState.lastFinishedAt = new Date().toISOString();
  }

  return { ...remoteUpdateState };
}

export async function runRemoteControlAction(action: RemoteControlAction, repeat = 1): Promise<RemoteControlResult> {
  const command = resolveRemoteControlCommand(action, repeat);
  const executedAt = new Date().toISOString();

  if (!command) {
    return {
      action,
      command: "",
      configured: false,
      success: false,
      status: "Remote control command not configured",
      output: "Set PALMER_LOU_REMOTE_CONTROL_COMMANDS or PALMER_LOU_REMOTE_CONTROL_<ACTION>_COMMAND, or install xdotool on Linux.",
      executedAt
    };
  }

  try {
    const output = await runShell(command, 7000);
    lastRemoteControlOutput = output || null;
    return {
      action,
      command,
      configured: true,
      success: true,
      status: "Remote control command sent",
      output: output || null,
      executedAt
    };
  } catch (error) {
    const detail = trimOutput(error instanceof Error ? error.message : "Remote control command failed");
    lastRemoteControlOutput = detail;
    return {
      action,
      command,
      configured: true,
      success: false,
      status: "Remote control command failed",
      output: detail,
      executedAt
    };
  }
}
