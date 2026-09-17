import { spawn, spawnSync } from "node:child_process";
import { applyBluetoothAction, getBluetoothState } from "./bluetooth.js";

export type LaunchRequest = {
  appId: string;
  name: string;
  launchUrl: string;
  launchLabel: string;
  requestSource?: "kiosk" | "remote";
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

type LauncherCommands = Partial<Record<string, string>>;

type LaunchProcess = {
  pid: number;
  command: string;
};

type ResolvedLaunchCommand = {
  command: string;
  args: string[];
  shell: boolean;
  source: "configured" | "builtin";
};

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveRuntimeDirForUser(runAsUser: string) {
  const override = (process.env.PALMER_LOU_LAUNCH_XDG_RUNTIME_DIR ?? "").trim();
  if (override) {
    return override;
  }

  const user = runAsUser.trim();
  if (!user) {
    return "/run/user/1000";
  }

  const uidProbe = spawnSync("id", ["-u", user], { encoding: "utf8" });
  if (uidProbe.status !== 0) {
    return "/run/user/1000";
  }

  const uid = uidProbe.stdout.trim();
  return uid ? `/run/user/${uid}` : "/run/user/1000";
}

function wrapLaunchForDesktop(resolved: ResolvedLaunchCommand) {
  if (process.platform !== "linux") {
    return resolved;
  }

  const display = (process.env.PALMER_LOU_LAUNCH_DISPLAY ?? ":0").trim() || ":0";
  const xauthority = (process.env.PALMER_LOU_LAUNCH_XAUTHORITY ?? "").trim();
  const runAsUser = (process.env.PALMER_LOU_LAUNCH_USER ?? "palmerlou").trim();
  const runtimeDir = resolveRuntimeDirForUser(runAsUser);
  const dbusAddress = (process.env.PALMER_LOU_LAUNCH_DBUS_ADDRESS ?? `unix:path=${runtimeDir}/bus`).trim();
  const xauthExpr = xauthority ? shellQuote(xauthority) : "$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)";

  const core = resolved.shell
    ? resolved.command
    : [resolved.command, ...resolved.args].map(shellQuote).join(" ");
  const envWrapped = `XAUTH=${xauthExpr}; DISPLAY=${shellQuote(display)} XAUTHORITY=\"$XAUTH\" XDG_RUNTIME_DIR=${shellQuote(runtimeDir)} DBUS_SESSION_BUS_ADDRESS=${shellQuote(dbusAddress)} ${core}`;
  const desktopCommand = runAsUser
    ? `sudo -u ${shellQuote(runAsUser)} bash -lc ${shellQuote(envWrapped)}`
    : `bash -lc ${shellQuote(envWrapped)}`;

  return {
    command: desktopCommand,
    args: [] as string[],
    shell: true,
    source: resolved.source
  };
}

const browserBackedAppIds = new Set([
  "youtube",
  "youtube-tv",
  "netflix",
  "browser",
  "firefox",
  "paramount",
  "peacock",
  "disney",
  "siriusxm",
  "pandora"
]);
const allowBrowserFallback = (process.env.PALMER_LOU_ALLOW_BROWSER_FALLBACK ?? "true").toLowerCase() === "true";
const extensionDir = (process.env.PALMER_LOU_EXTENSION_DIR ?? "/home/palmerlou/palmer-lou-extension").trim();

let launcherState: LauncherState = {
  appId: "",
  name: "",
  subtitle: "",
  runtime: "Bridge",
  status: "Idle",
  message: "No app launched yet.",
  launchMethod: "App bridge",
  startedAt: new Date().toISOString()
};

let activeLaunchProcess: LaunchProcess | null = null;

const knownLaunchedAppProcessPatterns = [
  "palmer-lou-apps/youtube",
  "palmer-lou-apps/youtube-tv",
  "palmer-lou-apps/netflix",
  "palmer-lou-apps/browser",
  "palmer-lou-apps/paramount",
  "palmer-lou-apps/peacock",
  "palmer-lou-apps/disney",
  "palmer-lou-apps/spotify",
  "palmer-lou-apps/siriusxm",
  "palmer-lou-apps/pandora",
  "com.spotify.Client"
];

const audioCriticalAppIds = new Set(["youtube", "youtube-tv", "spotify", "netflix"]);
const requireBluetoothReady = (process.env.PALMER_LOU_REQUIRE_BLUETOOTH_READY ?? "false").toLowerCase() === "true";

export function parseLauncherCommandMap(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {} as LauncherCommands;
  }

  const candidates = new Set<string>();
  candidates.add(trimmed);

  let unwrapped = trimmed;
  while ((unwrapped.startsWith("'") && unwrapped.endsWith("'")) || (unwrapped.startsWith('"') && unwrapped.endsWith('"'))) {
    unwrapped = unwrapped.slice(1, -1);
    candidates.add(unwrapped);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as LauncherCommands;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try shell-normalized variants below.
    }
  }

  const normalized = unwrapped
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\([,:"{}\[\]])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*/g, '\":\"')
    .replace(/\s*,\s*/g, '\",\"');

  try {
    return JSON.parse(`{${normalized}}`) as LauncherCommands;
  } catch {
    return {} as LauncherCommands;
  }
}

function getLauncherCommands() {
  const raw = process.env.PALMER_LOU_LAUNCH_COMMANDS;

  if (!raw) {
    return {} as LauncherCommands;
  }

  return parseLauncherCommandMap(raw);
}

function resolveBrowserCommand() {
  if (process.platform === "win32") {
    return "cmd";
  }

  const override = (process.env.PALMER_LOU_BROWSER ?? "").trim();
  if (override) {
    return override;
  }

  const candidates = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "firefox",
    "firefox-esr",
    "brave-browser",
    "microsoft-edge",
    "vivaldi"
  ];
  const probe = "command -v";

  for (const candidate of candidates) {
    const resolved = spawnSync("bash", ["-lc", `${probe} ${candidate}`], { encoding: "utf8" });

    if (resolved.status === 0 && resolved.stdout.trim().length > 0) {
      return resolved.stdout.trim();
    }
  }

  return null;
}

