// Actions that span several modules: navigation, vehicle selection,
// emergency handling and the simulation loop. Views receive these as
// callbacks, so no view imports another view.

import { TIMING } from "./config.js";
import { el } from "./dom.js";
import { generateOperationalEvent, pushEvent, shiftAreaStates } from "./feed.js";
import {
  advanceFleet,
  getVehicle,
  randomizeVehicleAlerts,
  resumeVehicle,
  startFollowingVehicle,
  stopFollowingVehicle,
  syncMarkerVisibility,
  syncSelectedMarker,
  triggerEmergencyAlert,
} from "./fleet.js";
import { formatLatLng } from "./lib/format.js";
import { clearRouteLine, resetCamera, showRouteLine } from "./map.js";
import { state } from "./state.js";
import { showEmergencyNotice } from "./ui.js";
import { ensureAuthoritySelection, renderAreaApproval } from "./views/area-approval.js";
import { renderIncidentsBoard } from "./views/incidents.js";
import {
  hideEmergencyCard,
  renderCounters,
  renderEmergencyList,
  renderKpis,
  renderRoadDangerPanel,
  renderSelectedVehicle,
} from "./views/live-operations.js";
import { renderTransmission } from "./views/transmission.js";

const NAV_VIEWS = ["live", "approvals", "incidents", "transmission"];

const EMERGENCY_ACTION_LABELS = {
  "call-112": "112 call initiated",
  "dispatch-roadside": "Roadside unit dispatched",
  "alert-fleet": "Fleet operations alerted",
};

export function renderAll() {
  renderEmergencyList();
  renderRoadDangerPanel();
  renderSelectedVehicle();
  renderAreaApproval();
  renderKpis();
  renderCounters();
  if (state.activeNav === "incidents") renderIncidentsBoard();
  if (state.activeNav === "transmission") renderTransmission();
}

/** Clears the vehicle selection and eases back to the Austria view. */
export function resetView() {
  stopFollowingVehicle();
  state.selectedVehicleId = null;
  clearRouteLine();
  syncSelectedMarker();
  renderSelectedVehicle();
  resetCamera();
}

/**
 * Switches the primary view.
 *
 * @param {string} nextNav one of NAV_VIEWS
 * @param {{ recenter?: boolean }} [options] recenter: reset the map when coming back to it
 */
