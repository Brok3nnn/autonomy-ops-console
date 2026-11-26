// Text formatting helpers for the UI. Pure functions only.

import { CITY_NAME_OVERRIDES } from "../config.js";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes a value for use in HTML text and quoted attribute values. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** "stpoelten" -> "St. Pölten", "graz" -> "Graz". */
export function formatCityName(id) {
  if (!id) return "-";
  const lower = String(id).toLowerCase();
  return CITY_NAME_OVERRIDES[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function formatCorridorLabel(corridor) {
  return `${formatCityName(corridor.from)} → ${formatCityName(corridor.to)}`;
}

/** 24-hour "HH:MM:SS" in the viewer's time zone. */
export function formatTime(date) {
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

/** 24-hour "HH:MM" in the viewer's time zone. */
export function formatShortTime(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "48.20820, 16.37380" for a [lat, lng] point. */
export function formatLatLng(point) {
  return point ? `${point[0].toFixed(5)}, ${point[1].toFixed(5)}` : "Location unavailable";
}

/** "Affected 450 m" / "Affected 2.4 km" for the length of a signal span. */
export function formatAffectedDistance(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value) || value <= 0) return "Affected span unavailable";
  if (value < 1000) return `Affected ${Math.max(50, Math.round(value / 10) * 10)} m`;
  return `Affected ${(value / 1000).toFixed(1)} km`;
}

/** "07:05" for 425 seconds. */
export function formatMinutesSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** First 82 characters of a summary, for hover popups. */
export function shortenText(text, maxLength = 82) {
  const value = String(text || "").trim();
  if (!value) return "Unknown risk trigger";
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
