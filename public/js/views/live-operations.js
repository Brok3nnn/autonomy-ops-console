// Live Operations: emergency list, selected-vehicle inspector, emergency card
// on the map, road danger panel and KPIs.

import { el } from "../dom.js";
import { controlStateLabel, getControlState } from "../lib/authority.js";
import { escapeHtml, formatCorridorLabel, formatLatLng } from "../lib/format.js";
import { getPointAtDistance } from "../lib/geo.js";
import { buildRiskPanelModel, gaugeArcPath, gaugePoint, scoreToGaugeAngle } from "../lib/risk.js";
import { averageIntegrity } from "../lib/telemetry.js";
import {
  computeProgress,
  describeEmergencyCause,
  summarizeFleet,
  toStatusClass,
} from "../lib/vehicle-state.js";
import { state } from "../state.js";

export function renderEmergencyList() {
  const emergencies = state.vehicles.filter((vehicle) => vehicle.health === "critical");
  if (emergencies.length === 0) {
    state.selectedEmergencyVehicleId = null;
    el.emergencyList.innerHTML =
      '<li><strong>No active emergencies</strong><div class="mono">Fleet operating nominally.</div></li>';
    return;
  }

  if (!emergencies.some((vehicle) => vehicle.id === state.selectedEmergencyVehicleId)) {
    state.selectedEmergencyVehicleId = emergencies[0].id;
  }

  el.emergencyList.innerHTML = emergencies
    .map((vehicle) => {
      const activeClass = vehicle.id === state.selectedEmergencyVehicleId ? "is-active" : "";
      return `
        <li>
          <button type="button" class="emergency-item ${activeClass}" data-emergency-vehicle="${escapeHtml(vehicle.id)}">
            <strong>${escapeHtml(vehicle.id)}</strong>
            <span class="mono">STOPPED · ${escapeHtml(vehicle.zone)}</span>
          </button>
        </li>`;
    })
    .join("");
}

function showInspectorMessage(message) {
  el.vehicleInspector.hidden = true;
  el.vehicleInspector.innerHTML = "";
  el.vehicleInspectorEmpty.hidden = false;
  el.vehicleInspectorEmpty.textContent = message;
  hideEmergencyCard();
}

export function hideEmergencyCard() {
  el.mapEmergencyCard.hidden = true;
}

function renderEmergencyCard(vehicle, corridor, point) {
  if (vehicle.health !== "critical") {
    hideEmergencyCard();
    return;
  }
  el.mapEmergencyTitle.textContent = `${vehicle.id} Emergency`;
  el.mapEmergencyDescription.textContent = describeEmergencyCause(vehicle);
  el.mapEmergencyMeta.textContent = `${formatCorridorLabel(corridor)} · ${formatLatLng(point)}`;
  el.mapEmergencyCard.hidden = false;
}

/** Telemetry of the selected vehicle, plus the emergency card if it is stopped. */
export function renderSelectedVehicle() {
  if (!state.selectedVehicleId) {
    showInspectorMessage("Click a vehicle dot to view full telemetry.");
    return;
  }
  const vehicle = state.vehicles.find((candidate) => candidate.id === state.selectedVehicleId);
  if (!vehicle) {
    state.selectedVehicleId = null;
    showInspectorMessage("Selected vehicle is no longer available.");
    return;
  }
  const corridor = state.corridors[vehicle.corridorId];
  if (!corridor) {
    showInspectorMessage("Telemetry unavailable for this vehicle.");
    return;
  }

  const point = getPointAtDistance(corridor, vehicle.offsetMeters);
  const { progressPct, etaMinutes } = computeProgress(
    vehicle.offsetMeters,
    corridor.totalMeters,
    vehicle.currentSpeedKmh,
  );
  const operationalState = escapeHtml(vehicle.operationalState);
  const rows = [
    ["Vehicle ID", escapeHtml(vehicle.id)],
    ["Class", escapeHtml(vehicle.class)],
    ["Speed", `${Math.round(vehicle.currentSpeedKmh)} km/h`],
    [
      "Operational State",
      `<span class="${toStatusClass(vehicle.operationalState)}">${operationalState}</span>`,
    ],
    ["Authority Status", controlStateLabel(getControlState(state.authority.rules, corridor.id))],
    ["Alert", vehicle.alert === "none" ? "None" : escapeHtml(vehicle.alert.toUpperCase())],
    ["Health", escapeHtml(vehicle.health.toUpperCase())],
    ["Authority Zone", escapeHtml(vehicle.zone)],
    ["Route", escapeHtml(formatCorridorLabel(corridor))],
    [
      "Progress",
      etaMinutes === null ? `${progressPct}% · STOPPED` : `${progressPct}% · ETA ${etaMinutes}m`,
    ],
    ["Location", formatLatLng(point)],
    ["Camera Follow", state.followVehicleId === vehicle.id ? "Active" : "Idle"],
  ];

  // Values are escaped above; the operational state cell carries markup.
  el.vehicleInspector.innerHTML = rows
    .map(
      ([label, valueHtml]) =>
        `<li><strong>${label}</strong><div class="mono">${valueHtml}</div></li>`,
    )
    .join("");
  el.vehicleInspector.hidden = false;
  el.vehicleInspectorEmpty.hidden = true;
  renderEmergencyCard(vehicle, corridor, point);
}

