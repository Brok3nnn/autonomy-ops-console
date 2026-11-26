// Builds the simulated road network from cached route geometry and finds
// detours over it. Pure functions: callers pass in everything they need.

import {
  CITY_NODES,
  NETWORK_NODE_SNAP_THRESHOLD_METERS,
  NETWORK_SEGMENT_MIN_METERS,
} from "../config.js";
import {
  findNearestPointOnCorridor,
  getCorridorSliceByMeters,
  haversineMeters,
  measureRoute,
  midpoint,
  routeStaysInsideBoundary,
} from "./geo.js";

/** Ordered [lat, lng] waypoints of a blueprint: from, optional via cities, to. */
export function buildRouteWaypoints(blueprint, cityNodes = CITY_NODES) {
  const from = cityNodes[blueprint.from];
  const to = cityNodes[blueprint.to];
  if (!from || !to) return [];
  const via = (blueprint.via ?? []).map((cityId) => cityNodes[cityId]).filter(Boolean);
  return [from, ...via, to];
}

/** All city ids that appear in the blueprints, including via cities. */
export function getNetworkNodeIds(blueprints, cityNodes = CITY_NODES) {
  const nodeIds = new Set();
  for (const blueprint of blueprints) {
    nodeIds.add(blueprint.from);
    nodeIds.add(blueprint.to);
    for (const cityId of blueprint.via ?? []) {
      if (cityNodes[cityId]) nodeIds.add(cityId);
    }
  }
  return [...nodeIds];
}

/** Adds cumulative distances to a blueprint with geometry. */
export function measureCorridor(blueprint, points) {
  const { cumulativeMeters, totalMeters } = measureRoute(points);
  return { ...blueprint, points, cumulativeMeters, totalMeters };
}

/**
 * Splits a corridor wherever it passes within the snap threshold of another
 * network city, so the planner graph has junctions at those cities.
 */
export function splitCorridorAtNetworkNodes(corridor, nodeIds, options = {}) {
  const {
    cityNodes = CITY_NODES,
    snapThresholdMeters = NETWORK_NODE_SNAP_THRESHOLD_METERS,
    minSegmentMeters = NETWORK_SEGMENT_MIN_METERS,
  } = options;
  if (!corridor?.points || corridor.points.length < 2) return [];

  const junctions = nodeIds
    .filter((cityId) => cityId !== corridor.from && cityId !== corridor.to)
    .map((cityId) => {
      const cityPoint = cityNodes[cityId];
      if (!cityPoint) return null;
      const nearest = findNearestPointOnCorridor(corridor, cityPoint);
      if (haversineMeters(cityPoint, nearest.point) > snapThresholdMeters) return null;
      if (
        nearest.offsetMeters <= minSegmentMeters ||
        nearest.offsetMeters >= corridor.totalMeters - minSegmentMeters
      ) {
        return null;
      }
      return { cityId, offsetMeters: nearest.offsetMeters };
    })
    .filter(Boolean)
    .sort((a, b) => a.offsetMeters - b.offsetMeters);

  const waypoints = [];
  for (const entry of [
    { cityId: corridor.from, offsetMeters: 0 },
    ...junctions,
    { cityId: corridor.to, offsetMeters: corridor.totalMeters },
  ]) {
    const last = waypoints[waypoints.length - 1];
    if (
      last &&
      (entry.cityId === last.cityId || entry.offsetMeters - last.offsetMeters < minSegmentMeters)
    ) {
      continue;
    }
    waypoints.push(entry);
  }

  if (waypoints.length <= 2) return [corridor];

  const segments = [];
  for (let index = 1; index < waypoints.length; index += 1) {
    const start = waypoints[index - 1];
    const end = waypoints[index];
    const points = getCorridorSliceByMeters(corridor, start.offsetMeters, end.offsetMeters);
    if (points.length < 2) continue;
    const measured = measureRoute(points);
    if (measured.totalMeters < minSegmentMeters) continue;
    segments.push({
      ...corridor,
      id: `${corridor.id}__${index}`,
      from: start.cityId,
      to: end.cityId,
      points,
      cumulativeMeters: measured.cumulativeMeters,
      totalMeters: measured.totalMeters,
      derivedFromCorridorId: corridor.id,
    });
  }

  return segments.length > 0 ? segments : [corridor];
}

