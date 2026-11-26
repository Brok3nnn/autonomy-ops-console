// Area Approval model: per-segment control state, simulated road signals and
// the risk summary shown on the map. Pure functions; the view passes in the
// corridors, vehicles, feed and risk inputs.
//
// Signals are simulated but deterministic: positions, ages and scenario texts
// come from a string hash of the corridor id and the current 15-minute bucket,
// so the map does not flicker between renders.

import { AUTHORITY_SIGNAL_REFRESH_MS, AUTHORITY_SIGNAL_TYPES } from "../config.js";
import { formatCityName, formatCorridorLabel } from "./format.js";
import { clamp, getCorridorSlice, getPointAtDistance, measureRoute } from "./geo.js";

export const CONTROL_STATE_OPEN = "open";
export const CONTROL_STATE_CLOSED = "closed";

/** A segment is open unless an operator blocked it. */
export function getControlState(rules, corridorId) {
  return rules[corridorId] ?? CONTROL_STATE_OPEN;
}

export function controlStateLabel(controlState) {
  return controlState === CONTROL_STATE_CLOSED ? "Blocked" : "Allowed";
}

export function controlStateBadgeClass(controlState) {
  return controlState === CONTROL_STATE_CLOSED ? "is-closed" : "is-open";
}

/** Authority status a vehicle inherits from its segment. */
export function controlStateToVehicleStatus(controlState) {
  return controlState === CONTROL_STATE_OPEN ? "Approved" : "Conditional";
}

/** Java-style 32-bit string hash, made non-negative. */
export function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Deterministic number in (0, 1] for a seed and salt. */
export function hashRatio(seed, salt = 0) {
  return ((hashString(`${seed}:${salt}`) % 1000) + 1) / 1000;
}

export function signalBucket(nowMs) {
  return Math.floor(nowMs / AUTHORITY_SIGNAL_REFRESH_MS);
}

export function signalTypeStyle(type) {
  return AUTHORITY_SIGNAL_TYPES[type] ?? AUTHORITY_SIGNAL_TYPES.disruption;
}

const SIGNAL_SCENARIOS = {
  disruption: [
    {
      titleSuffix: "low visibility pocket",
      summary:
        "Fog, spray, or glare has reduced forward visibility through this section and is compressing lane throughput.",
      recommendedAction: "Reduce speed window",
      sourceLabel: "Open-Meteo",
    },
    {
      titleSuffix: "surface instability",
      summary:
        "Standing water, unstable grip, or debris risk is raising control effort on this carriageway section.",
      recommendedAction: "Monitor closely",
      sourceLabel: "Road Weather Fusion",
    },
    {
      titleSuffix: "queue spillback",
      summary:
        "Traffic density is stacking backward into this road section and creating short-notice braking behaviour.",
      recommendedAction: "Watch closely",
      sourceLabel: "Traffic Flow Monitor",
    },
    {
      titleSuffix: "crosswind exposure",
      summary:
        "Localized crosswind or weather exposure is reducing lane stability for vehicles passing this stretch.",
      recommendedAction: "Reduce speed window",
      sourceLabel: "Open-Meteo",
    },
  ],
  accident: [
    {
      titleSuffix: "collision response",
      summary:
        "Crash response activity is constraining usable road space and increasing conflict risk in this area.",
      recommendedAction: "Block road",
      sourceLabel: "Incident Fusion",
    },
    {
      titleSuffix: "stopped vehicle recovery",
      summary:
        "A stopped or damaged vehicle is being cleared from this segment, narrowing safe passage width.",
      recommendedAction: "Monitor",
      sourceLabel: "Fleet Ops",
    },
    {
      titleSuffix: "hard braking cluster",
      summary:
        "Repeated hard-braking events suggest unstable vehicle behaviour and elevated rear-end collision risk here.",
      recommendedAction: "Monitor",
      sourceLabel: "Telemetry Fusion",
    },
    {
      titleSuffix: "lane obstruction",
      summary:
        "An object, recovery unit, or shoulder incursion is affecting lane discipline across this span.",
      recommendedAction: "Block road",
      sourceLabel: "Incident Fusion",
    },
  ],
  police_closure: [
    {
      titleSuffix: "checkpoint control",
      summary:
        "Police control is narrowing access through this motorway section and causing intermittent stoppages.",
      recommendedAction: "Block road",
      sourceLabel: "Authority / News",
    },
    {
      titleSuffix: "protest perimeter",
      summary:
        "A managed protest or public-safety perimeter is limiting continuous passage across this segment.",
      recommendedAction: "Watch closely",
      sourceLabel: "Authority / News",
    },
    {
      titleSuffix: "escort hold",
      summary:
        "Temporary authority hold windows are interrupting road availability while supervised passage is managed.",
      recommendedAction: "Block road",
      sourceLabel: "Authority / News",
    },
    {
      titleSuffix: "controlled closure",
      summary:
        "Access control has been imposed on this section, with lane entry being managed by local authorities.",
      recommendedAction: "Block road",
      sourceLabel: "Authority / News",
    },
  ],
  detour: [
    {
      titleSuffix: "detour activation",
      summary:
        "Traffic is being redirected off this segment while an operator restriction remains active.",
      recommendedAction: "Keep blocked",
      sourceLabel: "Operator Override",
    },
    {
      titleSuffix: "reroute corridor",
      summary:
        "A controlled detour is routing vehicles away from this span until the road can be revalidated.",
      recommendedAction: "Keep blocked",
      sourceLabel: "Operator Override",
    },
    {
      titleSuffix: "temporary diversion",
      summary:
        "This section remains under diversion control and is not available for normal automated passage.",
      recommendedAction: "Keep blocked",
      sourceLabel: "Operator Override",
    },
  ],
};

