// Entry point: loads the static data, builds the network and the fleet,
// wires the views to the controller and starts the timers.

import { CORRIDOR_BLUEPRINTS, DATA_URLS, TIMING } from "./config.js";
import {
  focusEmergencyVehicle,
  handleApprovalRulesChanged,
  handleEmergencyAction,
  renderAll,
  resetView,
  runSimulation,
  selectAndFollowVehicle,
  setActiveNav,
  triggerScheduledEmergency,
} from "./controller.js";
import { el } from "./dom.js";
import { pushEvent } from "./feed.js";
import { createFleet, createVehicleMarkers, stopFollowingVehicle, syncMarkers } from "./fleet.js";
import { buildCorridorNetwork } from "./lib/corridors.js";
import { prepareBoundary } from "./lib/geo.js";
import { driftChannel } from "./lib/telemetry.js";
import { initMap, showBoundary } from "./map.js";
import { startRoadRiskPolling } from "./risk-feed.js";
import { state } from "./state.js";
import {
  bindAreaApproval,
  ensureAuthoritySelection,
  renderAreaApproval,
} from "./views/area-approval.js";
import { bindIncidents } from "./views/incidents.js";
import { bindLiveOperations, renderKpis, renderRoadDangerPanel } from "./views/live-operations.js";
import { bindTransmission, renderTransmission, tickNodeTelemetry } from "./views/transmission.js";

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  return response.json();
}

function showFatalError(error) {
  console.error(error);
  const banner = document.getElementById("appError");
  banner.textContent = `The console could not start: ${error.message}`;
  banner.hidden = false;
}

function bindViews() {
  for (const button of el.navItems) {
    button.addEventListener("click", () => setActiveNav(button.dataset.nav));
  }
  bindLiveOperations({
    onFocusEmergencyVehicle: focusEmergencyVehicle,
    onEmergencyAction: handleEmergencyAction,
  });
  bindAreaApproval({ onRulesChanged: handleApprovalRulesChanged });
  bindIncidents({ onChange: renderAll });
  bindTransmission({ onChange: renderAll });
}

function startTimers() {
  setInterval(renderAll, TIMING.renderMs);
  setInterval(() => {
    state.channels = state.channels.map((channel) => driftChannel(channel));
    renderKpis();
  }, TIMING.channelUpdateMs);
  setInterval(() => {
    if (state.activeNav !== "transmission") return;
    tickNodeTelemetry();
    renderTransmission();
  }, TIMING.nodeTelemetryMs);
  setInterval(() => triggerScheduledEmergency("Scheduled"), TIMING.scheduledEmergencyMs);
  requestAnimationFrame(runSimulation);
}

async function start() {
  bindViews();
  setActiveNav("live");
  initMap({
    onLoad: () => {
      renderAreaApproval();
      syncMarkers();
    },
    onZoomEnd: syncMarkers,
    onUserGesture: stopFollowingVehicle,
    onReset: resetView,
  });

  const [boundary, routes] = await Promise.all([
    loadJson(DATA_URLS.boundary),
    loadJson(DATA_URLS.routes),
  ]);
  showBoundary(boundary);
  state.corridors = buildCorridorNetwork({
    blueprints: CORRIDOR_BLUEPRINTS,
    routeCache: routes,
    boundary: prepareBoundary(boundary),
  });
  if (Object.keys(state.corridors).length === 0)
    throw new Error("No usable road corridors in the route cache.");

  ensureAuthoritySelection();
  createFleet();
  createVehicleMarkers(selectAndFollowVehicle);
  triggerScheduledEmergency("Startup");
  startRoadRiskPolling(renderRoadDangerPanel);
  pushEvent("Control center boot complete. Authority supervision active.", "info");
  pushEvent("A-04 operates under APPROVED supervision profile.", "info");

  renderAll();
  startTimers();
}

start().catch(showFatalError);
