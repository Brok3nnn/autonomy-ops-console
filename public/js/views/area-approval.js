// Area Approval: road segments coloured by control state and risk, simulated
// signal spans, hover popups, the selected-segment sidebar and the
// allow/block actions.

import { el } from "../dom.js";
import { rerouteVehiclesOffCorridor } from "../fleet.js";
import { isMapReady } from "../map.js";
import {
  CONTROL_STATE_CLOSED,
  CONTROL_STATE_OPEN,
  buildAuthoritySnapshot,
  controlStateBadgeClass,
  controlStateLabel,
} from "../lib/authority.js";
import {
  escapeHtml,
  formatAffectedDistance,
  formatCorridorLabel,
  shortenText,
} from "../lib/format.js";
import { toLngLat } from "../lib/geo.js";
import { simulationInputs } from "../lib/risk.js";
import { state } from "../state.js";

const SEGMENTS_SOURCE_ID = "authority-segments-source";
const SEGMENTS_CASING_LAYER_ID = "authority-segments-casing";
const SEGMENTS_LAYER_ID = "authority-segments-line";
const SEGMENTS_HIT_LAYER_ID = "authority-segments-hit";
const SEGMENTS_ALERT_LAYER_ID = "authority-segments-alert";
const SEGMENTS_SELECTED_LAYER_ID = "authority-segments-selected";
const SPANS_SOURCE_ID = "authority-signal-spans-source";
const SPANS_LAYER_ID = "authority-signal-spans-line";

const SEGMENT_LAYER_IDS = [SEGMENTS_HIT_LAYER_ID, SEGMENTS_SELECTED_LAYER_ID, SEGMENTS_LAYER_ID];
/** Bottom to top. */
const LAYER_ORDER = [
  SEGMENTS_CASING_LAYER_ID,
  SEGMENTS_ALERT_LAYER_ID,
  SEGMENTS_LAYER_ID,
  SEGMENTS_HIT_LAYER_ID,
  SEGMENTS_SELECTED_LAYER_ID,
  SPANS_LAYER_ID,
];

const byControlState = (open, closed) => [
  "match",
  ["get", "controlState"],
  CONTROL_STATE_OPEN,
  open,
  closed,
];
const byZoom = (...stops) => ["interpolate", ["linear"], ["zoom"], ...stops];
const ROUND_LINE = { "line-join": "round", "line-cap": "round" };

const LAYERS = [
  {
    id: SEGMENTS_CASING_LAYER_ID,
    source: SEGMENTS_SOURCE_ID,
    paint: {
      "line-color": "#07111d",
      "line-width": byZoom(4, 4.8, 6.5, 5.9, 9, 7.5, 12, 9.7, 15, 12.4),
      "line-opacity": 0.82,
    },
  },
  {
    id: SEGMENTS_LAYER_ID,
    source: SEGMENTS_SOURCE_ID,
    paint: {
      "line-color": byControlState("#35c98b", "#e15252"),
      "line-width": byZoom(4, 2.85, 6.5, 3.7, 9, 4.95, 12, 6.45, 15, 8.2),
      "line-opacity": ["interpolate", ["linear"], ["get", "riskScore"], 0, 0.9, 100, 1],
    },
  },
  {
    // Wide, invisible line that makes thin segments easy to hover and click.
    id: SEGMENTS_HIT_LAYER_ID,
    source: SEGMENTS_SOURCE_ID,
    paint: {
      "line-color": "#ffffff",
      "line-width": byZoom(4, 16, 7.5, 22, 10.5, 28, 13.5, 34),
      "line-opacity": 0,
    },
  },
  {
    id: SEGMENTS_ALERT_LAYER_ID,
    source: SEGMENTS_SOURCE_ID,
    filter: ["==", ["get", "hasAlert"], 1],
    paint: {
      "line-color": byControlState("rgba(99, 243, 173, 0.7)", "rgba(255, 126, 137, 0.72)"),
      "line-width": byZoom(4, 6.2, 8, 8, 12, 10.6, 15, 13.4),
      "line-opacity": byZoom(4, 0.18, 9, 0.24, 13, 0.3),
      "line-blur": 0.75,
    },
  },
  {
    id: SEGMENTS_SELECTED_LAYER_ID,
    source: SEGMENTS_SOURCE_ID,
    filter: ["==", ["get", "isSelected"], 1],
    paint: {
      "line-color": byControlState("#63f3ad", "#ff7e89"),
      "line-width": byZoom(4, 4.15, 6.5, 5.3, 9, 6.95, 12, 8.85, 15, 11.1),
      "line-opacity": 1,
    },
  },
  {
    id: SPANS_LAYER_ID,
    source: SPANS_SOURCE_ID,
    paint: {
      "line-color": "#ffd34f",
      "line-width": byZoom(4, 2.6, 6.5, 3.1, 9, 3.95, 12, 4.95, 15, 6.15),
      "line-opacity": 0.95,
    },
  },
];