export function pickScenario(seed, type) {
  const scenarios = SIGNAL_SCENARIOS[type] ?? SIGNAL_SCENARIOS.disruption;
  return scenarios[hashString(`${seed}:${type}:scenario`) % scenarios.length];
}

/** Where on a corridor a signal sits, and how long ago it was "reported". */
export function signalWindow(seed, bucket, salt = 0) {
  const baseSeed = `${seed}:${bucket}`;
  const startRatio = clamp(0.08 + hashRatio(baseSeed, salt) * 0.68, 0.06, 0.84);
  const lengthRatio = 0.09 + hashRatio(baseSeed, salt + 1) * 0.16;
  const endRatio = clamp(startRatio + lengthRatio, startRatio + 0.05, 0.96);
  return {
    startRatio,
    endRatio,
    midpointRatio: clamp((startRatio + endRatio) / 2, 0.08, 0.94),
    minutesAgo: 3 + Math.round(hashRatio(baseSeed, salt + 2) * 11),
  };
}

export function createSignal(
  corridor,
  window,
  { type, severity, title, summary, recommendedAction, sourceLabel },
) {
  const style = signalTypeStyle(type);
  const spanCoordinates = getCorridorSlice(corridor, window.startRatio, window.endRatio);
  return {
    id: `${corridor.id}:${type}:${title}`,
    corridorId: corridor.id,
    type,
    typeLabel: style.label,
    badge: style.badge,
    severity: Math.round(clamp(severity, 1, 100)),
    minutesAgo: clamp(Math.round(window.minutesAgo), 1, 60),
    title,
    summary,
    recommendedAction,
    sourceLabel,
    spanCoordinates,
    spanMeters: spanCoordinates.length > 1 ? measureRoute(spanCoordinates).totalMeters : 0,
    point: getPointAtDistance(
      corridor,
      corridor.totalMeters * clamp(window.midpointRatio, 0.05, 0.95),
    ),
  };
}

/** Classifies an operational feed message by keyword. */
export function inferSignalTypeFromText(text) {
  const lower = String(text).toLowerCase();
  if (lower.includes("police") || lower.includes("authority") || lower.includes("closure"))
    return "police_closure";
  if (lower.includes("detour") || lower.includes("diversion") || lower.includes("reroute"))
    return "detour";
  if (lower.includes("weather") || lower.includes("rain") || lower.includes("visibility"))
    return "disruption";
  if (lower.includes("protest") || lower.includes("disruption") || lower.includes("traffic"))
    return "disruption";
  return "accident";
}

/**
 * Up to two signals from feed messages that mention the corridor's cities,
 * its zone code or one of its vehicles.
 */
