// Road danger index: maths, payload validation and the text shown next to
// each signal. Pure functions; the live-operations view renders the result.

import { formatShortTime } from "./format.js";
import { clamp } from "./geo.js";

/** The three inputs of the index, in display order. */
export const RISK_SIGNALS = [
  { key: "weather", label: "Weather Severity" },
  { key: "news", label: "News Pulse" },
  { key: "incidents", label: "Road Incident Load" },
];

/** Weights of the overall index. They sum to 1. */
export const RISK_WEIGHTS = { weather: 0.34, news: 0.28, incidents: 0.38 };

/**
 * Neutral inputs for the simulated Area Approval signals while a real input
 * is unavailable. They are never displayed as readings.
 */
export const SIMULATION_BASELINE = { weather: 26, news: 24, incidents: 22 };

/** A "live" reading older than this is presented as cached. */
export const LIVE_MAX_AGE_MS = 30 * 60 * 1000;

const PROVIDER_STATUSES = new Set(["live", "cached", "unavailable"]);

const ERROR_TEXT = {
  "rate-limited": "rate-limited",
  timeout: "timed out",
  "network-error": "unreachable",
  "invalid-response": "unexpected response",
};

/**
 * Weighted mean of the available inputs, rescaled so missing inputs do not
 * drag the index down. Returns null when no input is available.
 *
 * @param {{ weather?: number|null, news?: number|null, incidents?: number|null }} scores
 */
export function computeOverallRisk(scores, weights = RISK_WEIGHTS) {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const score = scores[key];
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    weightedSum += clamp(score, 0, 100) * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;
}

/** Lowest scores of the "Watch closely" and "Emergency profile" bands. The gauge uses them too. */
export const RISK_BANDS = { watch: 45, emergency: 75 };

export function riskLevel(score) {
  const { watch, emergency } = RISK_BANDS;
  if (score >= emergency) return { className: "status-hold", label: "Emergency profile" };
  if (score >= watch) return { className: "status-conditional", label: "Watch closely" };
  return { className: "status-approved", label: "Stable" };
}

/** Gauge angle in degrees: 0 -> 180° (left), 100 -> 360° (right). */
export function scoreToGaugeAngle(score) {
  return 180 + (clamp(score, 0, 100) / 100) * 180;
}

export function gaugePoint(cx, cy, radius, angleDeg) {
  const radians = (angleDeg * Math.PI) / 180;
  return { x: cx + Math.cos(radians) * radius, y: cy + Math.sin(radians) * radius };
}

/** SVG path for a clockwise arc of the gauge. */
export function gaugeArcPath(cx, cy, radius, startAngle, endAngle) {
  const start = gaugePoint(cx, cy, radius, startAngle);
  const end = gaugePoint(cx, cy, radius, endAngle);
  const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function toScore(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(clamp(value, 0, 100))
    : null;
}

function toTimestamp(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeProvider(raw, id) {
  const status = PROVIDER_STATUSES.has(raw?.status) ? raw.status : "unavailable";
  return {
    id,
    name: typeof raw?.name === "string" ? raw.name : id,
    status,
    updatedAt: toTimestamp(raw?.updatedAt),
    checkedAt: toTimestamp(raw?.checkedAt),
    retryAt: toTimestamp(raw?.retryAt),
    error: typeof raw?.error === "string" ? raw.error : null,
  };
}

/**
 * Validates a /api/road-risk response. Anything missing or malformed becomes
 * an unavailable signal rather than an exception or a made-up number.
 */
export function normalizeRoadRiskPayload(payload) {
  const providers = {};
  for (const [id, raw] of Object.entries(payload?.providers ?? {})) {
    providers[id] = normalizeProvider(raw, id);
  }

  const signals = {};
  for (const { key } of RISK_SIGNALS) {
    const raw = payload?.signals?.[key];
    const providerId = typeof raw?.provider === "string" ? raw.provider : null;
    const provider = providerId ? providers[providerId] : null;
    const score = provider && provider.status !== "unavailable" ? toScore(raw?.score) : null;
    signals[key] = { score, providerId };
  }

  return { generatedAt: toTimestamp(payload?.generatedAt), signals, providers };
}

/** "live" readings that are older than LIVE_MAX_AGE_MS count as cached. */
export function effectiveProviderStatus(provider, nowMs) {
  if (
    provider.status === "live" &&
    provider.updatedAt !== null &&
    nowMs - provider.updatedAt > LIVE_MAX_AGE_MS
  ) {
    return "cached";
  }
  return provider.status;
}

function describeError(code) {
  if (!code) return null;
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  const http = /^http-(\d{3})$/.exec(code);
  return http ? `HTTP ${http[1]}` : "error";
}

/**
 * One line of status text for a signal's provider, e.g.
 * "Open-Meteo · live · 09:41" or "GDELT · unavailable · rate-limited, retry 10:05".
 */
export function describeProvider(provider, nowMs) {
  const status = effectiveProviderStatus(provider, nowMs);
  const parts = [provider.name, status];

  if (status === "live" && provider.updatedAt !== null) {
    parts.push(formatShortTime(new Date(provider.updatedAt)));
  } else {
    if (status === "cached" && provider.updatedAt !== null) {
      parts.push(`from ${formatShortTime(new Date(provider.updatedAt))}`);
    }
    const reason = describeError(provider.error);
    const retry =
      provider.retryAt !== null && provider.retryAt > nowMs
        ? `retry ${formatShortTime(new Date(provider.retryAt))}`
        : null;
    const detail = [reason, retry].filter(Boolean).join(", ");
    if (detail) parts.push(detail);
  }

  return { status, text: parts.join(" · ") };
}

/**
 * Everything the Road Danger panel renders.
 *
 * @param {{ payload: ReturnType<typeof normalizeRoadRiskPayload> | null, error: string | null }} riskState
 *   `error` is set when the last request to the API itself failed.
 */
export function buildRiskPanelModel({ payload, error }, nowMs) {
  const entries = RISK_SIGNALS.map(({ key, label }) => {
    const signal = payload?.signals[key];
    const provider = signal?.providerId ? payload.providers[signal.providerId] : null;
    let source;
    if (provider) source = describeProvider(provider, nowMs);
    else if (error) source = { status: "unavailable", text: `Risk API ${error}` };
    else source = { status: "pending", text: "Connecting to risk feed" };

    const score = signal?.score ?? null;
    return { key, label, score, level: score === null ? null : riskLevel(score), source };
  });

  const scores = Object.fromEntries(entries.map((entry) => [entry.key, entry.score]));
  const available = entries.filter((entry) => entry.score !== null).length;
  const overallScore = computeOverallRisk(scores);
  let note;
  if (available === entries.length) note = "Weighted from all live inputs";
  else if (available > 0) note = `Based on ${available} of ${entries.length} inputs`;
  else note = payload || error ? "No inputs available" : "Waiting for first reading";

  return {
    entries,
    overall: {
      score: overallScore,
      level: overallScore === null ? null : riskLevel(overallScore),
      note,
    },
  };
}

/** Numbers the simulation uses: real scores where present, the baseline otherwise. */
export function simulationInputs(payload) {
  const inputs = { ...SIMULATION_BASELINE };
  for (const { key } of RISK_SIGNALS) {
    const score = payload?.signals[key]?.score;
    if (typeof score === "number") inputs[key] = score;
  }
  return inputs;
}