export function setActiveNav(nextNav, { recenter = true } = {}) {
  const previousNav = state.activeNav;
  const nav = NAV_VIEWS.includes(nextNav) ? nextNav : "live";
  state.activeNav = nav;

  document.body.classList.toggle("is-approval-mode", nav === "approvals");
  document.body.classList.toggle("is-incidents-mode", nav === "incidents");
  document.body.classList.toggle("is-transmission-mode", nav === "transmission");
  el.viewIncidents.hidden = nav !== "incidents";
  el.viewTransmission.hidden = nav !== "transmission";
  for (const button of el.navItems) {
    const isActive = button.dataset.nav === nav;
    button.classList.toggle("is-active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  if (nav === "approvals") {
    stopFollowingVehicle();
    state.selectedVehicleId = null;
    clearRouteLine();
    syncSelectedMarker();
    hideEmergencyCard();
    ensureAuthoritySelection();
  } else if (state.map) {
    state.map.getCanvas().style.cursor = "";
  }

  syncMarkerVisibility();
  renderAreaApproval();
  renderSelectedVehicle();
  if (nav === "incidents") renderIncidentsBoard();
  if (nav === "transmission") renderTransmission();

  if (state.map) {
    // The map needs a frame to pick up its new size after the layout change.
    requestAnimationFrame(() => {
      state.map.resize();
      const leftStandaloneView = previousNav === "incidents" || previousNav === "transmission";
      if (recenter && (nav === "approvals" || (nav === "live" && leftStandaloneView))) resetView();
    });
  }
}

export function selectVehicle(vehicleId) {
  const vehicle = getVehicle(vehicleId);
  if (!vehicle) return;
  state.selectedVehicleId = vehicleId;
  if (vehicle.health === "critical") state.selectedEmergencyVehicleId = vehicleId;
  syncSelectedMarker();
  const corridor = state.corridors[vehicle.corridorId];
  if (corridor) showRouteLine(corridor.points);
  else clearRouteLine();
  renderSelectedVehicle();
  if (vehicle.health === "critical") renderEmergencyList();
}

/** Marker click: select the vehicle and follow it. */
export function selectAndFollowVehicle(vehicleId, lngLat) {
  selectVehicle(vehicleId);
  startFollowingVehicle(vehicleId, lngLat);
}

/** Emergency list click: switch to the map, select and follow the vehicle. */
export function focusEmergencyVehicle(vehicleId) {
  if (state.activeNav !== "live") setActiveNav("live", { recenter: false });
  state.selectedEmergencyVehicleId = vehicleId;
  selectVehicle(vehicleId);
  const markerEntry = state.markers[vehicleId];
  if (markerEntry) startFollowingVehicle(vehicleId, markerEntry.marker.getLngLat());
  renderEmergencyList();
}

/** Buttons of the emergency card on the map. */
export function handleEmergencyAction(action, vehicleId) {
  const vehicle = getVehicle(vehicleId);
  if (!vehicle || vehicle.health !== "critical") return;

  if (action === "clear-emergency") {
    const released = resumeVehicle(vehicle);
    const message = released
      ? `${vehicle.id}: Operator resumed vehicle. Emergency latch released.`
      : `${vehicle.id}: Cannot resume. Emergency condition still active.`;
    pushEvent(message, released ? "info" : "critical");
    showEmergencyNotice(message);
    renderEmergencyList();
    renderSelectedVehicle();
    return;
  }

  const message = `${vehicle.id}: ${EMERGENCY_ACTION_LABELS[action] ?? "Emergency action triggered"}.`;
  pushEvent(message, "critical");
  showEmergencyNotice(message);
}

/** Advances the fleet and announces vehicles that just entered Emergency. */
function stepSimulation(deltaSec) {
  for (const { vehicle, point } of advanceFleet(deltaSec)) {
    const location = formatLatLng(point);
    showEmergencyNotice(`${vehicle.id}: Emergency stop at ${location}.`);
    pushEvent(`${vehicle.id}: Emergency stop engaged at ${location}.`, "critical");
    renderEmergencyList();
  }
}

/** Sends a random healthy vehicle into Emergency ("Startup" or "Scheduled"). */
export function triggerScheduledEmergency(reason) {
  if (!triggerEmergencyAlert(reason)) return;
  stepSimulation(0);
  renderEmergencyList();
  renderSelectedVehicle();
  renderCounters();
}

/** After an operator allowed or blocked a segment. */
export function handleApprovalRulesChanged() {
  stepSimulation(0);
  state.authority.mapRenderKey = null;
  renderAreaApproval();
  renderSelectedVehicle();
  renderEmergencyList();
  renderCounters();
  renderKpis();
}

/** requestAnimationFrame loop: moves vehicles and runs the timed simulation events. */
export function runSimulation(timestamp) {
  const { clock } = state;
  if (!clock.lastFrameTs) clock.lastFrameTs = timestamp;

  // Markers are not moved while MapLibre animates a zoom.
  if (state.isMapZooming) {
    clock.lastFrameTs = timestamp;
    requestAnimationFrame(runSimulation);
    return;
  }

  const deltaSec = Math.min((timestamp - clock.lastFrameTs) / 1000, 1);
  clock.lastFrameTs = timestamp;
  stepSimulation(deltaSec);

  if (timestamp - clock.lastFeedTs > TIMING.feedEventMs && Math.random() > 0.46) {
    generateOperationalEvent();
    clock.lastFeedTs = timestamp;
  }
  if (timestamp - clock.lastAreaShiftTs > TIMING.areaShiftMs) {
    shiftAreaStates();
    clock.lastAreaShiftTs = timestamp;
  }
  if (timestamp - clock.lastAlertShiftTs > TIMING.alertShiftMs) {
    randomizeVehicleAlerts();
    clock.lastAlertShiftTs = timestamp;
  }
  if (
    state.selectedVehicleId &&
    timestamp - clock.lastInspectorRenderTs > TIMING.inspectorRenderMs
  ) {
    renderSelectedVehicle();
    clock.lastInspectorRenderTs = timestamp;
  }

  requestAnimationFrame(runSimulation);
}