function buildSafeChromiumAppFlags(request: LaunchRequest) {
  const featureList = [
    "Translate",
    "OptimizationHints",
    "MediaRouter",
    "SearchEngineChoiceScreen",
    // required for snap Chromium to honour --load-extension at launch
    "DisableLoadExtensionCommandLineSwitch"
  ].join(",");

  const isVideoApp = ["youtube", "youtube-tv", "netflix", "paramount", "peacock", "disney"].includes(request.appId);

  return [
    ...(isVideoApp ? ["--kiosk"] : [`--app=${request.launchUrl}`]),
    "--start-fullscreen",
    request.launchUrl,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    `--disable-features=${featureList}`,
    "--disable-session-crashed-bubble",
    "--disable-infobars",
    "--noerrdialogs",
    "--disable-restore-session-state",
    "--hide-crash-restore-bubble",
    // snap/chromium/common is the only path snap Chromium's AppArmor profile allows writes to that survives reboots
    `--user-data-dir=/home/palmerlou/snap/chromium/common/palmer-lou-apps/${request.appId}`,
    // inject the Palmer Lou home button into every app window
    ...(extensionDir ? [`--load-extension=${extensionDir}`] : [])
  ];
}

function sanitizeConfiguredBrowserCommand(request: LaunchRequest, command: string) {
  if (!command.trim()) {
    return command;
  }

  const lowerCommand = command.toLowerCase();
  const looksLikeChromium = /(^|\s)(chromium|chromium-browser|google-chrome|google-chrome-stable|chrome)(\s|$|\/)/.test(lowerCommand);
  const looksLikeFirefox = /(^|\s)firefox(\s|$|\/)/.test(lowerCommand);

  if (looksLikeFirefox) {
    return command.includes(request.launchUrl)
      ? command
      : `${command.trim()} --kiosk ${request.launchUrl}`;
  }

  if (!looksLikeChromium) {
    return command;
  }

  const normalized = command.trim();
  const safeFlags = buildSafeChromiumAppFlags(request);

  const commandTokens = normalized.split(/\s+/);
  const filtered = commandTokens.filter((token) => {
    if (token.startsWith("--disable-features=")) {
      return false;
    }

    if (token.startsWith("--user-data-dir=")) {
      return false;
    }

    if (token.startsWith("--app=")) {
      return false;
    }

    if (token === "--kiosk") {
      return false;
    }

    if (token.startsWith("http://") || token.startsWith("https://")) {
      return false;
    }

    if (token === "--start-fullscreen" || token === "--no-first-run" || token === "--no-default-browser-check") {
      return false;
    }

    if (token === "--disable-background-networking" || token === "--disable-component-update" || token === "--disable-sync") {
      return false;
    }

    if (token === "--disable-session-crashed-bubble" || token === "--disable-infobars" || token === "--noerrdialogs") {
      return false;
    }

    if (token === "--disable-restore-session-state" || token === "--hide-crash-restore-bubble") {
      return false;
    }

    return true;
  });

  const rebuilt = [...filtered, ...safeFlags].join(" ");
  return rebuilt.replace(/\s+/g, " ").trim();
}

