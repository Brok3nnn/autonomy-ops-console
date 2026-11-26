// Incident Handling: one strip per vehicle in Emergency or Good state
// (Emergency first), with an expandable console of incident data.

import { CITY_NODES } from "../config.js";
import { el } from "../dom.js";
import { pushEvent } from "../feed.js";
import {
  escapeHtml,
  formatCityName,
  formatCorridorLabel,
  formatMinutesSeconds,
} from "../lib/format.js";
import { getPointAtDistance, haversineMeters } from "../lib/geo.js";
import { randomInt } from "../lib/random.js";
import { state } from "../state.js";

/** vehicle id -> when its current emergency started (ms), for the strip timer. */
const emergencyStartedAt = new Map();
/** vehicle id -> simulated occupancy, fixed per vehicle. */
const occupancy = new Map();

/** Vehicles shown on the board: everything except Warning, Emergency first. */
export function incidentBoardVehicles(vehicles) {
  return vehicles
    .filter((vehicle) => vehicle.health !== "warn")
    .sort((a, b) => Number(b.health === "critical") - Number(a.health === "critical"));
}

function nearestCityId(point) {
  let best = null;
  for (const [cityId, cityPoint] of Object.entries(CITY_NODES)) {
    const distance = haversineMeters(point, cityPoint);
    if (!best || distance < best.distance) best = { cityId, distance };
  }
  return best?.cityId;
}

function emergencyTimer(vehicle, nowMs) {
  if (vehicle.health !== "critical") {
    emergencyStartedAt.delete(vehicle.id);
    return "NOMINAL";
  }
  if (!emergencyStartedAt.has(vehicle.id)) {
    // Emergencies found on first render get a plausible head start of up to a minute.
    emergencyStartedAt.set(vehicle.id, nowMs - randomInt(0, 60000));
  }
  return `T - ${formatMinutesSeconds((nowMs - emergencyStartedAt.get(vehicle.id)) / 1000)}`;
}

function dataRow(key, value, isAlert = false) {
  return `<div class="data-panel-row"><span class="data-key">${key}</span><span class="data-val ${isAlert ? "alert" : ""}">${escapeHtml(value)}</span></div>`;
}

function renderConsole(vehicle, isCritical) {
  const corridor = state.corridors[vehicle.corridorId];
  const point = corridor ? getPointAtDistance(corridor, vehicle.offsetMeters) : null;
  if (!occupancy.has(vehicle.id)) occupancy.set(vehicle.id, randomInt(1, 4));

  return `
    <div class="strip-console">
      <div class="console-pane">
        <span class="pane-label">Incident Data</span>
        <div class="data-panel-grid">
          ${dataRow("Location", corridor ? formatCorridorLabel(corridor) : "Unknown sector")}
          ${dataRow("Nearest Hub", point ? formatCityName(nearestCityId(point)) : "-")}
          ${dataRow("Fleet ID", vehicle.id)}
          ${dataRow("Priority", isCritical ? "LEVEL 1 CRITICAL" : "ROUTINE", isCritical)}
        </div>
      </div>
      <div class="console-pane">
        <span class="pane-label">System State</span>
        <div class="data-panel-grid">
          ${dataRow("Drivetrain", isCritical ? "LOCKED (SAFETY)" : "ACTIVE", isCritical)}
          ${dataRow("AI Core", isCritical ? "UNREACHABLE" : "SYNCED", isCritical)}
          ${dataRow("Occupancy", `${occupancy.get(vehicle.id)} PAX`)}
          ${dataRow("Last Speed", `${Math.round(vehicle.currentSpeedKmh)} km/h`)}
        </div>
      </div>
      <div class="console-pane">
        <span class="pane-label">Action Center</span>
        <div class="action-list">
          <button type="button" class="simple-action-btn" data-incident-action="logs">[ View Diagnostic Logs ]</button>
          ${isCritical ? '<button type="button" class="simple-action-btn priority" data-incident-action="dispatch">[ Authorize Dispatch ]</button>' : ""}
          <button type="button" class="simple-action-btn" data-incident-action="close">[ Close View ]</button>
        </div>
      </div>
    </div>`;
}

function renderStrip(vehicle, nowMs) {
  const isCritical = vehicle.health === "critical";
  const isExpanded = state.incidents.expandedVehicleId === vehicle.id;
  const sparkline = isCritical
    ? '<path d="M0,5 L30,5 L40,18 L60,18 L65,22 L100,22" fill="none" stroke="#ff4b5c" stroke-width="2" vector-effect="non-scaling-stroke"></path>'
    : '<path d="M0,12 L100,12" fill="none" stroke="#2ec27e" stroke-width="2" vector-effect="non-scaling-stroke"></path>';

  return `
    <li class="flight-strip-item ${isCritical ? "is-critical" : "is-ok"}" data-vehicle-id="${escapeHtml(vehicle.id)}">
      <div class="strip-main-row" data-incident-action="toggle" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="strip-id-block">
          <div class="live-dot"></div>
          <div class="strip-id-box">${escapeHtml(vehicle.id)}</div>
        </div>
        <div class="strip-sparkline">
          <svg width="100%" height="24" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">${sparkline}</svg>
        </div>
        <div class="strip-waterfall">
          <div class="waterfall-dot"></div>
          <div class="waterfall-line"></div>
          <span>${isCritical ? "BRAKE" : "AUTO"}</span>
          <div class="waterfall-line"></div>
          <div class="waterfall-dot"></div>
          <div class="waterfall-line"></div>
          <span>${isCritical ? "TEL LOSS" : "SYNC OK"}</span>
          <div class="waterfall-line"></div>
          <div class="waterfall-dot"></div>
        </div>
        <div class="strip-timer">${emergencyTimer(vehicle, nowMs)}</div>
      </div>
      ${isExpanded ? renderConsole(vehicle, isCritical) : ""}
    </li>`;
}

export function renderIncidentsBoard() {
  const vehicles = incidentBoardVehicles(state.vehicles);
  const nowMs = Date.now();
  el.incidentList.innerHTML =
    vehicles.length > 0
      ? vehicles.map((vehicle) => renderStrip(vehicle, nowMs)).join("")
      : '<li class="mono incident-empty">No emergency states detected in operational fleet.</li>';
}

/** @param {{ onChange: () => void }} actions  called after anything that needs a re-render */
export function bindIncidents({ onChange }) {
  const handle = (target) => {
    const action = target.closest("[data-incident-action]")?.dataset.incidentAction;
    const vehicleId = target.closest("[data-vehicle-id]")?.dataset.vehicleId;
    if (!action || !vehicleId) return;

    if (action === "toggle") {
      state.incidents.expandedVehicleId =
        state.incidents.expandedVehicleId === vehicleId ? null : vehicleId;
    } else if (action === "logs") {
      pushEvent(`Fetching remote diagnostic logs for ${vehicleId}...`, "info");
    } else if (action === "dispatch") {
      pushEvent(`Emergency unit dispatched for vehicle ${vehicleId}.`, "info");
      state.incidents.expandedVehicleId = null;
    } else if (action === "close") {
      state.incidents.expandedVehicleId = null;
    }
    onChange();
  };

  el.incidentList.addEventListener("click", (event) => handle(event.target));
  el.incidentList.addEventListener("keydown", (event) => {
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target.matches("[data-incident-action='toggle']")
    ) {
      event.preventDefault();
      handle(event.target);
    }
  });
}