/**
 * Turns blueprints plus cached geometry into the corridor network.
 * Corridors without usable geometry, or that leave the boundary, are skipped.
 * When two pieces connect the same pair of cities, an original corridor wins
 * over a piece split off a longer one.
 *
 * @returns {Record<string, object>} corridors keyed by id
 */
export function buildCorridorNetwork({ blueprints, routeCache, boundary, cityNodes = CITY_NODES }) {
  const nodeIds = getNetworkNodeIds(blueprints, cityNodes);
  const byPair = new Map();

  for (const blueprint of blueprints) {
    const points = routeCache?.[blueprint.id];
    if (!Array.isArray(points) || points.length <= 2) continue;
    if (!cityNodes[blueprint.from] || !cityNodes[blueprint.to]) continue;
    if (!routeStaysInsideBoundary(boundary, points)) continue;

    const corridor = measureCorridor(blueprint, points);
    for (const piece of splitCorridorAtNetworkNodes(corridor, nodeIds, { cityNodes })) {
      const pairKey = `${piece.from}->${piece.to}`;
      const existing = byPair.get(pairKey);
      if (!existing || (!piece.derivedFromCorridorId && existing.derivedFromCorridorId)) {
        byPair.set(pairKey, piece);
      }
    }
  }

  const corridors = {};
  for (const corridor of byPair.values()) corridors[corridor.id] = corridor;
  return corridors;
}

/** Undirected graph: city id -> edges, one per corridor direction. */
export function buildPlannerGraph(corridors) {
  const graph = new Map();
  const addEdge = (fromId, toId, corridorId, forward, cost) => {
    if (!graph.has(fromId)) graph.set(fromId, []);
    graph.get(fromId).push({ fromId, toId, corridorId, forward, cost });
  };

  for (const corridor of Object.values(corridors)) {
    if (!Array.isArray(corridor?.points) || corridor.points.length < 2) continue;
    addEdge(corridor.from, corridor.to, corridor.id, true, corridor.totalMeters);
    addEdge(corridor.to, corridor.from, corridor.id, false, corridor.totalMeters);
  }
  return graph;
}

/**
 * Dijkstra over the planner graph. `penalties` adds extra cost per corridor
 * id, which is how alternative routes are pushed away from earlier ones.
 */
export function findShortestRoutePath(
  graph,
  fromId,
  toId,
  { blockedCorridorIds = new Set(), penalties = new Map() } = {},
) {
  if (!graph.has(fromId) || !graph.has(toId)) return null;

  const rankCosts = new Map([[fromId, 0]]);
  const previous = new Map();
  const queue = [{ nodeId: fromId, rankCost: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.rankCost - b.rankCost);
    const current = queue.shift();
    if (current.rankCost > (rankCosts.get(current.nodeId) ?? Number.POSITIVE_INFINITY)) continue;
    if (current.nodeId === toId) break;

    for (const edge of graph.get(current.nodeId) ?? []) {
      if (blockedCorridorIds.has(edge.corridorId)) continue;
      const nextRankCost = current.rankCost + edge.cost + (penalties.get(edge.corridorId) || 0);
      if (nextRankCost >= (rankCosts.get(edge.toId) ?? Number.POSITIVE_INFINITY)) continue;
      rankCosts.set(edge.toId, nextRankCost);
      previous.set(edge.toId, { nodeId: current.nodeId, edge });
      queue.push({ nodeId: edge.toId, rankCost: nextRankCost });
    }
  }

  if (!previous.has(toId)) return null;

  const nodePath = [toId];
  const segments = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = previous.get(cursor);
    if (!step?.edge) return null;
    segments.unshift(step.edge);
    nodePath.unshift(step.nodeId);
    cursor = step.nodeId;
  }

  const totalMeters = segments.reduce((sum, segment) => sum + segment.cost, 0);
  return { nodePath, segments, totalMeters, rankCost: rankCosts.get(toId) ?? totalMeters };
}

