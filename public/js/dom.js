// References to the static elements of index.html. Looked up once; a missing
// element is a programming error, so it fails loudly at start-up.

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id} in index.html`);
  return element;
}

export const el = {
  navItems: Array.from(document.querySelectorAll(".nav-item")),

  // Left rail
  emergencyList: byId("emergencyList"),

  // Map stage
  map: byId("map"),
  vehicleCount: byId("vehicleCount"),
  criticalCount: byId("criticalCount"),
  emergencyNotice: byId("emergencyNotice"),
  mapEmergencyCard: byId("mapEmergencyCard"),
  mapEmergencyTitle: byId("mapEmergencyTitle"),
  mapEmergencyDescription: byId("mapEmergencyDescription"),
  mapEmergencyMeta: byId("mapEmergencyMeta"),
  approvalMapCard: byId("approvalMapCard"),
  approvalMapTitle: byId("approvalMapTitle"),
  approvalMapMeta: byId("approvalMapMeta"),
  approvalMapSignal: byId("approvalMapSignal"),
  approvalMapSeverity: byId("approvalMapSeverity"),
  approvalMapType: byId("approvalMapType"),
  approvalMapSpan: byId("approvalMapSpan"),
  approvalMapAge: byId("approvalMapAge"),
  approvalMapAction: byId("approvalMapAction"),
  approvalMapSource: byId("approvalMapSource"),

  // Standalone views
  viewIncidents: byId("viewIncidents"),
  incidentList: byId("incidentList"),
  viewTransmission: byId("viewTransmission"),
  txNodeGrid: byId("txNodeGrid"),
  txNodeInspector: byId("txNodeInspector"),

  // Right rail: Area Approval
  approvalSidebar: byId("approvalSidebar"),
  approvalSegmentName: byId("approvalSegmentName"),
  approvalSegmentBadge: byId("approvalSegmentBadge"),
  approvalSegmentMeta: byId("approvalSegmentMeta"),
  approvalEmptyState: byId("approvalEmptyState"),
  approvalSegmentPanel: byId("approvalSegmentPanel"),
  approvalSegmentWhy: byId("approvalSegmentWhy"),
  approvalSignalsBlock: byId("approvalSignalsBlock"),
  approvalSignalList: byId("approvalSignalList"),

  // Right rail: Live Operations
  vehicleInspector: byId("vehicleInspector"),
  vehicleInspectorEmpty: byId("vehicleInspectorEmpty"),
  dangerIndexes: byId("dangerIndexes"),
  dangerChart: byId("dangerChart"),
  kpis: byId("kpis"),
};
