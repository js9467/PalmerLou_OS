import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

type BackgroundSession = {
  appId: string;
  windowId: string | null;
  capturedAt: string;
};

type ResolvedLaunchCommand = {
  command: string;
  args: string[];
  shell: boolean;
  source: "configured" | "builtin";
};

const launcherDebugEnabled = (process.env.PALMER_LOU_LAUNCHER_DEBUG ?? "false").toLowerCase() === "true";

function logLauncherDebug(event: string, details?: Record<string, unknown>) {
  if (!launcherDebugEnabled) {
    return;
  }

  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.info(`[launcher] ${event}${payload}`);
}

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
const browserProfileMode = (process.env.PALMER_LOU_BROWSER_PROFILE_MODE ?? "shared").toLowerCase();
const browserProfileRoot = (process.env.PALMER_LOU_BROWSER_PROFILE_ROOT ?? "/home/palmerlou/snap/chromium/common/palmer-lou-apps").trim();

function validateExtensionDir(candidate: string) {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return false;
  }

  const manifestPath = `${trimmed}/manifest.json`;
  if (!existsSync(manifestPath)) {
    return false;
  }

  try {
    const manifestRaw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(manifestRaw) as { manifest_version?: unknown; name?: unknown };
    return Number.isFinite(parsed.manifest_version as number) && typeof parsed.name === "string";
  } catch {
    return false;
  }
}

function resolveExtensionDir() {
  const configured = (process.env.PALMER_LOU_EXTENSION_DIR ?? "").trim();
  const fallback = "/home/palmerlou/palmer-lou-extension";

  if (configured && validateExtensionDir(configured)) {
    return configured;
  }

  if (configured && !validateExtensionDir(configured)) {
    logLauncherDebug("extension-dir-invalid", { configured, fallback });
  }

  return validateExtensionDir(fallback) ? fallback : "";
}

const extensionDir = resolveExtensionDir();

function resolveLaunchProfileDir(appId: string) {
  const safeAppId = appId.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "app";
  if (browserProfileMode === "per-app") {
    return `${browserProfileRoot}/${safeAppId}`;
  }

  return `${browserProfileRoot}/shared`;
}

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
let lastBackgroundSession: BackgroundSession | null = null;

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

  const launchProfileDir = resolveLaunchProfileDir(request.appId);

  return [
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
    `--user-data-dir=${launchProfileDir}`,
    // inject the Palmer Lou home button into every app window
    ...(extensionDir ? [`--load-extension=${extensionDir}`] : [])
  ];
}