function findRouteViaCity(graph, fromId, viaCityId, toId, blockedCorridorIds) {
  if (!viaCityId || viaCityId === fromId || viaCityId === toId) return null;
  const firstLeg = findShortestRoutePath(graph, fromId, viaCityId, { blockedCorridorIds });
  const secondLeg = findShortestRoutePath(graph, viaCityId, toId, { blockedCorridorIds });
  if (!firstLeg?.segments.length || !secondLeg?.segments.length) return null;

  return {
    nodePath: [...firstLeg.nodePath, ...secondLeg.nodePath.slice(1)],
    segments: [...firstLeg.segments, ...secondLeg.segments],
    totalMeters: firstLeg.totalMeters + secondLeg.totalMeters,
    rankCost: firstLeg.rankCost + secondLeg.rankCost,
  };
}

/** The ten cities that make the shortest detour between two cities. */
export function buildViaCandidates(fromId, toId, cityNodes = CITY_NODES) {
  const from = cityNodes[fromId];
  const to = cityNodes[toId];
  if (!from || !to) return [];

  const center = midpoint(from, to);
  return Object.entries(cityNodes)
    .filter(([cityId]) => cityId !== fromId && cityId !== toId)
    .map(([cityId, point]) => ({
      cityId,
      score:
        haversineMeters(from, point) +
        haversineMeters(point, to) +
        haversineMeters(point, center) * 0.25,
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
    .map((entry) => entry.cityId);
}

/**
 * Up to `limit` distinct routes between two cities that avoid the blocked
 * corridors. Candidates come from the shortest path, routes via nearby
 * cities, and re-runs with each used corridor blocked or penalised.
 *
 * @returns {{ nodePath: string[], segmentRefs: { corridorId: string, forward: boolean }[] }[]}
 */
export function findDetourRoutes(
  corridors,
  fromId,
  toId,
  { limit = 3, blockedCorridorIds = new Set(), cityNodes = CITY_NODES } = {},
) {
  const graph = buildPlannerGraph(corridors);
  const accepted = [];
  const queued = [];
  const seen = new Set();
  let expansions = 0;

  const addCandidate = (candidate) => {
    if (!candidate?.segments?.length) return;
    const signature = candidate.nodePath.join("->");
    if (seen.has(signature)) return;
    seen.add(signature);
    queued.push(candidate);
  };

  addCandidate(findShortestRoutePath(graph, fromId, toId, { blockedCorridorIds }));
  for (const viaCityId of buildViaCandidates(fromId, toId, cityNodes).slice(0, 8)) {
    addCandidate(findRouteViaCity(graph, fromId, viaCityId, toId, blockedCorridorIds));
  }

  while (accepted.length < limit && queued.length > 0 && expansions < 120) {
    queued.sort((a, b) => a.rankCost - b.rankCost);
    const candidate = queued.shift();
    accepted.push(candidate);

    for (const segment of candidate.segments) {
      const blocked = new Set(blockedCorridorIds);
      blocked.add(segment.corridorId);
      addCandidate(findShortestRoutePath(graph, fromId, toId, { blockedCorridorIds: blocked }));
      expansions += 1;
    }

    const penalties = new Map();
    accepted.forEach((routePath, index) => {
      for (const segment of routePath.segments) {
        penalties.set(
          segment.corridorId,
          (penalties.get(segment.corridorId) || 0) + segment.cost * (0.36 + index * 0.2),
        );
      }
    });
    addCandidate(findShortestRoutePath(graph, fromId, toId, { blockedCorridorIds, penalties }));
    expansions += 1;
  }

  return accepted.slice(0, limit).map((candidate) => ({
    nodePath: candidate.nodePath,
    segmentRefs: candidate.segments.map(({ corridorId, forward }) => ({ corridorId, forward })),
  }));
}
