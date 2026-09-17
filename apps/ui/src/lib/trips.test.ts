import test from "node:test";
import assert from "node:assert/strict";

import {
  appendTripBreadcrumb,
  finalizeTripLog,
  shouldEndTripAtHome,
  summarizeTripLog,
  startTripLog
} from "./trips.js";

test("startTripLog creates a trip payload with one breadcrumb", () => {
  const trip = startTripLog({
    latitude: 34.2,
    longitude: -76.8,
    speedKnots: 6.1,
    headingDegrees: 141,
    depthFeet: 18,
    waterTempF: 70.2,
    engineRpmTotal: 1800,
    engineTempAvgF: 141,
    engineTempMaxF: 146,
    fuelBurnGph: 26.1,
    engineVoltageAvg: 13.9,
    portRpm: 600,
    centerRpm: 600,
    starboardRpm: 600,
    wind: "12 kt SW",
    barometer: "1013 hPa",
    networkStatus: "Online",
    source: "NMEA 2000 via Signal K"
  });

  assert.equal(trip.breadcrumbs.length, 1);
  assert.equal(trip.title.startsWith("Trip"), true);
  assert.ok(trip.distanceNm >= 0);
});

test("appendTripBreadcrumb extends the route and updates the summary", () => {
  const trip = startTripLog({
    latitude: 34.2,
    longitude: -76.8,
    speedKnots: 6.1,
    headingDegrees: 141,
    depthFeet: 18,
    waterTempF: 70.2,
    engineRpmTotal: 1800,
    engineTempAvgF: 141,
    engineTempMaxF: 146,
    fuelBurnGph: 26.1,
    engineVoltageAvg: 13.9,
    portRpm: 600,
    centerRpm: 600,
    starboardRpm: 600,
    wind: "12 kt SW",
    barometer: "1013 hPa",
    networkStatus: "Online",
    source: "NMEA 2000 via Signal K"
  });

  const next = appendTripBreadcrumb(trip, {
    latitude: 34.2501,
    longitude: -76.7,
    speedKnots: 7.2,
    headingDegrees: 145,
    depthFeet: 17,
    waterTempF: 70.4,
    engineRpmTotal: 2040,
    engineTempAvgF: 144,
    engineTempMaxF: 149,
    fuelBurnGph: 28.4,
    engineVoltageAvg: 13.8,
    portRpm: 680,
    centerRpm: 680,
    starboardRpm: 680,
    wind: "14 kt SW",
    barometer: "1012 hPa",
    networkStatus: "Online",
    source: "NMEA 2000 via Signal K"
  });

  assert.equal(next.breadcrumbs.length, 2);
  assert.ok(next.distanceNm > 0.2);
  assert.ok(summarizeTripLog(next).includes("Trip"));
});

test("finalizeTripLog stamps the end time and preserves summary metadata", () => {
  const trip = startTripLog({
    latitude: 34.2,
    longitude: -76.8,
    speedKnots: 4,
    headingDegrees: 90,
    depthFeet: 20,
    waterTempF: 72,
    engineRpmTotal: 1320,
    engineTempAvgF: 139,
    engineTempMaxF: 143,
    fuelBurnGph: 19.2,
    engineVoltageAvg: 14,
    portRpm: 440,
    centerRpm: 440,
    starboardRpm: 440,
    wind: "8 kt N",
    barometer: "1015 hPa",
    networkStatus: "Online",
    source: "NMEA 2000 via Signal K"
  });

  const finalized = finalizeTripLog(trip);
  assert.ok(finalized.endedAt !== null);
  assert.equal(finalized.tag, "Trip complete");
});

test("shouldEndTripAtHome closes a trip when the vessel returns near the launch point", () => {
  const homeLat = 34.2;
  const homeLon = -76.8;

  assert.equal(shouldEndTripAtHome(homeLat, homeLon, homeLat, homeLon, 0.12), true);
  assert.equal(shouldEndTripAtHome(homeLat, homeLon, 34.20056, -76.7992, 0.12), true);
  assert.equal(shouldEndTripAtHome(homeLat, homeLon, 34.25, -76.7, 0.12), false);
});