function resolveBrowserLaunch(request: LaunchRequest, browserCommand: string) {
  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", "", request.launchUrl],
      shell: false
    };
  }

  const lowerCommand = browserCommand.toLowerCase();
  if (lowerCommand.includes("firefox")) {
    return {
      command: browserCommand,
      args: ["--kiosk", request.launchUrl]
    };
  }

  return {
    command: browserCommand,
    args: buildSafeChromiumAppFlags(request)
  };
}

function resolveBuiltinCommand(request: LaunchRequest) {
  if (request.appId === "spotify") {
    const flatpakBinary = process.platform === "win32"
      ? spawnSync("where", ["flatpak"], { encoding: "utf8" })
      : spawnSync("bash", ["-lc", "command -v flatpak"], { encoding: "utf8" });
    if (flatpakBinary.status === 0 && flatpakBinary.stdout.trim().length > 0) {
      const command = process.platform === "win32" ? (flatpakBinary.stdout.trim().split(/\r?\n/)[0] ?? "") : flatpakBinary.stdout.trim();
      return { command, args: ["run", "com.spotify.Client"] };
    }

    const spotifyBinary = process.platform === "win32"
      ? spawnSync("where", ["spotify"], { encoding: "utf8" })
      : spawnSync("bash", ["-lc", "command -v spotify"], { encoding: "utf8" });
    if (spotifyBinary.status === 0 && spotifyBinary.stdout.trim().length > 0) {
      const command = process.platform === "win32" ? (spotifyBinary.stdout.trim().split(/\r?\n/)[0] ?? "") : spotifyBinary.stdout.trim();
      return { command, args: [] as string[] };
    }

    const browserCommand = resolveBrowserCommand();
    if (!browserCommand) {
      return null;
    }

    return resolveBrowserLaunch({ ...request, appId: "spotify" }, browserCommand);
  }

  if (browserBackedAppIds.has(request.appId)) {
    if (!allowBrowserFallback) {
      return null;
    }

    const browserCommand = resolveBrowserCommand();
    if (!browserCommand) {
      return null;
    }

    return resolveBrowserLaunch(request, browserCommand);
  }

  return null;
}

export function getLaunchCommand(request: LaunchRequest) {
  const commands = getLauncherCommands();
  const command = commands[request.appId]
    ?? (request.appId === "browser" ? commands.firefox : undefined)
    ?? (request.appId === "firefox" ? commands.browser : undefined);

  if (command) {
    return {
      command: sanitizeConfiguredBrowserCommand(request, command),
      args: [] as string[],
      shell: true,
      source: "configured" as const
    };
  }

  const builtin = resolveBuiltinCommand(request);
  if (builtin) {
    return { ...builtin, shell: false, source: "builtin" as const };
  }

  return null;
}

function stopActiveLaunchProcess() {
  if (!activeLaunchProcess) {
    return false;
  }

  try {
    if (activeLaunchProcess.pid > 0 && process.platform === "win32") {
      process.kill(activeLaunchProcess.pid);
    } else if (activeLaunchProcess.pid > 0) {
      process.kill(-activeLaunchProcess.pid);
    }
  } catch {
    // Ignore shutdown failures and clear the state anyway.
  }

  activeLaunchProcess = null;
  return true;
}

function stopKnownLaunchedAppProcesses() {
  if (process.platform !== "linux") {
    return;
  }

  for (const pattern of knownLaunchedAppProcessPatterns) {
    spawnSync("bash", ["-lc", `pkill -f ${shellQuote(pattern)} >/dev/null 2>&1 || true`], {
      stdio: "ignore"
    });
  }
}