function lineString(points) {
  return { type: "LineString", coordinates: points.map(([lat, lng]) => [lng, lat]) };
}

/** Builds the snapshot from the current state; selection is resolved here. */
function getSnapshot() {
  const snapshot = buildAuthoritySnapshot({
    corridors: Object.values(state.corridors),
    vehicles: state.vehicles,
    feed: state.feed,
    inputs: simulationInputs(state.risk.payload),
    rules: state.authority.rules,
    nowMs: Date.now(),
    cache: state.authority.cache,
  });
  const { selectedCorridorId, selectedSignalId } = state.authority;
  snapshot.selected =
    snapshot.segments.find((segment) => segment.corridorId === selectedCorridorId) ?? null;
  snapshot.selectedSignal =
    snapshot.signals.find((signal) => signal.id === selectedSignalId) ?? null;
  return snapshot;
}

/** Drops a selection whose corridor no longer exists. */
export function ensureAuthoritySelection() {
  if (!state.corridors[state.authority.selectedCorridorId]) {
    state.authority.selectedCorridorId = "";
    state.authority.selectedSignalId = "";
  }
}

function selectCorridor(corridorId, signalId = "") {
  state.authority.selectedCorridorId = corridorId;
  state.authority.selectedSignalId = signalId;
}

function renderMapCard(snapshot) {
  const signal = snapshot?.selectedSignal;
  const segment =
    signal && snapshot.segments.find((candidate) => candidate.corridorId === signal.corridorId);
  if (!signal || !segment) {
    el.approvalMapCard.hidden = true;
    return;
  }
  el.approvalMapTitle.textContent = signal.title;
  el.approvalMapMeta.textContent = formatCorridorLabel(segment.corridor);
  el.approvalMapSignal.textContent = signal.summary;
  el.approvalMapSeverity.textContent = `${signal.severity} / 100`;
  el.approvalMapType.textContent = signal.typeLabel;
  el.approvalMapSpan.textContent = formatAffectedDistance(signal.spanMeters).replace(
    "Affected ",
    "",
  );
  el.approvalMapAge.textContent = `${signal.minutesAgo} min`;
  el.approvalMapAction.textContent = `Action: ${signal.recommendedAction}`;
  el.approvalMapSource.textContent = `Source: ${signal.sourceLabel}`;
  el.approvalMapCard.hidden = false;
}

function renderSidebar(snapshot) {
  const { selected } = snapshot;
  if (!selected) {
    el.approvalSegmentName.textContent = "Select a road";
    el.approvalSegmentMeta.textContent = "";
    el.approvalSegmentMeta.hidden = true;
    el.approvalSegmentBadge.hidden = true;
    el.approvalEmptyState.textContent = "Select a road on the map.";
    el.approvalEmptyState.hidden = false;
    el.approvalSegmentPanel.hidden = true;
    el.approvalSignalList.innerHTML = "";
    return;
  }

  const signals = snapshot.mapSignals.filter((signal) => signal.corridorId === selected.corridorId);
  if (signals.length === 0) state.authority.selectedSignalId = "";
  const isBlocked = selected.controlState === CONTROL_STATE_CLOSED;

  el.approvalSegmentName.textContent = formatCorridorLabel(selected.corridor);
  el.approvalSegmentMeta.textContent = [
    selected.corridor.zone,
    `Risk ${selected.riskScore}/100`,
    `${selected.affectedVehicles} vehicles`,
    `${signals.length} active alerts`,
  ].join(" · ");
  el.approvalSegmentMeta.hidden = false;
  el.approvalSegmentBadge.textContent = controlStateLabel(selected.controlState);
  el.approvalSegmentBadge.className = `approval-state-badge ${controlStateBadgeClass(selected.controlState)}`;
  el.approvalSegmentBadge.hidden = false;
  el.approvalEmptyState.hidden = true;
  el.approvalSegmentPanel.hidden = false;
  el.approvalSegmentWhy.textContent = `${selected.whyHighlight} ${selected.recommendedAction}`;
  el.approvalSignalsBlock.hidden = signals.length === 0;
  el.approvalSignalList.innerHTML = signals
    .map((signal) => {
      const activeClass = signal.id === state.authority.selectedSignalId ? "is-active" : "";
      const span = formatAffectedDistance(signal.spanMeters).replace("Affected ", "");
      return `
        <button type="button" class="approval-signal-chip emergency-item ${activeClass}" data-signal-id="${escapeHtml(signal.id)}">
          <strong>${escapeHtml(signal.title)}</strong>
          <span class="mono">${escapeHtml(signal.typeLabel)} · ${escapeHtml(span)}</span>
        </button>`;
    })
    .join("");

  for (const button of el.approvalSegmentPanel.querySelectorAll("[data-segment-action]")) {
    const action = button.dataset.segmentAction;
    button.disabled = action === "allow" ? !isBlocked : isBlocked;
  }
}

