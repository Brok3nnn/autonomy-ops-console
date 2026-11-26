// The simulated fleet on the map: vehicle markers, movement, camera follow
// and rerouting around blocked segments. The state transitions themselves
// live in lib/vehicle-state.js.

import {
  FOLLOW_CLICK_ZOOM_STEP,
  FOLLOW_MAX_ZOOM,
  FOLLOW_ZOOM_OFFSET,
  HEALTH_STYLE,
  VEHICLE_COUNT,
} from "./config.js";
import { pushEvent } from "./feed.js";
import {
  CONTROL_STATE_CLOSED,
  controlStateToVehicleStatus,
  getControlState,
} from "./lib/authority.js";
import { findDetourRoutes } from "./lib/corridors.js";
import { formatCorridorLabel } from "./lib/format.js";
import { findNearestPointOnCorridor, getPointAtDistance, toLngLat } from "./lib/geo.js";
import { pickRandom } from "./lib/random.js";
import {
  createVehicles,
  nextAlert,
  releaseEmergencyLatch,
  stepVehicle,
} from "./lib/vehicle-state.js";
import { state } from "./state.js";

export function getVehicle(vehicleId) {
  return state.vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null;
}

/** Authority status a vehicle inherits from the segment it is on. */
export function corridorVehicleStatus(corridor) {
  return controlStateToVehicleStatus(getControlState(state.authority.rules, corridor.id));
}

export function createFleet() {
  state.vehicles = createVehicles(state.corridors, VEHICLE_COUNT, {
    getStatus: corridorVehicleStatus,
  });
}

function markerStyle(health) {
  return HEALTH_STYLE[health] ?? HEALTH_STYLE.warn;
}

function paintMarker(markerEntry, vehicle) {
  const dot = markerEntry.element.querySelector(".vehicle-dot-map");
  const style = markerStyle(vehicle.health);
  dot.style.setProperty("--vehicle-fill", style.fillColor);
  dot.style.setProperty("--vehicle-ring", style.color);
  vehicle.renderedHealth = vehicle.health;
}

function setMarkerPriority(markerEntry, isFocused) {
  markerEntry.element.style.zIndex = isFocused ? "1000" : "10";
}

/**
 * Adds one marker per vehicle.
 *
 * @param {(vehicleId: string, lngLat: object) => void} onSelect called when a marker is clicked
 */
export function createVehicleMarkers(onSelect) {
  for (const vehicle of state.vehicles) {
    const corridor = state.corridors[vehicle.corridorId];
    const element = document.createElement("div");
    element.className = "vehicle-dot-icon";
    element.innerHTML = '<span class="vehicle-dot-map"></span>';

    const marker = new maplibregl.Marker({ element, anchor: "center" })
      .setLngLat(toLngLat(getPointAtDistance(corridor, vehicle.offsetMeters)))
      .addTo(state.map);
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      closeOnMove: true,
      offset: 10,
      className: "route-label-popup",
    }).setText(vehicle.id);

    element.addEventListener("mouseenter", () =>
      popup.setLngLat(marker.getLngLat()).addTo(state.map),
    );
    element.addEventListener("mouseleave", () => popup.remove());
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect(vehicle.id, marker.getLngLat());
    });

    const markerEntry = { marker, element, popup };
    state.markers[vehicle.id] = markerEntry;
    paintMarker(markerEntry, vehicle);
    setMarkerPriority(markerEntry, false);
  }
  syncMarkerVisibility();
}

/** Vehicles are hidden on the Area Approval view. */
export function syncMarkerVisibility() {
  const hidden = state.activeNav === "approvals";
  for (const markerEntry of Object.values(state.markers)) {
    markerEntry.element.style.display = hidden ? "none" : "";
    markerEntry.element.style.pointerEvents = hidden ? "none" : "";
    if (hidden) markerEntry.popup.remove();
  }
}

export function syncSelectedMarker() {
  for (const [vehicleId, markerEntry] of Object.entries(state.markers)) {
    markerEntry.element
      .querySelector(".vehicle-dot-map")
      .classList.toggle("is-selected", vehicleId === state.selectedVehicleId);
  }
}

/** Re-applies position, colour, visibility and selection to every marker. */
export function syncMarkers() {
  syncMarkerVisibility();
  for (const vehicle of state.vehicles) {
    const markerEntry = state.markers[vehicle.id];
    const corridor = state.corridors[vehicle.corridorId];
    if (!markerEntry || !corridor) continue;
    markerEntry.marker.setLngLat(toLngLat(getPointAtDistance(corridor, vehicle.offsetMeters)));
    if (vehicle.health !== vehicle.renderedHealth) paintMarker(markerEntry, vehicle);
  }
  syncSelectedMarker();
}

/** Flies to a vehicle and keeps the camera on it until the user moves the map. */
export function startFollowingVehicle(vehicleId, lngLat) {
  if (!state.map) return;
  const previous = state.markers[state.followVehicleId];
  if (previous && state.followVehicleId !== vehicleId) {
    setMarkerPriority(previous, false);
    previous.popup.remove();
  }

  state.followVehicleId = vehicleId;
  const markerEntry = state.markers[vehicleId];
  if (markerEntry) {
    setMarkerPriority(markerEntry, true);
    markerEntry.popup.setLngLat(markerEntry.marker.getLngLat()).addTo(state.map);
  }

  const center = toLngLat(lngLat);
  if (!center) return;
  const currentZoom = state.map.getZoom();
  state.map.flyTo({
    center,
    zoom: Math.min(
      FOLLOW_MAX_ZOOM,
      Math.max(
        currentZoom + FOLLOW_CLICK_ZOOM_STEP,
        (state.baseZoom ?? currentZoom) + FOLLOW_ZOOM_OFFSET,
      ),
    ),
    duration: 850,
    essential: true,
  });
}

