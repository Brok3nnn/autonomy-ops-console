// MapLibre setup: the base map, the Austria boundary, the reset control and
// the highlighted route of the selected vehicle. `maplibregl` is the global
// from the pinned MapLibre GL JS script in index.html.

import {
  AUSTRIA_VIEW_BOUNDS,
  MAP_EXTRA_ZOOM_OUT,
  MAP_MIN_START_ZOOM,
  MAP_STYLE_URL,
} from "./config.js";
import { el } from "./dom.js";
import { state } from "./state.js";

const BOUNDARY_SOURCE_ID = "austria-boundary-source";
const BOUNDARY_GLOW_LAYER_ID = "austria-boundary-glow";
const BOUNDARY_LINE_LAYER_ID = "austria-boundary-line";
const ROUTE_SOURCE_ID = "selected-route-source";
const ROUTE_GLOW_LAYER_ID = "selected-route-glow";
const ROUTE_LINE_LAYER_ID = "selected-route-line";

/** Credit for the Austria outline, listed in the map's attribution control. */
const BOUNDARY_ATTRIBUTION =
  'Boundary: <a href="https://www.geoboundaries.org/" target="_blank" rel="noopener">geoBoundaries</a> / BEV (<a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank" rel="noopener">CC BY-SA 2.0</a>)';

const [[SOUTH, WEST], [NORTH, EAST]] = AUSTRIA_VIEW_BOUNDS;
const AUSTRIA_CENTER_LNGLAT = [(WEST + EAST) / 2, (SOUTH + NORTH) / 2];

let mapReady = false;
const readyCallbacks = [];

/**
 * True once the map style has loaded and layers can be added.
 * (map.isStyleLoaded() also turns false while tiles stream in, so it is not
 * a reliable gate for adding layers.)
 */
export function isMapReady() {
  return mapReady;
}

/** Runs `callback` once the map style has loaded, or immediately if it has. */
export function onMapReady(callback) {
  if (mapReady) callback();
  else readyCallbacks.push(callback);
}

/**
 * Creates the map.
 *
 * @param {{ onLoad: () => void, onZoomEnd: () => void, onUserGesture: () => void, onReset: () => void }} handlers
 *   onUserGesture fires on any drag, click, wheel or touch on the map.
 */
export function initMap({ onLoad, onZoomEnd, onUserGesture, onReset }) {
  const map = new maplibregl.Map({
    container: el.map,
    style: MAP_STYLE_URL,
    attributionControl: true,
    dragRotate: false,
    touchPitch: false,
    pitchWithRotate: false,
    boxZoom: false,
    maxPitch: 0,
    antialias: true,
  });
  state.map = map;

  map.scrollZoom.setWheelZoomRate(1 / 150);
  map.scrollZoom.setZoomRate(1 / 90);

  map.once("load", () => {
    map.fitBounds(
      [
        [WEST, SOUTH],
        [EAST, NORTH],
      ],
      { padding: 12, duration: 0 },
    );
    state.baseZoom = Math.max(MAP_MIN_START_ZOOM, map.getZoom() - MAP_EXTRA_ZOOM_OUT);
    map.setZoom(state.baseZoom);
    map.setMinZoom(state.baseZoom);

    mapReady = true;
    readyCallbacks.splice(0).forEach((callback) => callback());
    onLoad();
  });

  map.on("error", (event) => {
    // Tile or style errors are logged, not fatal: the console keeps running.
    console.warn("Map error:", event.error?.message ?? event.error);
  });

  map.on("zoomstart", () => {
    state.isMapZooming = true;
  });
  map.on("zoomend", () => {
    state.isMapZooming = false;
    onZoomEnd();
  });
  map.on("dragstart", onUserGesture);
  map.on("click", onUserGesture);

  const canvasContainer = map.getCanvasContainer();
  canvasContainer.addEventListener("pointerdown", onUserGesture, { capture: true });
  canvasContainer.addEventListener("wheel", onUserGesture, { capture: true, passive: true });
  canvasContainer.addEventListener("touchstart", onUserGesture, { capture: true, passive: true });

  map.addControl(new ResetViewControl(onReset), "top-right");
  requestAnimationFrame(() => map.resize());
  return map;
}

class ResetViewControl {
  constructor(onReset) {
    this.onReset = onReset;
  }

  onAdd() {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group map-reset-control";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-reset-button";
    button.innerHTML = '<span class="map-reset-icon" aria-hidden="true"></span>';
    button.title = "Go to default Austria view";
    button.setAttribute("aria-label", "Go to default Austria view");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onReset();
    });

    this.container.appendChild(button);
    return this.container;
  }

  onRemove() {
    this.container?.remove();
    this.container = null;
  }
}

/** Eases back to the default Austria view. */
export function resetCamera() {
  if (!state.map) return;
  state.map.easeTo({
    center: AUSTRIA_CENTER_LNGLAT,
    zoom: state.baseZoom ?? state.map.getZoom(),
    duration: 850,
    essential: true,
  });
}

function removeLayers(layerIds, sourceId) {
  const { map } = state;
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/** Draws the Austria outline (a GeoJSON FeatureCollection) once the map is ready. */
export function showBoundary(geojson) {
  onMapReady(() => {
    const { map } = state;
    removeLayers([BOUNDARY_LINE_LAYER_ID, BOUNDARY_GLOW_LAYER_ID], BOUNDARY_SOURCE_ID);
    map.addSource(BOUNDARY_SOURCE_ID, {
      type: "geojson",
      data: geojson,
      attribution: BOUNDARY_ATTRIBUTION,
    });
    map.addLayer({
      id: BOUNDARY_GLOW_LAYER_ID,
      type: "line",
      source: BOUNDARY_SOURCE_ID,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#4cb3ff", "line-width": 7, "line-opacity": 0.26, "line-blur": 0.5 },
    });
    map.addLayer({
      id: BOUNDARY_LINE_LAYER_ID,
      type: "line",
      source: BOUNDARY_SOURCE_ID,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#d9f0ff", "line-width": 3.2, "line-opacity": 0.95 },
    });
  });
}

/** Highlights a [lat, lng] polyline as the selected vehicle's route. */
export function showRouteLine(points) {
  onMapReady(() => {
    const { map } = state;
    const data = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: points.map(([lat, lng]) => [lng, lat]) },
    };

    const source = map.getSource(ROUTE_SOURCE_ID);
    if (source) source.setData(data);
    else map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data });

    if (!map.getLayer(ROUTE_GLOW_LAYER_ID)) {
      map.addLayer({
        id: ROUTE_GLOW_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#1f5fe0", "line-width": 9, "line-opacity": 0.22 },
      });
    }
    if (!map.getLayer(ROUTE_LINE_LAYER_ID)) {
      map.addLayer({
        id: ROUTE_LINE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#3b82f6", "line-width": 4, "line-opacity": 0.96 },
      });
    }
  });
}

export function clearRouteLine() {
  onMapReady(() => removeLayers([ROUTE_LINE_LAYER_ID, ROUTE_GLOW_LAYER_ID], ROUTE_SOURCE_ID));
}