async function runCommand(resolved: ResolvedLaunchCommand | null) {
  if (!resolved?.command) {
    return false;
  }

  const launchCommand = wrapLaunchForDesktop(resolved);

  const child = spawn(launchCommand.command, launchCommand.args, {
    shell: launchCommand.shell,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  if (!child.pid) {
    return false;
  }

  child.unref();
  activeLaunchProcess = {
    pid: child.pid ?? 0,
    command: launchCommand.command
  };

  return true;
}

export async function launchApp(request: LaunchRequest) {
  stopActiveLaunchProcess();
  stopKnownLaunchedAppProcesses();
  const requestedFromRemote = request.requestSource === "remote";

  if (requireBluetoothReady && audioCriticalAppIds.has(request.appId)) {
    const bluetoothState = await getBluetoothState();
    const audioConfigured = bluetoothState.config.routeConfigured && bluetoothState.config.statusConfigured;

    if (!audioConfigured) {
      launcherState = {
        appId: request.appId,
        name: request.name,
        subtitle: request.launchLabel,
        runtime: "Blocked",
        status: "Audio path not configured",
        message: "Configure Bluetooth route and status commands before launching media apps.",
        launchMethod: "Safety gate",
        startedAt: new Date().toISOString()
      };

      return launcherState;
    }

    const routedBluetoothState = await applyBluetoothAction("route-audio");
    if (!routedBluetoothState.connected) {
      launcherState = {
        appId: request.appId,
        name: request.name,
        subtitle: request.launchLabel,
        runtime: "Blocked",
        status: "Bluetooth not connected",
        message: "Media launch blocked until Bluetooth stereo connection is confirmed.",
        launchMethod: "Safety gate",
        startedAt: new Date().toISOString()
      };

      return launcherState;
    }
  }

  const launchCommand = getLaunchCommand(request);
  const executed = await runCommand(launchCommand);

  launcherState = {
    appId: request.appId,
    name: request.name,
    subtitle: request.launchLabel,
    runtime: executed ? "Native app process" : requestedFromRemote ? "Blocked" : "In-shell bridge",
    status: executed ? "Launched" : requestedFromRemote ? "Launch command required" : "Ready in app bridge",
    message: executed
      ? `Started ${request.name} as a real Linux app process.`
      : requestedFromRemote
        ? `${request.name} was requested from the remote page, but the touchscreen host could not launch it. Configure PALMER_LOU_LAUNCH_COMMANDS for ${request.appId}.`
        : `${request.name} is open inside Palmer Lou until a launch command is configured.`,
    launchMethod: executed
      ? (launchCommand?.source === "builtin" ? "Built-in app launch" : "Configured app launch")
      : requestedFromRemote
        ? "Remote launch request"
        : "Branded app shell",
    startedAt: new Date().toISOString()
  };

  return launcherState;
}

export async function returnToHome() {
  if (activeLaunchProcess && process.platform === "linux" && launcherState.appId) {
    const display = (process.env.PALMER_LOU_LAUNCH_DISPLAY ?? ":0").trim() || ":0";
    const runAsUser = (process.env.PALMER_LOU_LAUNCH_USER ?? "palmerlou").trim();
    const appId = launcherState.appId;

    // Minimize the app window and raise Palmer Lou without blocking the event loop.
    // XAUTHORITY must be set or xdotool/wmctrl silently fail with no X connection.
    const script = [
      `XAUTH=$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)`,
      `export DISPLAY=${shellQuote(display)}`,
      `export XAUTHORITY="$XAUTH"`,
      // The home button was just clicked in the app window, so it is still the active window.
      `TARGET=$(xdotool getactivewindow 2>/dev/null)`,
      // Fall back to PID-based search for browser apps and Spotify flatpak.
      `if [ -z "$TARGET" ]; then`,
      `  MAIN_PID=$(pgrep -f ${shellQuote('palmer-lou-apps/' + appId)} | while read p; do`,
      `    tr '\\0' ' ' </proc/$p/cmdline 2>/dev/null | grep -qv '\\-\\-type=' && echo $p`,
      `  done | sort -n | head -1)`,
      `  [ -z "$MAIN_PID" ] && MAIN_PID=$(pgrep -f 'com.spotify.Client' 2>/dev/null | sort -n | head -1)`,
      `  [ -n "$MAIN_PID" ] && TARGET=$(xdotool search --pid "$MAIN_PID" 2>/dev/null | head -1)`,
      `fi`,
      `[ -n "$TARGET" ] && xdotool windowminimize "$TARGET" 2>/dev/null || true`,
      `wmctrl -a "Palmer Lou OS" 2>/dev/null || true`
    ].join('\n');

    // Use spawn (non-blocking) so xdotool/wmctrl can never stall the HTTP server.
    const proc = spawn("sudo", ["-u", runAsUser, "bash", "-lc", script], { stdio: "ignore", detached: true });
    proc.unref();
    // Hard-kill the window script after 5 s as a safety net.
    setTimeout(() => { try { proc.kill(); } catch { /* already exited */ } }, 5000);
  }

  launcherState = {
    appId: "",
    name: "",
    subtitle: "",
    runtime: "Bridge",
    status: "Idle",
    message: activeLaunchProcess
      ? "Home restored. Active media app continues in background until another launch replaces it."
      : "No app launched yet.",
    launchMethod: "App bridge",
    startedAt: new Date().toISOString()
  };

  return launcherState;
}

export async function killLaunchedApp() {
  const hadActiveProcess = activeLaunchProcess !== null;
  const stopped = stopActiveLaunchProcess();

  launcherState = {
    appId: "",
    name: "",
    subtitle: "",
    runtime: "Bridge",
    status: hadActiveProcess ? "App hidden from view" : "No running app process",
    message: hadActiveProcess
      ? "Active app was dismissed from the Palmer Lou shell, but its background media process was left running."
      : "No launched app process was running.",
    launchMethod: "Background keep-alive",
    startedAt: new Date().toISOString()
  };

  return launcherState;
}

export async function getLauncherState() {
  return launcherState;
}