export function stopFollowingVehicle() {
  const markerEntry = state.markers[state.followVehicleId];
  if (markerEntry) {
    setMarkerPriority(markerEntry, false);
    markerEntry.popup.remove();
  }
  state.followVehicleId = null;
}

function moveVehicleOnto(vehicle, targetCorridor, currentCorridor) {
  const currentPoint = getPointAtDistance(currentCorridor, vehicle.offsetMeters);
  vehicle.corridorId = targetCorridor.id;
  vehicle.offsetMeters = findNearestPointOnCorridor(targetCorridor, currentPoint).offsetMeters;
  vehicle.zone = targetCorridor.zone;
  vehicle.status = corridorVehicleStatus(targetCorridor);
}

function findDetoursAround(corridor) {
  const blocked = new Set(
    Object.keys(state.corridors).filter(
      (corridorId) => getControlState(state.authority.rules, corridorId) === CONTROL_STATE_CLOSED,
    ),
  );
  blocked.add(corridor.id);
  return findDetourRoutes(state.corridors, corridor.from, corridor.to, {
    limit: 3,
    blockedCorridorIds: blocked,
  });
}

/** Moves a vehicle to the nearest corridor of any detour. Returns false if there is none. */
function rerouteOffCorridor(vehicle, corridor, detours = findDetoursAround(corridor)) {
  const currentPoint = getPointAtDistance(corridor, vehicle.offsetMeters);
  let best = null;
  for (const detour of detours) {
    for (const { corridorId } of detour.segmentRefs) {
      const candidate = state.corridors[corridorId];
      if (!candidate) continue;
      const { distanceSq } = findNearestPointOnCorridor(candidate, currentPoint);
      if (!best || distanceSq < best.distanceSq) best = { corridor: candidate, distanceSq };
    }
  }
  if (!best || best.corridor.id === corridor.id) return false;
  moveVehicleOnto(vehicle, best.corridor, corridor);
  return true;
}

/**
 * Reroutes every moving vehicle off a segment that was just blocked.
 *
 * @returns {number} how many vehicles were rerouted
 */
export function rerouteVehiclesOffCorridor(corridorId) {
  const corridor = state.corridors[corridorId];
  if (!corridor) return 0;
  const detours = findDetoursAround(corridor);
  if (detours.length === 0) return 0;

  let rerouted = 0;
  for (const vehicle of state.vehicles) {
    if (vehicle.corridorId !== corridorId || vehicle.health === "critical") continue;
    if (rerouteOffCorridor(vehicle, corridor, detours)) rerouted += 1;
  }
  if (rerouted > 0) {
    pushEvent(`${rerouted} vehicles rerouted away from ${formatCorridorLabel(corridor)}.`, "info");
  }
  return rerouted;
}

/**
 * Advances every vehicle and its marker by `deltaSec` seconds.
 *
 * @returns {{ vehicle: object, point: number[] }[]} vehicles that entered Emergency in this step
 */
export function advanceFleet(deltaSec) {
  const activated = [];
  let followPoint = null;

  for (const vehicle of state.vehicles) {
    let corridor = state.corridors[vehicle.corridorId];
    if (!corridor) continue;

    // Vehicles still on a blocked segment (for example after a failed reroute) keep trying.
    const isBlocked = getControlState(state.authority.rules, corridor.id) === CONTROL_STATE_CLOSED;
    if (isBlocked && vehicle.health !== "critical" && rerouteOffCorridor(vehicle, corridor)) {
      corridor = state.corridors[vehicle.corridorId];
    }

    const entered = stepVehicle(vehicle, {
      status: corridorVehicleStatus(corridor),
      zone: corridor.zone,
      totalMeters: corridor.totalMeters,
      deltaSec,
    });
    const point = getPointAtDistance(corridor, vehicle.offsetMeters);
    if (entered) activated.push({ vehicle, point });
    if (vehicle.id === state.followVehicleId) followPoint = point;

    const markerEntry = state.markers[vehicle.id];
    if (markerEntry && !state.isMapZooming) {
      markerEntry.marker.setLngLat(toLngLat(point));
      if (vehicle.health !== vehicle.renderedHealth) paintMarker(markerEntry, vehicle);
    }
  }

  if (followPoint && state.map && !state.isMapZooming) {
    state.map.setCenter(toLngLat(followPoint));
  }
  return activated;
}

/** Operator "Resume Vehicle". Returns false if the vehicle has to stay stopped. */
export function resumeVehicle(vehicle) {
  const released = releaseEmergencyLatch(vehicle);
  const markerEntry = state.markers[vehicle.id];
  if (markerEntry) paintMarker(markerEntry, vehicle);
  return released;
}

export function randomizeVehicleAlerts(random = Math.random) {
  for (const vehicle of state.vehicles) {
    const { alert, degraded } = nextAlert(vehicle, random);
    vehicle.alert = alert;
    if (degraded) pushEvent(`${vehicle.id}: Minor telemetry degradation detected.`, "info");
  }
}

/**
 * Puts a random healthy vehicle into a critical alert. The next fleet step
 * latches it into Emergency.
 *
 * @returns {object | null} the vehicle, or null if every vehicle is already in Emergency
 */
export function triggerEmergencyAlert(reason, random = Math.random) {
  const candidates = state.vehicles.filter(
    (vehicle) => !vehicle.emergencyLatched && vehicle.health !== "critical",
  );
  if (candidates.length === 0) return null;
  const vehicle = pickRandom(candidates, random);
  vehicle.alert = "critical";
  vehicle.emergencyNotified = false;
  pushEvent(`${vehicle.id}: ${reason} emergency scenario triggered.`, "critical");
  return vehicle;
}
