// Vehicle state transitions. DOM-free; functions that update a vehicle
// mutate the object they are given, because markers and views keep
// references to the same vehicle objects.
//
// Vocabulary:
//   status            authority status of the vehicle's corridor ("Approved", "Conditional")
//   alert             simulated telemetry alert ("none", "warn", "critical")
//   health            "ok" | "warn" | "critical", derived from status and alert
//   operationalState  what operators see: "Good" | "Warning" | "Emergency"
//   emergencyLatched  an Emergency stays latched (vehicle stopped) until an operator resumes it

import { VEHICLE_TYPES } from "../config.js";
import { randomInt, shuffle } from "./random.js";

/** Health implied by a status or operational state label. The check order matters. */
export function statusToHealth(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("good")) return "ok";
  if (value.includes("emergency")) return "critical";
  if (value.includes("warning")) return "warn";
  if (value.includes("approved")) return "ok";
  if (value.includes("hold")) return "critical";
  return "warn";
}

/** CSS class for a status or operational state label. */
export function toStatusClass(status) {
  const health = statusToHealth(status);
  if (health === "ok") return "status-approved";
  if (health === "critical") return "status-hold";
  return "status-conditional";
}

/** Health from the corridor status and the current alert. */
export function resolveVehicleHealth(status, alert) {
  if (alert === "critical") return "critical";
  const base = statusToHealth(status);
  if (alert === "warn") return base === "critical" ? "critical" : "warn";
  return base;
}

export function healthToOperationalState(health) {
  if (health === "ok") return "Good";
  if (health === "critical") return "Emergency";
  return "Warning";
}

/** Moves along a looping corridor; stopped vehicles stay put. */
export function advanceOffset(offsetMeters, speedKmh, deltaSec, totalMeters) {
  const speedMps = speedKmh / 3.6;
  if (speedMps <= 0) return offsetMeters;
  let next = offsetMeters + speedMps * deltaSec;
  while (next > totalMeters) next -= totalMeters;
  return next;
}

/**
 * One simulation step for a vehicle on its corridor.
 *
 * @param {object} vehicle mutated in place
 * @param {{ status: string, zone: string, totalMeters: number, deltaSec: number }} context
 * @returns {boolean} true when the vehicle entered Emergency in this step
 */
export function stepVehicle(vehicle, { status, zone, totalMeters, deltaSec }) {
  const wasLatched = vehicle.emergencyLatched;
  vehicle.zone = zone;
  vehicle.status = status;
  vehicle.health = wasLatched ? "critical" : resolveVehicleHealth(status, vehicle.alert);
  if (vehicle.health === "critical") vehicle.emergencyLatched = true;
  vehicle.operationalState = healthToOperationalState(vehicle.health);
  vehicle.currentSpeedKmh = vehicle.health === "critical" ? 0 : vehicle.speedKmh;
  vehicle.offsetMeters = advanceOffset(
    vehicle.offsetMeters,
    vehicle.currentSpeedKmh,
    deltaSec,
    totalMeters,
  );

  if (vehicle.health === "critical" && !vehicle.emergencyNotified && !wasLatched) {
    vehicle.emergencyNotified = true;
    return true;
  }
  if (vehicle.health !== "critical" && !vehicle.emergencyLatched) {
    vehicle.emergencyNotified = false;
  }
  return false;
}

/**
 * Operator "Resume Vehicle". Releases the latch unless the corridor status
 * itself is an emergency.
 *
 * @returns {boolean} whether the vehicle was released
 */
export function releaseEmergencyLatch(vehicle) {
  const health = resolveVehicleHealth(vehicle.status, "none");
  if (health === "critical") {
    vehicle.emergencyLatched = true;
    vehicle.health = "critical";
    vehicle.operationalState = healthToOperationalState("critical");
    vehicle.currentSpeedKmh = 0;
    return false;
  }

  vehicle.emergencyLatched = false;
  vehicle.emergencyNotified = false;
  vehicle.alert = "none";
  vehicle.health = health;
  vehicle.operationalState = healthToOperationalState(health);
  vehicle.currentSpeedKmh = vehicle.speedKmh;
  return true;
}