function mapRenderKey(snapshot) {
  const segmentKey = snapshot.segments
    .map(
      (segment) =>
        `${segment.corridorId}:${segment.controlState}:${segment.riskScore}:${Number(segment.hasAlert)}:${Number(segment === snapshot.selected)}`,
    )
    .join("|");
  const signalKey = snapshot.mapSignals
    .map((signal) => `${signal.id}:${signal.severity}:${signal.minutesAgo}`)
    .join("|");
  return `${segmentKey}::${signalKey}`;
}

function setSourceData(sourceId, data) {
  const source = state.map.getSource(sourceId);
  if (source) source.setData(data);
  else state.map.addSource(sourceId, { type: "geojson", data });
}

function renderMapLayers(snapshot) {
  const { map } = state;
  const renderKey = mapRenderKey(snapshot);
  if (renderKey === state.authority.mapRenderKey && map.getSource(SEGMENTS_SOURCE_ID)) return;
  state.authority.mapRenderKey = renderKey;

  setSourceData(SEGMENTS_SOURCE_ID, {
    type: "FeatureCollection",
    features: snapshot.segments.map((segment) => ({
      type: "Feature",
      properties: {
        id: segment.corridorId,
        label: formatCorridorLabel(segment.corridor),
        controlState: segment.controlState,
        riskScore: segment.riskScore,
        hasAlert: Number(segment.hasAlert),
        isSelected: Number(segment === snapshot.selected),
      },
      geometry: lineString(segment.corridor.points),
    })),
  });

  setSourceData(SPANS_SOURCE_ID, {
    type: "FeatureCollection",
    features: snapshot.mapSignals
      .filter((signal) => signal.spanCoordinates.length > 1)
      .map((signal) => ({
        type: "Feature",
        properties: {
          id: signal.id,
          corridorId: signal.corridorId,
          badge: signal.badge,
          typeLabel: signal.typeLabel,
          summary: signal.summary,
        },
        geometry: lineString(signal.spanCoordinates),
      })),
  });

  for (const layer of LAYERS) {
    if (!map.getLayer(layer.id)) map.addLayer({ type: "line", layout: ROUND_LINE, ...layer });
  }
  for (const layerId of LAYER_ORDER) map.moveLayer(layerId);
  bindMapInteractions();
}

function clearMapLayers() {
  const { map } = state;
  removeHoverPopup();
  for (const layerId of [...LAYER_ORDER].reverse()) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of [SPANS_SOURCE_ID, SEGMENTS_SOURCE_ID]) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
  state.authority.mapRenderKey = null;
}

/**
 * Renders the sidebar, map layers and signal card, or clears them outside the
 * view. Map layers wait for the map to load; the load handler renders again.
 */
export function renderAreaApproval() {
  const isActive = state.activeNav === "approvals";
  el.approvalSidebar.hidden = !isActive;
  if (!isActive) {
    el.approvalMapCard.hidden = true;
    if (isMapReady()) clearMapLayers();
    return;
  }

  const snapshot = getSnapshot();
  renderSidebar(snapshot);
  renderMapCard(snapshot);
  if (isMapReady()) renderMapLayers(snapshot);
}

