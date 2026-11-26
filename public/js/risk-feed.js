// Polls /api/road-risk. The endpoint is CDN-cached and never forced to
// refresh from here; a failed poll keeps the last payload on screen.

import { ROAD_RISK_URL, TIMING } from "./config.js";
import { normalizeRoadRiskPayload } from "./lib/risk.js";
import { state } from "./state.js";

function describeRequestError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timed out";
  if (error?.status) return `HTTP ${error.status}`;
  return "unreachable";
}

export async function refreshRoadRisk() {
  if (state.risk.inFlight) return;
  state.risk.inFlight = true;
  try {
    const response = await fetch(ROAD_RISK_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMING.roadRiskRequestTimeoutMs),
    });
    if (!response.ok)
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    state.risk.payload = normalizeRoadRiskPayload(await response.json());
    state.risk.error = null;
  } catch (error) {
    state.risk.error = describeRequestError(error);
    console.warn("Road risk request failed:", error);
  } finally {
    state.risk.inFlight = false;
  }
}

/** Fetches now, then every TIMING.roadRiskPollMs; calls `onUpdate` after each attempt. */
export function startRoadRiskPolling(onUpdate) {
  const poll = () => refreshRoadRisk().then(onUpdate);
  poll();
  setInterval(poll, TIMING.roadRiskPollMs);
}