function sanitizeConfiguredBrowserCommand(request: LaunchRequest, command: string) {
  if (!command.trim()) {
    return command;
  }

  // Preserve configured commands exactly (known-good media behavior),
  // only repairing a known typoed extension path when present.
  return command
    .replace(/\/home\/palmerlou\/palmerlouextensikn\b/g, "/home/palmerlou/palmer-lou-extension")
    .replace(/\s+/g, " ")
    .trim();
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
  lastBackgroundSession = null;
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

function resolveAppProcessPatterns(appId: string) {
  if (appId === "spotify") {
    return ["palmer-lou-apps/spotify", "com.spotify.Client"];
  }

  return [`palmer-lou-apps/${appId}`];
}

function tryActivateExistingSession(appId: string) {
  if (process.platform !== "linux") {
    logLauncherDebug("restore-skipped", { reason: "non-linux", appId });
    return false;
  }

  const display = (process.env.PALMER_LOU_LAUNCH_DISPLAY ?? ":0").trim() || ":0";
  const runAsUser = (process.env.PALMER_LOU_LAUNCH_USER ?? "palmerlou").trim();
  const patterns = resolveAppProcessPatterns(appId);
  const preferredWindowId = lastBackgroundSession?.appId === appId
    ? (lastBackgroundSession.windowId ?? "")
    : "";

  const script = [
    `XAUTH=$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)`,
    `export DISPLAY=${shellQuote(display)}`,
    `export XAUTHORITY="$XAUTH"`,
    `WIN=""`,
    `if [ -n ${shellQuote(preferredWindowId)} ]; then`,
    `  xdotool getwindowname ${shellQuote(preferredWindowId)} >/dev/null 2>&1 && WIN=${shellQuote(preferredWindowId)}`,
    `fi`,
    `if [ -z "$WIN" ]; then`,
    ...patterns.map((pattern) => `  for pid in $(pgrep -f ${shellQuote(pattern)} 2>/dev/null); do`),
    `    found=$(xdotool search --pid "$pid" 2>/dev/null | head -1)`,
    `    if [ -n "$found" ]; then WIN="$found"; break; fi`,
    `  done`,
    `  [ -n "$WIN" ] && break`,
    `fi`,
    `if [ -n "$WIN" ]; then`,
    `  xdotool windowmap "$WIN" 2>/dev/null || true`,
    `  xdotool windowactivate "$WIN" 2>/dev/null || true`,
    `  exit 0`,
    `fi`,
    `exit 1`
  ].join("\n");

  const result = spawnSync("sudo", ["-u", runAsUser, "bash", "-lc", script], {
    stdio: "ignore",
    timeout: 3000,
    killSignal: "SIGKILL"
  });

  logLauncherDebug("restore-attempt", {
    appId,
    preferredWindowId: preferredWindowId || null,
    status: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.name === "Error" && /timed out/i.test(result.error.message)
  });

  return result.status === 0;
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
  lastBackgroundSession = null;

  return true;
}

export async function launchApp(request: LaunchRequest) {
  const shouldAttemptRestore =
    (lastBackgroundSession?.appId === request.appId)
    || (launcherState.appId === request.appId && (launcherState.status === "Launched" || launcherState.status === "Background"));

  if (shouldAttemptRestore && tryActivateExistingSession(request.appId)) {
    lastBackgroundSession = null;
    launcherState = {
      appId: request.appId,
      name: request.name,
      subtitle: request.launchLabel,
      runtime: "Native app process",
      status: "Launched",
      message: `Restored existing ${request.name} session.`,
      launchMethod: "Session restore",
      startedAt: new Date().toISOString()
    };

    return launcherState;
  }

  // If the same app is already active (foreground or background), restore its
  // window instead of relaunching it.
  if (
    process.platform === "linux" &&
    launcherState.appId === request.appId &&
    (launcherState.status === "Launched" || launcherState.status === "Background") &&
    activeLaunchProcess
  ) {
    const appId = request.appId;
    const display = (process.env.PALMER_LOU_LAUNCH_DISPLAY ?? ":0").trim() || ":0";
    const runAsUser = (process.env.PALMER_LOU_LAUNCH_USER ?? "palmerlou").trim();
    const restoreScript = [
      `XAUTH=$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)`,
      `export DISPLAY=${shellQuote(display)}`,
      `export XAUTHORITY="$XAUTH"`,
      `WIN=$(xdotool search --class chromium 2>/dev/null | while IFS= read -r wid; do`,
      `  nm=$(xdotool getwindowname "$wid" 2>/dev/null); case "$nm" in *[Pp]almer*) continue;; esac`,
      `  echo "$wid"; break`,
      `done)`,
      `[ -z "$WIN" ] && WIN=$(xdotool search --class Spotify 2>/dev/null | head -1)`,
      `if [ -n "$WIN" ]; then`,
      `  xdotool windowmap "$WIN" 2>/dev/null || true`,
      `  xdotool windowactivate --sync "$WIN" 2>/dev/null || true`,
      `fi`
    ].join('\n');
    const proc = spawn("sudo", ["-u", runAsUser, "bash", "-lc", restoreScript], { stdio: "ignore", detached: true });
    proc.unref();
    setTimeout(() => { try { proc.kill(); } catch { /* already exited */ } }, 5000);
    lastBackgroundSession = null;
    launcherState = {
      ...launcherState,
      runtime: "Native app process",
      status: "Launched",
      message: `Restored ${request.name} to the foreground.`,
      startedAt: new Date().toISOString()
    };
    return launcherState;
  }

  lastBackgroundSession = null;
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
  // Capture the app currently in the foreground so we can keep showing its
  // header icon while it runs in the background. Home only backgrounds an app;
  // it never closes it.
  const backgroundedAppId = launcherState.appId;
  const backgroundedName = launcherState.name;
  const backgroundedSubtitle = launcherState.subtitle;
  const backgroundedLaunchMethod = launcherState.launchMethod;

  if (process.platform === "linux") {
    const display = (process.env.PALMER_LOU_LAUNCH_DISPLAY ?? ":0").trim() || ":0";
    const runAsUser = (process.env.PALMER_LOU_LAUNCH_USER ?? "palmerlou").trim();
    const appId = launcherState.appId;
    const appPatterns = appId ? resolveAppProcessPatterns(appId) : [];
    let preferredWindowId = "";

    const probeWindowScript = [
      `XAUTH=$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)`,
      `export DISPLAY=${shellQuote(display)}`,
      `export XAUTHORITY="$XAUTH"`,
      `xdotool getactivewindow 2>/dev/null || true`
    ].join("\n");

    const windowProbe = spawnSync("sudo", ["-u", runAsUser, "bash", "-lc", probeWindowScript], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1200,
      killSignal: "SIGKILL"
    });
    preferredWindowId = windowProbe.stdout.trim();

    if (appId) {
      lastBackgroundSession = {
        appId,
        windowId: preferredWindowId || null,
        capturedAt: new Date().toISOString()
      };
    }

    logLauncherDebug("home-probe", {
      appId: appId || null,
      preferredWindowId: preferredWindowId || null,
      status: windowProbe.status,
      signal: windowProbe.signal ?? null
    });

    // Minimize the app window and raise Palmer Lou without blocking the event loop.
    // XAUTHORITY must be set or xdotool/wmctrl silently fail with no X connection.
    const script = [
      `XAUTH=$(ls -1 /run/user/*/.mutter-Xwaylandauth.* 2>/dev/null | head -n 1)`,
      `export DISPLAY=${shellQuote(display)}`,
      `export XAUTHORITY="$XAUTH"`,
      `TARGET=""`,
      // First, find the launched app window by process so we minimize the right app.
      `if [ -z "$TARGET" ]; then`,
      `  MAIN_PID=""`,
      ...appPatterns.map((pattern) => `  [ -z "$MAIN_PID" ] && MAIN_PID=$(pgrep -f ${shellQuote(pattern)} 2>/dev/null | sort -n | head -1)`),
      `  [ -n "$MAIN_PID" ] && TARGET=$(xdotool search --pid "$MAIN_PID" 2>/dev/null | head -1)`,
      `fi`,
      // If we could not resolve by process, use the captured active window id.
      `[ -z "$TARGET" ] && [ -n ${shellQuote(preferredWindowId)} ] && TARGET=${shellQuote(preferredWindowId)}`,
      // Last fallback: whatever window is active right now.
      `if [ -z "$TARGET" ]; then TARGET=$(xdotool getactivewindow 2>/dev/null); fi`,
      `[ -n "$TARGET" ] && xdotool windowminimize "$TARGET" 2>/dev/null || true`,
      `wmctrl -a "Palmer Lou OS" 2>/dev/null || true`,
      `HOME_WIN=$(xdotool search --name "Palmer Lou OS" 2>/dev/null | head -1)`,
      `[ -z "$HOME_WIN" ] && HOME_PID=$(pgrep -f 'http://127.0.0.1:8787' 2>/dev/null | sort -n | head -1)`,
      `[ -z "$HOME_WIN" ] && [ -n "$HOME_PID" ] && HOME_WIN=$(xdotool search --pid "$HOME_PID" 2>/dev/null | head -1)`,
      `[ -n "$HOME_WIN" ] && xdotool windowactivate --sync "$HOME_WIN" 2>/dev/null || true`
    ].join('\n');

    // Use spawn (non-blocking) so xdotool/wmctrl can never stall the HTTP server.
    const proc = spawn("sudo", ["-u", runAsUser, "bash", "-lc", script], { stdio: "ignore", detached: true });
    proc.unref();
    logLauncherDebug("home-script-spawned", {
      appId: appId || null,
      pid: proc.pid ?? null
    });
    // Hard-kill the window script after 5 s as a safety net.
    setTimeout(() => { try { proc.kill(); } catch { /* already exited */ } }, 5000);
    setTimeout(() => {
      logLauncherDebug("home-script-timeout-kill", {
        appId: appId || null,
        pid: proc.pid ?? null
      });
    }, 5000);
  }

  if (backgroundedAppId && (activeLaunchProcess || lastBackgroundSession)) {
    // The app keeps running (audio continues). Retain its identity so Palmer Lou
    // can show the header close icon and so re-tapping the tile restores it.
    launcherState = {
      appId: backgroundedAppId,
      name: backgroundedName,
      subtitle: backgroundedSubtitle,
      runtime: "Native app process",
      status: "Background",
      message: `${backgroundedName || "The app"} is running in the background. Tap its header icon to close it, or open another app to replace it.`,
      launchMethod: backgroundedLaunchMethod || "Background keep-alive",
      startedAt: new Date().toISOString()
    };

    return launcherState;
  }

  launcherState = {
    appId: "",
    name: "",
    subtitle: "",
    runtime: "Bridge",
    status: "Idle",
    message: "No app launched yet.",
    launchMethod: "App bridge",
    startedAt: new Date().toISOString()
  };

  return launcherState;
}

export async function killLaunchedApp() {
  const closingName = launcherState.name;
  const hadActiveProcess = activeLaunchProcess !== null || launcherState.appId.length > 0;

  stopActiveLaunchProcess();
  if (process.platform === "linux") {
    stopKnownLaunchedAppProcesses();
  }
  activeLaunchProcess = null;
  lastBackgroundSession = null;

  launcherState = {
    appId: "",
    name: "",
    subtitle: "",
    runtime: "Bridge",
    status: "Idle",
    message: hadActiveProcess
      ? `Closed ${closingName || "the active app"}.`
      : "No launched app process was running.",
    launchMethod: "App closed",
    startedAt: new Date().toISOString()
  };

  return launcherState;
}

export async function getLauncherState() {
  return launcherState;
}
