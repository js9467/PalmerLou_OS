import assert from "node:assert/strict";
import test from "node:test";

import { getLaunchCommand, parseLauncherCommandMap } from "./launcher.js";

test("parseLauncherCommandMap accepts quoted JSON env values", () => {
  const raw = '{"youtube":"chromium --app=https://www.youtube.com/tv --start-fullscreen"}';
  assert.deepEqual(parseLauncherCommandMap(`'${raw}'`), {
    youtube: "chromium --app=https://www.youtube.com/tv --start-fullscreen"
  });
});

test("getLaunchCommand prefers configured commands for browser-backed apps even when browser fallback is disabled", () => {
  const previousCommandMap = process.env.PALMER_LOU_LAUNCH_COMMANDS;
  const previousFallback = process.env.PALMER_LOU_ALLOW_BROWSER_FALLBACK;

  try {
    process.env.PALMER_LOU_LAUNCH_COMMANDS = '{"youtube":"chromium --app=https://www.youtube.com/tv --start-fullscreen"}';
    process.env.PALMER_LOU_ALLOW_BROWSER_FALLBACK = "false";

    const result = getLaunchCommand({
      appId: "youtube",
      name: "YouTube",
      launchUrl: "https://www.youtube.com/tv",
      launchLabel: "YouTube"
    });

    assert.ok(result, "expected a configured launch command");
    assert.equal(result.source, "configured");
    assert.ok(result.command.includes("--kiosk"));
    assert.ok(result.command.includes("https://www.youtube.com/tv"));
    assert.ok(result.command.includes("--no-first-run"));
    assert.ok(!result.command.includes("--app="));
    assert.ok(result.command.includes("--user-data-dir=/tmp/palmer-lou-youtube"));
  } finally {
    if (previousCommandMap === undefined) {
      delete process.env.PALMER_LOU_LAUNCH_COMMANDS;
    } else {
      process.env.PALMER_LOU_LAUNCH_COMMANDS = previousCommandMap;
    }

    if (previousFallback === undefined) {
      delete process.env.PALMER_LOU_ALLOW_BROWSER_FALLBACK;
    } else {
      process.env.PALMER_LOU_ALLOW_BROWSER_FALLBACK = previousFallback;
    }
  }
});

test("killLaunchedApp leaves the background media process alive instead of hard-killing it", async () => {
  const result = await import("./launcher.js").then(({ killLaunchedApp }) => killLaunchedApp());

  assert.equal(result.status, "No running app process");
  assert.ok(result.message.includes("No launched app process was running"));
});