export function buildFeedSignals(corridor, vehicles, feed, bucket) {
  const cityTokens = [formatCityName(corridor.from), formatCityName(corridor.to)].map((name) =>
    name.toLowerCase(),
  );
  const zoneToken = String(corridor.zone || "")
    .toLowerCase()
    .split(" ")[0];
  const vehicleIds = vehicles.map((vehicle) => vehicle.id.toLowerCase());
  const label = formatCorridorLabel(corridor);

  return feed
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      const text = String(entry.text || "").toLowerCase();
      return (
        cityTokens.some((token) => text.includes(token)) ||
        (zoneToken && text.includes(zoneToken)) ||
        vehicleIds.some((vehicleId) => text.includes(vehicleId))
      );
    })
    .slice(0, 2)
    .map(({ entry, index }) => {
      const type = inferSignalTypeFromText(entry.text);
      const isCritical = entry.severity === "critical";
      return createSignal(
        corridor,
        signalWindow(`${corridor.id}:feed:${index}`, bucket, index * 4),
        {
          type,
          severity: isCritical ? 78 - index * 8 : 52 - index * 6,
          title: `${label} ${signalTypeStyle(type).label.toLowerCase()}`,
          summary: entry.text,
          recommendedAction: isCritical ? "Block road" : "Monitor",
          sourceLabel: "Operational Feed",
        },
      );
    });
}

/**
 * The part of a segment summary that stays fixed for a 15-minute bucket:
 * a base risk score from the road-risk inputs, the corridor's location and the
 * vehicles on it, plus the simulated signals.
 *
 * @param {object} corridor
 * @param {{ vehicles: object[], feed: object[], inputs: { weather: number, news: number, incidents: number }, bucket: number }} context
 *   `vehicles` are the vehicles on this corridor.
 */
export function buildSegmentCore(corridor, { vehicles, feed, inputs, bucket }) {
  const seed = corridor.id;
  const label = formatCorridorLabel(corridor);
  const [midLat, midLng] = getPointAtDistance(corridor, corridor.totalMeters * 0.5);
  const warningVehicles = vehicles.filter((vehicle) => vehicle.alert === "warn").length;
  const emergencyVehicles = vehicles.filter((vehicle) => vehicle.health === "critical").length;
  const feedSignals = buildFeedSignals(corridor, vehicles, feed, bucket);
  const feedFactor = feedSignals.reduce(
    (sum, signal) => sum + signal.severity * (signal.type === "accident" ? 0.22 : 0.32),
    0,
  );

  // Exposure heuristics: the Alps are south of ~47.7°N, the eastern urban belt
  // is east of ~14.8°E, and the borders are far from the 13.4°E centre line.
  const alpineExposure = clamp((47.7 - midLat) / 0.95, 0, 1);
  const easternUrbanExposure = clamp((midLng - 14.8) / 2.2, 0, 1);
  const borderExposure = clamp(Math.abs(13.4 - midLng) / 3.2, 0, 1);

  const weatherFactor = inputs.weather * (0.52 + alpineExposure * 0.72 + borderExposure * 0.12);
  const newsFactor =
    inputs.news * (0.38 + easternUrbanExposure * 0.66 + hashRatio(seed, 2) * 0.14) +
    feedFactor * 0.28;
  const incidentFactor =
    inputs.incidents * (0.34 + (vehicles.length > 0 ? 0.18 : 0) + hashRatio(seed, 3) * 0.18) +
    emergencyVehicles * 28 +
    warningVehicles * 9 +
    vehicles.length * 1.4 +
    feedFactor * 0.44;

  const items = [...feedSignals];
  const addScenarioSignal = (key, salt, type, severity, blockThreshold, sourceLabel) => {
    const scenario = pickScenario(`${seed}:${key}`, type);
    items.push(
      createSignal(corridor, signalWindow(`${seed}:${key}`, bucket, salt), {
        type,
        severity,
        title: `${label} ${scenario.titleSuffix}`,
        summary: scenario.summary,
        recommendedAction: severity > blockThreshold ? "Block road" : scenario.recommendedAction,
        sourceLabel: sourceLabel ?? scenario.sourceLabel,
      }),
    );
  };

  if (weatherFactor > 24) addScenarioSignal("weather", 6, "disruption", weatherFactor, 48);
  if (incidentFactor > 28) {
    addScenarioSignal(
      "incident",
      10,
      "accident",
      incidentFactor,
      55,
      emergencyVehicles > 0 ? "Fleet Ops" : undefined,
    );
  }
  if (newsFactor > 22) {
    const policeLikely = hashRatio(seed, 4) > 0.58 || hashRatio(seed, 5) > 0.52;
    addScenarioSignal(
      "authority",
      14,
      policeLikely ? "police_closure" : "disruption",
      newsFactor,
      46,
    );
  }

  const drivers = [];
  if (incidentFactor >= weatherFactor && incidentFactor >= newsFactor)
    drivers.push("incident load");
  if (weatherFactor >= 30) drivers.push("weather exposure");
  if (newsFactor >= 28) drivers.push("authority signals");
  if (emergencyVehicles > 0) drivers.push("emergency vehicle on segment");
  if (feedSignals.length > 0) drivers.push("live operational feed");
  if (drivers.length === 0) drivers.push("network baseline watch");

  return {
    corridorId: corridor.id,
    baseRiskScore: clamp(
      Math.round(weatherFactor * 0.28 + newsFactor * 0.27 + incidentFactor * 0.45),
      8,
      99,
    ),
    drivers,
    items,
  };
}

