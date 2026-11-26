// Operational feed: an in-memory log of simulated operator and fleet events.
// It is not rendered as a list; Area Approval turns matching entries into
// road signals (see buildFeedSignals in lib/authority.js).

import { FEED_MESSAGES } from "./config.js";
import { pickRandom } from "./lib/random.js";
import { state } from "./state.js";

const FEED_LIMIT = 18;

/** @param {"info" | "warn" | "critical"} severity */
export function pushEvent(text, severity = "info") {
  state.feed.unshift({ text, severity });
  state.feed.length = Math.min(state.feed.length, FEED_LIMIT);
}

/** Random fleet chatter; about one in five messages is critical. */
export function generateOperationalEvent(random = Math.random) {
  const severity = random() > 0.78 ? "critical" : "info";
  const vehicle = state.vehicles.length > 0 ? pickRandom(state.vehicles, random) : null;
  const message = pickRandom(FEED_MESSAGES, random);
  pushEvent(vehicle ? `${vehicle.id}: ${message}` : message, severity);
}

/** Flips the A-02 and A-04 zones between Approved and Conditional now and then. */
export function shiftAreaStates(random = Math.random) {
  const flips = [
    { code: "A-02", threshold: 0.5 },
    { code: "A-04", threshold: 0.4 },
  ];
  for (const { code, threshold } of flips) {
    const area = state.areas.find((candidate) => candidate.code === code);
    if (!area || random() <= threshold) continue;
    area.status = area.status === "Conditional" ? "Approved" : "Conditional";
    pushEvent(`${code} switched to ${area.status.toUpperCase()} status.`, "info");
  }
}
