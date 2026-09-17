export type UpdateStatus = {
  currentVersion: string;
  channel: string;
  feedUrl: string;
  lastCheckedAt: string;
  latestVersion: string | null;
  available: boolean;
  notes: string;
};

type UpdateManifest = {
  latestVersion?: string;
  version?: string;
  channel?: string;
  notes?: string;
};

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map((value) => Number.parseInt(value, 10) || 0);
  const rightParts = right.split(".").map((value) => Number.parseInt(value, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

async function fetchManifest(feedUrl: string): Promise<UpdateManifest | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(feedUrl, {
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as UpdateManifest;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveUpdateStatus(currentVersion: string, fallbackChannel: string): Promise<UpdateStatus> {
  const feedUrl = process.env.PALMER_LOU_UPDATE_FEED_URL ?? "";
  const baseStatus: UpdateStatus = {
    currentVersion,
    channel: fallbackChannel,
    feedUrl,
    lastCheckedAt: feedUrl ? new Date().toISOString() : "Never",
    latestVersion: null,
    available: false,
    notes: feedUrl
      ? "Remote feed not checked yet."
      : "Set PALMER_LOU_UPDATE_FEED_URL to enable remote version checks."
  };

  if (!feedUrl) {
    return baseStatus;
  }

  const manifest = await fetchManifest(feedUrl);
  if (!manifest) {
    return {
      ...baseStatus,
      notes: "Could not reach the remote update feed."
    };
  }

  const latestVersion = manifest.latestVersion ?? manifest.version ?? null;
  const channel = manifest.channel ?? fallbackChannel;

  if (!latestVersion) {
    return {
      ...baseStatus,
      channel,
      notes: manifest.notes ?? "The remote feed did not provide a version number."
    };
  }

  return {
    currentVersion,
    channel,
    feedUrl,
    lastCheckedAt: new Date().toISOString(),
    latestVersion,
    available: compareVersions(latestVersion, currentVersion) > 0,
    notes: manifest.notes ?? "Remote version check completed."
  };
}