/** Applies the operator's control state on top of the cached core. */
export function finalizeSegment(corridor, core, { controlState, vehicleCount, bucket }) {
  const isClosed = controlState === CONTROL_STATE_CLOSED;
  const items = isClosed
    ? core.items.map((item) => ({ ...item, severity: Math.max(item.severity, 84) }))
    : [...core.items];
  const drivers = [...core.drivers];

  if (isClosed) {
    const scenario = pickScenario(`${corridor.id}:closed`, "detour");
    items.push(
      createSignal(corridor, signalWindow(`${corridor.id}:closed`, bucket, 18), {
        type: "detour",
        severity: 72,
        title: `${formatCorridorLabel(corridor)} ${scenario.titleSuffix}`,
        summary: scenario.summary,
        recommendedAction: scenario.recommendedAction,
        sourceLabel: scenario.sourceLabel,
      }),
    );
    drivers.push("road blocked");
  }

  const riskScore = isClosed ? 100 : core.baseRiskScore;
  return {
    corridorId: corridor.id,
    corridor,
    controlState,
    riskScore,
    affectedVehicles: vehicleCount,
    hasAlert: items.length > 0 || riskScore >= 46,
    whyHighlight: `Primary drivers: ${drivers.join(", ")}.`,
    recommendedAction: isClosed
      ? "Blocked by operator"
      : riskScore >= 76
        ? "Suggested: block road"
        : "Suggested: allow road",
    items,
  };
}

/** Keeps the most severe (then most recent) signal per corridor and type. */
export function dedupeSignals(items) {
  const unique = new Map();
  for (const item of items) {
    const key = `${item.corridorId}|${item.type}`;
    const existing = unique.get(key);
    const isBetter =
      !existing ||
      item.severity > existing.severity ||
      (item.severity === existing.severity && item.minutesAgo < existing.minutesAgo);
    if (isBetter) unique.set(key, item);
  }
  return [...unique.values()];
}

/**
 * Everything the Area Approval view renders.
 *
 * @param {{
 *   corridors: object[],
 *   vehicles: object[],
 *   feed: object[],
 *   inputs: { weather: number, news: number, incidents: number },
 *   rules: Record<string, string>,
 *   nowMs: number,
 *   cache: { bucket: number | null, cores: Record<string, object> },
 * }} context  `cache` is reused between calls and reset when the bucket changes.
 */
export function buildAuthoritySnapshot({ corridors, vehicles, feed, inputs, rules, nowMs, cache }) {
  const bucket = signalBucket(nowMs);
  if (cache.bucket !== bucket) {
    cache.bucket = bucket;
    cache.cores = {};
  }

  const segments = corridors
    .map((corridor) => {
      const corridorVehicles = vehicles.filter((vehicle) => vehicle.corridorId === corridor.id);
      cache.cores[corridor.id] ??= buildSegmentCore(corridor, {
        vehicles: corridorVehicles,
        feed,
        inputs,
        bucket,
      });
      return finalizeSegment(corridor, cache.cores[corridor.id], {
        controlState: getControlState(rules, corridor.id),
        vehicleCount: corridorVehicles.length,
        bucket,
      });
    })
    .sort((a, b) => {
      const closedFirst =
        Number(b.controlState === CONTROL_STATE_CLOSED) -
        Number(a.controlState === CONTROL_STATE_CLOSED);
      return closedFirst || b.riskScore - a.riskScore;
    });

  const signals = dedupeSignals(
    segments
      .flatMap((segment) => segment.items)
      .sort((a, b) => b.severity - a.severity || a.minutesAgo - b.minutesAgo),
  );

  return {
    segments,
    signals,
    // The map shows the 18 strongest signals on segments that are still open.
    mapSignals: signals
      .slice(0, 18)
      .filter((signal) => getControlState(rules, signal.corridorId) !== CONTROL_STATE_CLOSED),
  };
}
