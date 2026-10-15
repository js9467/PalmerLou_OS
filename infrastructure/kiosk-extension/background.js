const RETURN_HOME_URLS = [
  "http://127.0.0.1:8787/api/launch/return",
  "http://localhost:8787/api/launch/return"
];

async function callWithTimeout(url, method, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      signal: controller.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function triggerReturnHome() {
  for (const baseUrl of RETURN_HOME_URLS) {
    const url = `${baseUrl}?ts=${Date.now()}`;
    if (await callWithTimeout(url, "POST", 1200)) {
      return true;
    }
  }

  for (const baseUrl of RETURN_HOME_URLS) {
    const url = `${baseUrl}?ts=${Date.now()}`;
    if (await callWithTimeout(url, "GET", 1200)) {
      return true;
    }
  }

  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "palmer-lou:return-home") {
    return;
  }

  triggerReturnHome().then((ok) => {
    sendResponse({ ok });
  });

  return true;
});