function hoverPopup() {
  state.authority.hoverPopup ??= new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    closeOnMove: false,
    anchor: "top",
    offset: 10,
    className: "authority-hover-popup",
  });
  return state.authority.hoverPopup;
}

function showHoverPopup(lngLat, title, detail) {
  hoverPopup()
    .setLngLat(lngLat)
    .setHTML(
      `<div class="authority-hover-card"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`,
    )
    .addTo(state.map);
}

function removeHoverPopup() {
  state.authority.hoverPopup?.remove();
}

function featuresAt(point) {
  const layers = [SPANS_LAYER_ID, ...SEGMENT_LAYER_IDS].filter((layerId) =>
    state.map.getLayer(layerId),
  );
  if (layers.length === 0) return null;
  const features = state.map.queryRenderedFeatures(point, { layers });
  return {
    span: features.find((feature) => feature.layer.id === SPANS_LAYER_ID),
    segment: features.find((feature) => SEGMENT_LAYER_IDS.includes(feature.layer.id)),
    any: features.length > 0,
  };
}

function bindMapInteractions() {
  if (state.authority.interactionsBound) return;
  state.authority.interactionsBound = true;
  const { map } = state;

  map.on("mousemove", (event) => {
    if (state.activeNav !== "approvals") return;
    const hit = featuresAt(event.point);
    if (!hit) return;
    const canvas = map.getCanvas();
    if (hit.span) {
      const { badge, typeLabel, summary } = hit.span.properties;
      canvas.style.cursor = "pointer";
      showHoverPopup(event.lngLat, `${badge} · ${typeLabel}`, shortenText(summary));
    } else if (hit.segment) {
      const { label, controlState, riskScore } = hit.segment.properties;
      canvas.style.cursor = "pointer";
      showHoverPopup(
        event.lngLat,
        label,
        `${controlStateLabel(controlState)} · Risk ${Math.round(riskScore)}/100`,
      );
    } else {
      canvas.style.cursor = "";
      removeHoverPopup();
    }
  });

  map.on("mouseout", () => {
    map.getCanvas().style.cursor = "";
    removeHoverPopup();
  });

  map.on("click", (event) => {
    if (state.activeNav !== "approvals") return;
    const hit = featuresAt(event.point);
    if (!hit) return;
    const corridorId = hit.span?.properties.corridorId ?? hit.segment?.properties.id ?? "";
    selectCorridor(corridorId);
    removeHoverPopup();
    renderAreaApproval();
  });
}

function focusSignal(signal) {
  const { map } = state;
  if (signal.spanCoordinates.length > 0) {
    const bounds = new maplibregl.LngLatBounds();
    for (const point of signal.spanCoordinates) bounds.extend(toLngLat(point));
    const rightPadding = window.innerWidth > 1200 ? 360 : window.innerWidth > 760 ? 240 : 80;
    map.fitBounds(bounds, {
      padding: { top: 120, right: rightPadding, bottom: 80, left: 80 },
      maxZoom: 13.8,
      duration: 700,
    });
  } else {
    map.flyTo({
      center: toLngLat(signal.point),
      zoom: Math.max(map.getZoom(), 12.8),
      duration: 700,
      essential: true,
    });
  }
  removeHoverPopup();
}

/**
 * @param {{ onRulesChanged: () => void }} actions  called after a segment is allowed or blocked
 */
export function bindAreaApproval({ onRulesChanged }) {
  el.approvalSidebar.addEventListener("click", (event) => {
    const signalId = event.target.closest("[data-signal-id]")?.dataset.signalId;
    if (signalId) {
      const signal = getSnapshot().signals.find((candidate) => candidate.id === signalId);
      if (!signal) return;
      selectCorridor(signal.corridorId, signal.id);
      renderAreaApproval();
      focusSignal(signal);
      return;
    }

    const action = event.target.closest("[data-segment-action]")?.dataset.segmentAction;
    const corridorId = state.authority.selectedCorridorId;
    if (!action || !state.corridors[corridorId]) return;
    state.authority.rules[corridorId] =
      action === "block" ? CONTROL_STATE_CLOSED : CONTROL_STATE_OPEN;
    if (action === "block") rerouteVehiclesOffCorridor(corridorId);
    onRulesChanged();
  });
}
