import test from "node:test";
import assert from "node:assert/strict";

import { parseNmcliWifiOutput } from "./wifi.js";

test("parseNmcliWifiOutput turns NetworkManager scan rows into usable network entries", () => {
  const rows = `
*^*${"\t"}*${"\t"}*${"\t"}*${"\t"}*${"\t"}*
SSID${"\t"}BSSID${"\t"}SIGNAL${"\t"}SECURITY${"\t"}CHAN${"\t"}IN-USE
Dockside${"\t"}AA:BB:CC:DD:EE:FF${"\t"}82${"\t"}WPA2${"\t"}11${"\t"}*
Open Bay${"\t"}00:11:22:33:44:55${"\t"}68${"\t"}--${"\t"}6${"\t"}
`;

  const parsed = parseNmcliWifiOutput(rows);
  assert.equal(parsed.length, 2);

  const dockside = parsed[0];
  const openBay = parsed[1];

  assert.ok(dockside);
  assert.ok(openBay);

  assert.equal(dockside.ssid, "Dockside");
  assert.equal(dockside.security, "wpa2");
  assert.equal(dockside.connected, true);
  assert.equal(openBay.ssid, "Open Bay");
  assert.equal(openBay.security, "open");
  assert.equal(openBay.connected, false);
});

test("parseNmcliWifiOutput understands the live colon-delimited NetworkManager format", () => {
  const rows = `
Slaughternet-3.0:98:ED:7E:75:E8:86:85:WPA2:36:*
Slaughternet-3.0:98:ED:7E:75:E8:87:81:WPA2:11:
Slaughterguest:98:ED:7E:74:52:90:85:WPA2:6:
--:1E:E8:29:54:AC:7A:75:WPA2:1:
`;

  const parsed = parseNmcliWifiOutput(rows);
  assert.equal(parsed.length, 2);

  const active = parsed.find((network) => network.ssid === "Slaughternet-3.0");
  const guest = parsed.find((network) => network.ssid === "Slaughterguest");
  const hidden = parsed.find((network) => network.ssid === "--");

  assert.ok(active);
  assert.equal(active?.connected, true);
  assert.equal(active?.security, "wpa2");
  assert.equal(active?.signal, 85);
  assert.ok(guest);
  assert.equal(guest?.connected, false);
  assert.ok(hidden === undefined);
});
