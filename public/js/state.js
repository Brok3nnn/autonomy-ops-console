// The single mutable state object of the console. Modules read and update
// their own slice; there is no persistence, everything resets on reload.

import { CHANNELS, CONTROL_AREAS, TX_NODES } from "./config.js";

export const state = {
  // Map
  map: null,
  baseZoom: null,
  isMapZooming: false,

  // Network and fleet
  corridors: {},
  vehicles: [],
  /** vehicle id -> { marker, element, popup } */
  markers: {},
  selectedVehicleId: null,
  selectedEmergencyVehicleId: null,
  followVehicleId: null,

  // Simulated operations
  /** Operational feed, newest first. Used as an input of the Area Approval signals. */
  feed: [],
  areas: CONTROL_AREAS.map((area) => ({ ...area })),
  channels: CHANNELS.map((channel) => ({ ...channel })),

  // Road danger index (see public/js/risk-feed.js)
  risk: { payload: null, error: null, inFlight: false },

  // Views
  activeNav: "live",
  emergencyNoticeTimeoutId: null,
  authority: {
    selectedCorridorId: "",
    selectedSignalId: "",
    /** corridor id -> "open" | "closed", set by operators */
    rules: {},
    /** Per-bucket cache of segment cores, see buildAuthoritySnapshot(). */
    cache: { bucket: null, cores: {} },
    mapRenderKey: null,
    interactionsBound: false,
    hoverPopup: null,
  },
  incidents: {
    expandedVehicleId: null,
  },
  transmission: {
    selectedNodeId: null,
    /** node id -> { integrity, mode, sparkline, logs } */
    nodes: Object.fromEntries(
      TX_NODES.map((node) => [
        node.id,
        { integrity: 100, mode: "Online", sparkline: null, logs: [] },
      ]),
    ),
    /** "<action>:<node id>" keys of actions still running */
    pendingActions: new Set(),
  },

  // Simulation clock (requestAnimationFrame timestamps)
  clock: {
    lastFrameTs: 0,
    lastFeedTs: 0,
    lastAreaShiftTs: 0,
    lastAlertShiftTs: 0,
    lastInspectorRenderTs: 0,
  },
};