export function renderCounters() {
  const summary = summarizeFleet(state.vehicles);
  el.vehicleCount.textContent = String(summary.total);
  el.criticalCount.textContent = String(summary.emergency);
}

export function renderKpis() {
  const summary = summarizeFleet(state.vehicles);
  const lines = [
    ["Vehicles supervised", summary.total],
    ["Good state", summary.good],
    ["Warning state", summary.warning],
    ["Emergency state", summary.emergency],
    ["Stopped vehicles", summary.stopped],
    ["Average speed", `${summary.averageSpeedKmh} km/h`],
    ["Comms integrity", `${averageIntegrity(state.channels)}%`],
  ];
  el.kpis.innerHTML = lines
    .map(
      ([label, value]) =>
        `<li><strong>${label}</strong><div class="mono">${escapeHtml(value)}</div></li>`,
    )
    .join("");
}

function renderRiskEntry(entry) {
  const levelClass = entry.level?.className ?? "";
  const scoreText = entry.score === null ? "—" : `${entry.score}/100`;
  const levelText = entry.score === null ? "No reading" : entry.level.label;
  return `
    <li class="${entry.score === null ? "is-unavailable" : ""}">
      <strong>${escapeHtml(entry.label)}</strong>
      <div class="mono risk-meta">
        <span class="risk-score ${levelClass}">${scoreText}</span>
        <span>${escapeHtml(levelText)}</span>
      </div>
      <div class="risk-bar"><span class="risk-fill ${levelClass}" style="--risk-fill:${entry.score ?? 0}%"></span></div>
      <p class="mono risk-source is-${entry.source.status}">${escapeHtml(entry.source.text)}</p>
    </li>`;
}

const GAUGE = { cx: 160, cy: 142, outerRadius: 108, needleRadius: 82 };

function renderGauge({ score, level, note }) {
  const { cx, cy, outerRadius, needleRadius } = GAUGE;
  const arc = (from, to) =>
    gaugeArcPath(cx, cy, outerRadius, scoreToGaugeAngle(from), scoreToGaugeAngle(to));
  const levelClass = level?.className ?? "";
  const needle =
    score === null
      ? ""
      : (() => {
          const tip = gaugePoint(cx, cy, needleRadius, scoreToGaugeAngle(score));
          return `<line class="danger-needle ${levelClass}" x1="${cx}" y1="${cy}" x2="${tip.x.toFixed(2)}" y2="${tip.y.toFixed(2)}"></line>`;
        })();

  el.dangerChart.innerHTML = `
    <title>Overall danger index: ${score === null ? "no reading" : `${score} of 100`}. ${escapeHtml(note)}.</title>
    <path class="danger-gauge-base" d="${gaugeArcPath(cx, cy, outerRadius, 180, 360)}"></path>
    <path class="danger-gauge-segment gauge-green" d="${arc(0, 33)}"></path>
    <path class="danger-gauge-segment gauge-yellow" d="${arc(33, 66)}"></path>
    <path class="danger-gauge-segment gauge-red" d="${arc(66, 100)}"></path>
    ${needle}
    <circle class="danger-pivot" cx="${cx}" cy="${cy}" r="5"></circle>
    <text class="danger-axis-label" x="34" y="${cy + 4}">0</text>
    <text class="danger-axis-label" x="${cx}" y="28">50</text>
    <text class="danger-axis-label" x="286" y="${cy + 4}">100</text>
    <text class="danger-overall-label" x="${cx}" y="102">Overall</text>
    <text class="danger-overall-value ${levelClass}" x="${cx}" y="124">${score ?? "—"}</text>
    <text class="danger-overall-state ${levelClass}" x="${cx}" y="164">${escapeHtml(level?.label ?? "No reading")}</text>`;
}

/** Road danger inputs with their provider status, the overall entry and the gauge. */
export function renderRoadDangerPanel() {
  const model = buildRiskPanelModel(state.risk, Date.now());
  const overallEntry = {
    label: "Overall Danger Index",
    score: model.overall.score,
    level: model.overall.level,
    source: { status: "derived", text: model.overall.note },
  };
  el.dangerIndexes.innerHTML = [...model.entries, overallEntry].map(renderRiskEntry).join("");
  renderGauge(model.overall);
}

/**
 * @param {{
 *   onFocusEmergencyVehicle: (vehicleId: string) => void,
 *   onEmergencyAction: (action: string, vehicleId: string) => void,
 * }} actions
 */
export function bindLiveOperations({ onFocusEmergencyVehicle, onEmergencyAction }) {
  el.emergencyList.addEventListener("click", (event) => {
    const vehicleId = event.target.closest("[data-emergency-vehicle]")?.dataset.emergencyVehicle;
    if (vehicleId) onFocusEmergencyVehicle(vehicleId);
  });

  el.mapEmergencyCard.addEventListener("click", (event) => {
    const action = event.target.closest("[data-emergency-action]")?.dataset.emergencyAction;
    const vehicleId = state.selectedVehicleId ?? state.selectedEmergencyVehicleId;
    if (action && vehicleId) onEmergencyAction(action, vehicleId);
  });
}
