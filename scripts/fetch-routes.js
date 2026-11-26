#!/usr/bin/env node
// Regenerates public/data/osrm-routes.json from the public OSRM servers.
//
//   npm run routes:fetch               all corridors
//   npm run routes:fetch -- c12 c14    only these corridors
//
// The servers are free community services (FOSSGIS) that allow at most one
// request per second and no heavy use. This script runs by hand, one request
// at a time, and the app only ever reads the generated file.

import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { CORRIDOR_BLUEPRINTS } from "../public/js/config.js";
import { buildRouteWaypoints } from "../public/js/lib/corridors.js";
import { prepareBoundary, routeStaysInsideBoundary } from "../public/js/lib/geo.js";

const ROUTES_FILE = new URL("../public/data/osrm-routes.json", import.meta.url);
const BOUNDARY_FILE = new URL("../public/data/austria-boundary.json", import.meta.url);
const OSRM_ENDPOINTS = [
  "https://routing.openstreetmap.de/routed-car/route/v1/driving/",
  "https://router.project-osrm.org/route/v1/driving/",
];
const USER_AGENT =
  "autonomy-ops-console route cache builder (+https://github.com/Brok3nnn/autonomy-ops-console)";
const REQUEST_GAP_MS = 1100;
const TIMEOUT_MS = 20000;

const round6 = (value) => Math.round(value * 1e6) / 1e6;

async function fetchRoute(waypoints) {
  const coordinates = waypoints.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const errors = [];
  for (const [index, endpoint] of OSRM_ENDPOINTS.entries()) {
    if (index > 0) await sleep(REQUEST_GAP_MS);
    try {
      const response = await fetch(
        `${endpoint}${coordinates}?overview=full&geometries=geojson&steps=false`,
        {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geometry = (await response.json())?.routes?.[0]?.geometry?.coordinates;
      if (!Array.isArray(geometry) || geometry.length < 2) throw new Error("no route geometry");
      return { points: geometry.map(([lng, lat]) => [round6(lat), round6(lng)]), endpoint };
    } catch (error) {
      errors.push(`${new URL(endpoint).host}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

async function main() {
  const requested = new Set(process.argv.slice(2));
  const blueprints = CORRIDOR_BLUEPRINTS.filter(
    (blueprint) => requested.size === 0 || requested.has(blueprint.id),
  );
  const unknown = [...requested].filter(
    (id) => !CORRIDOR_BLUEPRINTS.some((blueprint) => blueprint.id === id),
  );
  if (unknown.length > 0) throw new Error(`Unknown corridor id(s): ${unknown.join(", ")}`);

  const boundary = prepareBoundary(JSON.parse(await readFile(BOUNDARY_FILE, "utf8")));
  let cache = {};
  try {
    cache = JSON.parse(await readFile(ROUTES_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let failures = 0;
  for (const [index, blueprint] of blueprints.entries()) {
    if (index > 0) await sleep(REQUEST_GAP_MS);
    try {
      const { points, endpoint } = await fetchRoute(buildRouteWaypoints(blueprint));
      if (!routeStaysInsideBoundary(boundary, points))
        throw new Error("route leaves the Austria boundary");
      cache[blueprint.id] = points;
      console.log(`${blueprint.id}: ${points.length} points from ${new URL(endpoint).host}`);
    } catch (error) {
      failures += 1;
      console.error(`${blueprint.id}: kept the cached route (${error.message})`);
    }
  }

  // One corridor per line, in blueprint order, keeps diffs readable.
  const lines = CORRIDOR_BLUEPRINTS.filter((blueprint) => cache[blueprint.id]).map(
    (blueprint) => `${JSON.stringify(blueprint.id)}:${JSON.stringify(cache[blueprint.id])}`,
  );
  await writeFile(ROUTES_FILE, `{\n${lines.join(",\n")}\n}\n`);
  console.log(`Wrote ${lines.length} corridors to public/data/osrm-routes.json`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
