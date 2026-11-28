import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CORRIDOR_BLUEPRINTS, TX_NODES } from "../public/js/config.js";
import {
  CONTROL_STATE_CLOSED,
  buildAuthoritySnapshot,
  buildFeedSignals,
  dedupeSignals,
  hashString,
  signalWindow,
} from "../public/js/lib/authority.js";
import {
  buildCorridorNetwork,
  buildPlannerGraph,
  findDetourRoutes,
  findShortestRoutePath,
  splitCorridorAtNetworkNodes,
} from "../public/js/lib/corridors.js";
import {
  escapeHtml,
  formatAffectedDistance,
  formatCityName,
  formatMinutesSeconds,
} from "../public/js/lib/format.js";
import {
  getCorridorSlice,
  getPointAtDistance,
  haversineMeters,
  isPointInsideBoundary,
  measureRoute,
  prepareBoundary,
  routeStaysInsideBoundary,
} from "../public/js/lib/geo.js";
import { nearestNodeId, nextSparkline, sparklinePath } from "../public/js/lib/telemetry.js";
import {
  advanceOffset,
  computeProgress,
  createVehicles,
  nextAlert,
  releaseEmergencyLatch,
  resolveVehicleHealth,
  stepVehicle,
  summarizeFleet,
  toStatusClass,
} from "../public/js/lib/vehicle-state.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const boundaryGeojson = readJson("../public/data/austria-boundary.json");
const routeCache = readJson("../public/data/osrm-routes.json");
const boundary = prepareBoundary(boundaryGeojson);

/** Deterministic random source cycling through the given values. */
const sequence = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const VIENNA = [48.2082, 16.3738];
const GRAZ = [47.0707, 15.4395];
const straight = { points: [VIENNA, GRAZ], ...measureRoute([VIENNA, GRAZ]) };

describe("geo", () => {
  it("measures great-circle distances", () => {
    const km = haversineMeters(VIENNA, GRAZ) / 1000;
    assert.ok(km > 144 && km < 147, `Vienna-Graz was ${km} km`);
  });

  it("samples points along a route", () => {
    const [lat, lng] = getPointAtDistance(straight, straight.totalMeters / 2);
    assert.ok(Math.abs(lat - (VIENNA[0] + GRAZ[0]) / 2) < 1e-9);
    assert.ok(Math.abs(lng - (VIENNA[1] + GRAZ[1]) / 2) < 1e-9);
    assert.deepEqual(getPointAtDistance(straight, straight.totalMeters * 2), GRAZ);
    assert.equal(getCorridorSlice(straight, 0.25, 0.5).length, 2);
  });

  it("knows what is inside Austria", () => {
    assert.equal(isPointInsideBoundary(boundary, VIENNA), true);
    assert.equal(isPointInsideBoundary(boundary, [48.1351, 11.582]), false); // Munich
    assert.equal(routeStaysInsideBoundary(boundary, [VIENNA, GRAZ]), true);
  });
});

describe("route cache and corridor network", () => {
  it("has geometry inside Austria for every blueprint", () => {
    for (const blueprint of CORRIDOR_BLUEPRINTS) {
      const points = routeCache[blueprint.id];
      assert.ok(Array.isArray(points) && points.length > 2, `missing route ${blueprint.id}`);
      assert.ok(routeStaysInsideBoundary(boundary, points), `${blueprint.id} leaves Austria`);
    }
  });

  it("splits corridors at junction cities and keeps every piece routable", () => {
    const corridors = buildCorridorNetwork({
      blueprints: CORRIDOR_BLUEPRINTS,
      routeCache,
      boundary,
    });
    const pieces = Object.values(corridors);
    assert.ok(pieces.length >= CORRIDOR_BLUEPRINTS.length);
    assert.ok(pieces.some((corridor) => corridor.derivedFromCorridorId === "c12"));
    for (const corridor of pieces) assert.ok(corridor.totalMeters > 3500);

    const graph = buildPlannerGraph(corridors);
    assert.ok(findShortestRoutePath(graph, "vienna", "bregenz"), "no route across Austria");
  });

  it("does not split a corridor that passes no other city", () => {
    const corridor = { id: "x", from: "vienna", to: "graz", ...straight };
    assert.deepEqual(splitCorridorAtNetworkNodes(corridor, ["vienna", "graz"]), [corridor]);
  });

  it("finds detours that avoid blocked corridors", () => {
    const corridors = buildCorridorNetwork({
      blueprints: CORRIDOR_BLUEPRINTS,
      routeCache,
      boundary,
    });
    const direct = Object.values(corridors).find((corridor) => corridor.from === "vienna");
    const detours = findDetourRoutes(corridors, direct.from, direct.to, {
      blockedCorridorIds: new Set([direct.id]),
    });
    assert.ok(detours.length > 0);
    for (const detour of detours) {
      assert.ok(detour.segmentRefs.every((ref) => ref.corridorId !== direct.id));
    }
  });
});

