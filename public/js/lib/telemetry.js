// Simulated link telemetry for the KPI panel and the Transmission Health view.
// Pure functions; randomness is injected.

import { CITY_NODES } from "../config.js";
import { clamp, haversineMeters } from "./geo.js";
import { randomInt } from "./random.js";

export function channelMode(integrity) {
  if (integrity > 92) return "Online";
  if (integrity > 87) return "Watch";
  return "Degraded";
}

/** Random walk of a channel's integrity between 82 % and 100 %. */
export function driftChannel(channel, random = Math.random) {
  const integrity = clamp(channel.integrity + randomInt(-3, 2, random), 82, 100);
  return { ...channel, integrity, mode: channelMode(integrity) };
}

export function averageIntegrity(channels) {
  if (channels.length === 0) return 0;
  return Math.round(
    channels.reduce((sum, channel) => sum + channel.integrity, 0) / channels.length,
  );
}

export const SPARKLINE_LENGTH = 40;

export function createSparkline(random = Math.random) {
  return Array.from({ length: SPARKLINE_LENGTH }, () => random() * 20 + 20);
}

/** Drops the oldest value and appends a step of up to ±6, kept within 10..95. */
export function nextSparkline(values, random = Math.random) {
  const last = values[values.length - 1];
  return [...values.slice(1), clamp(last + (random() * 12 - 6), 10, 95)];
}

/** SVG path data for values 0..100 drawn into a width x height box. */
export function sparklinePath(values, width, height) {
  if (values.length < 2) return "";
  const dx = width / (values.length - 1);
  return values
    .map((value, i) => `${i === 0 ? "M" : "L"} ${i * dx},${height - (value / 100) * height}`)
    .join(" ");
}

/** Id of the node whose city is closest to a [lat, lng] point. */
export function nearestNodeId(point, nodes, cityNodes = CITY_NODES) {
  let best = null;
  for (const node of nodes) {
    const distance = haversineMeters(point, cityNodes[node.city]);
    if (!best || distance < best.distance) best = { id: node.id, distance };
  }
  return best?.id ?? null;
}

export function nodeLatencyMs(integrity) {
  return Math.max(1, 100 - integrity + 2);
}

export function nodeBandwidthGbps(integrity) {
  return integrity * 0.12;
}