/**
 * Random walk of the telemetry alert: critical alerts calm down to warnings,
 * warnings clear, and healthy vehicles occasionally degrade.
 *
 * @returns {{ alert: string, degraded: boolean }}
 */
export function nextAlert(vehicle, random = Math.random) {
  if (vehicle.emergencyLatched) return { alert: vehicle.alert, degraded: false };
  if (vehicle.alert === "critical")
    return { alert: random() > 0.72 ? "warn" : "critical", degraded: false };
  if (vehicle.alert === "warn")
    return { alert: random() > 0.62 ? "none" : "warn", degraded: false };
  if (random() > 0.94) return { alert: "warn", degraded: true };
  return { alert: vehicle.alert, degraded: false };
}

/**
 * Progress along the corridor and minutes to its end at the current speed.
 *
 * @returns {{ progressPct: number, etaMinutes: number | null }} etaMinutes is null when stopped
 */
export function computeProgress(offsetMeters, totalMeters, speedKmh) {
  const speedMps = Math.max(speedKmh, 0) / 3.6;
  const remainingMeters = Math.max(0, totalMeters - offsetMeters);
  return {
    progressPct: Math.min(100, Math.max(0, Math.round((offsetMeters / totalMeters) * 100))),
    etaMinutes: speedMps > 0 ? Math.max(1, Math.round(remainingMeters / speedMps / 60)) : null,
  };
}

/** Counts per operational state, stopped vehicles and average speed. */
export function summarizeFleet(vehicles) {
  const count = (state) => vehicles.filter((vehicle) => vehicle.operationalState === state).length;
  const totalSpeed = vehicles.reduce((sum, vehicle) => sum + vehicle.currentSpeedKmh, 0);
  return {
    total: vehicles.length,
    good: count("Good"),
    warning: count("Warning"),
    emergency: count("Emergency"),
    stopped: vehicles.filter((vehicle) => vehicle.currentSpeedKmh <= 0).length,
    averageSpeedKmh: vehicles.length > 0 ? Math.round(totalSpeed / vehicles.length) : 0,
  };
}

export function describeEmergencyCause(vehicle) {
  if (vehicle.emergencyLatched) {
    return "Operator lock active. Vehicle remains in emergency stop until explicit operator release.";
  }
  if (vehicle.alert === "critical") {
    return "Critical telemetry anomaly. Vehicle has been forced to immediate stop pending authority validation.";
  }
  if (String(vehicle.status).toLowerCase().includes("hold")) {
    return "Authority hold triggered. Vehicle is stopped due to emergency zone restriction.";
  }
  return "Emergency supervision trigger detected. Vehicle remains stopped until operator release.";
}

/**
 * Spreads `count` vehicles over the corridors (round robin over a shuffled
 * corridor list) at random positions and speeds.
 *
 * @param {Record<string, object>} corridors
 * @param {number} count
 * @param {{ getStatus: (corridor: object) => string, random?: () => number }} options
 */
export function createVehicles(corridors, count, { getStatus, random = Math.random }) {
  const corridorIds = shuffle(Object.keys(corridors), random);
  if (corridorIds.length === 0) return [];

  return Array.from({ length: count }, (_, i) => {
    const type = VEHICLE_TYPES[i % VEHICLE_TYPES.length];
    const speedKmh = randomInt(type.speed[0], type.speed[1], random);
    const corridor = corridors[corridorIds[i % corridorIds.length]];
    const status = getStatus(corridor);
    const health = statusToHealth(status);
    return {
      id: `AT-AV-${701 + i}`,
      class: type.name,
      speedKmh,
      currentSpeedKmh: speedKmh,
      corridorId: corridor.id,
      offsetMeters: random() * corridor.totalMeters,
      zone: corridor.zone,
      status,
      health,
      operationalState: healthToOperationalState(health),
      alert: "none",
      emergencyLatched: false,
      emergencyNotified: false,
      renderedHealth: null,
    };
  });
}