describe("vehicle state", () => {
  const vehicle = (overrides = {}) => ({
    id: "AT-AV-701",
    speedKmh: 72,
    currentSpeedKmh: 72,
    offsetMeters: 0,
    alert: "none",
    status: "Approved",
    emergencyLatched: false,
    emergencyNotified: false,
    ...overrides,
  });

  it("derives health from status and alert", () => {
    assert.equal(resolveVehicleHealth("Approved", "none"), "ok");
    assert.equal(resolveVehicleHealth("Conditional", "none"), "warn");
    assert.equal(resolveVehicleHealth("Approved", "warn"), "warn");
    assert.equal(resolveVehicleHealth("Approved", "critical"), "critical");
    assert.equal(toStatusClass("Emergency"), "status-hold");
  });

  it("moves vehicles and wraps at the end of the corridor", () => {
    assert.equal(advanceOffset(0, 72, 10, 1000), 200);
    assert.equal(advanceOffset(950, 72, 10, 1000), 150);
    assert.equal(advanceOffset(500, 0, 10, 1000), 500);
  });

  it("latches an emergency, stops the vehicle and reports it once", () => {
    const v = vehicle({ alert: "critical" });
    const context = { status: "Approved", zone: "A-01", totalMeters: 10000, deltaSec: 1 };
    assert.equal(stepVehicle(v, context), true);
    assert.equal(v.operationalState, "Emergency");
    assert.equal(v.currentSpeedKmh, 0);
    assert.equal(v.emergencyLatched, true);

    v.alert = "none";
    assert.equal(stepVehicle(v, context), false);
    assert.equal(v.health, "critical", "the latch holds until an operator resumes");
  });

  it("resumes a latched vehicle", () => {
    const v = vehicle({
      alert: "critical",
      emergencyLatched: true,
      health: "critical",
      currentSpeedKmh: 0,
    });
    assert.equal(releaseEmergencyLatch(v), true);
    assert.equal(v.operationalState, "Good");
    assert.equal(v.currentSpeedKmh, 72);
    assert.equal(releaseEmergencyLatch(vehicle({ status: "Hold" })), false);
  });

  it("walks telemetry alerts with an injected random source", () => {
    assert.deepEqual(nextAlert(vehicle(), sequence(0.99)), { alert: "warn", degraded: true });
    assert.deepEqual(nextAlert(vehicle(), sequence(0.5)), { alert: "none", degraded: false });
    assert.deepEqual(nextAlert(vehicle({ alert: "warn" }), sequence(0.7)), {
      alert: "none",
      degraded: false,
    });
    assert.equal(
      nextAlert(vehicle({ alert: "critical", emergencyLatched: true }), sequence(0.99)).alert,
      "critical",
    );
  });

  it("creates a fleet and summarises it", () => {
    const corridors = {
      a: { id: "a", zone: "A-01", totalMeters: 1000 },
      b: { id: "b", zone: "A-02", totalMeters: 2000 },
    };
    const fleet = createVehicles(corridors, 5, {
      getStatus: () => "Approved",
      random: sequence(0.3, 0.6),
    });
    assert.deepEqual(
      fleet.map((v) => v.id),
      ["AT-AV-701", "AT-AV-702", "AT-AV-703", "AT-AV-704", "AT-AV-705"],
    );
    fleet[0].operationalState = "Emergency";
    fleet[0].currentSpeedKmh = 0;
    const summary = summarizeFleet(fleet);
    assert.equal(summary.total, 5);
    assert.equal(summary.emergency, 1);
    assert.equal(summary.stopped, 1);
  });

  it("computes progress and ETA", () => {
    assert.deepEqual(computeProgress(500, 1000, 36), { progressPct: 50, etaMinutes: 1 });
    assert.deepEqual(computeProgress(0, 60000, 60), { progressPct: 0, etaMinutes: 60 });
    assert.equal(computeProgress(10, 1000, 0).etaMinutes, null);
  });
});

describe("authority signals", () => {
  it("is deterministic per seed", () => {
    assert.equal(hashString("c1"), hashString("c1"));
    assert.notEqual(hashString("c1"), hashString("c2"));
    const window = signalWindow("c1:weather", 42, 6);
    assert.deepEqual(window, signalWindow("c1:weather", 42, 6));
    assert.ok(
      window.startRatio >= 0.06 && window.endRatio <= 0.96 && window.startRatio < window.endRatio,
    );
    assert.ok(window.minutesAgo >= 3 && window.minutesAgo <= 14);
  });

  it("keeps the strongest signal per corridor and type", () => {
    const signals = [
      { corridorId: "c1", type: "accident", severity: 40, minutesAgo: 5 },
      { corridorId: "c1", type: "accident", severity: 70, minutesAgo: 9 },
      { corridorId: "c1", type: "accident", severity: 70, minutesAgo: 4 },
      { corridorId: "c2", type: "accident", severity: 10, minutesAgo: 1 },
    ];
    assert.deepEqual(
      dedupeSignals(signals).map((s) => [s.corridorId, s.severity, s.minutesAgo]),
      [
        ["c1", 70, 4],
        ["c2", 10, 1],
      ],
    );
  });

  it("puts blocked segments first with full risk and a detour signal", () => {
    const corridors = Object.values(
      buildCorridorNetwork({ blueprints: CORRIDOR_BLUEPRINTS, routeCache, boundary }),
    );
    const blocked = corridors[3];
    const cache = { bucket: null, cores: {} };
    const snapshot = buildAuthoritySnapshot({
      corridors,
      vehicles: [],
      feed: [],
      inputs: { weather: 26, news: 24, incidents: 22 },
      rules: { [blocked.id]: CONTROL_STATE_CLOSED },
      nowMs: Date.UTC(2026, 10, 26, 9, 0, 0),
      cache,
    });
    assert.equal(snapshot.segments[0].corridorId, blocked.id);
    assert.equal(snapshot.segments[0].riskScore, 100);
    assert.ok(snapshot.segments[0].items.some((item) => item.type === "detour"));
    assert.ok(snapshot.mapSignals.every((signal) => signal.corridorId !== blocked.id));
    assert.equal(Object.keys(cache.cores).length, corridors.length);
  });

  it("does not turn transmission node events into road signals", () => {
    const corridors = Object.values(
      buildCorridorNetwork({ blueprints: CORRIDOR_BLUEPRINTS, routeCache, boundary }),
    );
    const feed = TX_NODES.map((node) => ({
      text: `[NODE ${node.id}] Initiating remote power cycle...`,
      severity: "warn",
    }));
    for (const corridor of corridors) {
      assert.deepEqual(buildFeedSignals(corridor, [], feed, 0), [], corridor.id);
    }
  });
});

describe("formatting and telemetry helpers", () => {
  it("formats text for the UI", () => {
    assert.equal(escapeHtml(`<b title="x">&'`), "&lt;b title=&quot;x&quot;&gt;&amp;&#39;");
    assert.equal(formatCityName("stpoelten"), "St. Pölten");
    assert.equal(formatCityName("graz"), "Graz");
    assert.equal(formatAffectedDistance(437), "Affected 440 m");
    assert.equal(formatAffectedDistance(2450), "Affected 2.5 km");
    assert.equal(formatMinutesSeconds(425), "07:05");
  });

  it("assigns units to the nearest node and keeps sparklines in range", () => {
    const nodes = [
      { id: "TX-2", city: "vienna" },
      { id: "TX-4", city: "graz" },
    ];
    assert.equal(nearestNodeId([48.1, 16.2], nodes), "TX-2");
    const next = nextSparkline([10, 95], sequence(1));
    assert.deepEqual(next, [95, 95]);
    assert.equal(sparklinePath([0, 100], 400, 40), "M 0,40 L 400,0");
  });
});
