// Transmission Health: simulated relay nodes with link telemetry, the units
// they serve and three remote actions.

import { TX_NODES } from "../config.js";
import { el } from "../dom.js";
import { pushEvent } from "../feed.js";
import { escapeHtml, formatTime } from "../lib/format.js";
import { getPointAtDistance } from "../lib/geo.js";
import { pickRandom } from "../lib/random.js";
import {
  createSparkline,
  nearestNodeId,
  nextSparkline,
  nodeBandwidthGbps,
  nodeLatencyMs,
  sparklinePath,
} from "../lib/telemetry.js";
import { state } from "../state.js";

const LOG_MESSAGES = [
  "BGP route refreshed.",
  "SYN_ACK from payload ok.",
  "[WATCH] Ping variance offset.",
  "Packet filtering routine OK.",
  "Uplink handshake active.",
  "Bandwidth allocation matched.",
];
const LOG_LIMIT = 8;
const UNIT_ROWS_LIMIT = 8;
const DEGRADED_BELOW = 90;

function nodeState(nodeId) {
  const node = state.transmission.nodes[nodeId];
  node.sparkline ??= createSparkline();
  if (node.logs.length === 0) node.logs.push("[SYS] Initializing sequence...");
  return node;
}

/** One telemetry tick: extends every sparkline and sometimes appends a log line. */
export function tickNodeTelemetry(random = Math.random) {
  for (const { id } of TX_NODES) {
    const node = nodeState(id);
    node.sparkline = nextSparkline(node.sparkline, random);
    if (random() > 0.4) {
      node.logs.push(`[${formatTime(new Date())}] ${pickRandom(LOG_MESSAGES, random)}`);
      node.logs.splice(0, Math.max(0, node.logs.length - LOG_LIMIT));
    }
  }
}

/** Vehicles grouped by the node closest to their current position. */
function unitsByNode() {
  const groups = Object.fromEntries(TX_NODES.map((node) => [node.id, []]));
  for (const vehicle of state.vehicles) {
    const corridor = state.corridors[vehicle.corridorId];
    if (!corridor) continue;
    groups[nearestNodeId(getPointAtDistance(corridor, vehicle.offsetMeters), TX_NODES)]?.push(
      vehicle,
    );
  }
  return groups;
}

function renderNodeCard(config, node, unitCount) {
  const classes = ["node-card"];
  if (node.integrity < DEGRADED_BELOW) classes.push("is-degraded");
  if (state.transmission.selectedNodeId === config.id) classes.push("is-active");
  return `
    <div class="${classes.join(" ")}" data-node-id="${config.id}" role="button" tabindex="0">
      <div class="node-header-row">
        <div class="node-name">${escapeHtml(config.name)}</div>
        <div class="node-live-dot" aria-hidden="true"></div>
      </div>
      <div class="node-status">${escapeHtml(node.mode.toUpperCase())}</div>
      <div class="node-stats">
        <div class="n-stat"><span>Bandwidth</span><strong>${nodeBandwidthGbps(node.integrity).toFixed(2)} GB/s</strong></div>
        <div class="n-stat"><span>Handshakes</span><strong>${unitCount} active</strong></div>
      </div>
    </div>`;
}

function renderUnitRows(units, random = Math.random) {
  if (units.length === 0) {
    return '<tr><td colspan="4" class="ops-table-empty">No vehicle telemetry routed.</td></tr>';
  }
  const healthOrder = { critical: 0, warn: 1, ok: 2 };
  const sorted = [...units].sort(
    (a, b) => healthOrder[a.health] - healthOrder[b.health] || a.id.localeCompare(b.id),
  );
  const rows = sorted.slice(0, UNIT_ROWS_LIMIT).map((vehicle) => {
    const healthClass =
      vehicle.health === "critical" ? "t-crit" : vehicle.health === "warn" ? "t-warn" : "t-ok";
    const packetLoss = vehicle.health === "critical" ? random() * 2 + 1 : random() * 0.05;
    return `
      <tr>
        <td class="${healthClass}">${escapeHtml(vehicle.id)}</td>
        <td>${(random() * 8 + 4).toFixed(1)} MB/s</td>
        <td>${packetLoss.toFixed(2)}%</td>
        <td>AES-256</td>
      </tr>`;
  });
  if (sorted.length > UNIT_ROWS_LIMIT) {
    rows.push(
      `<tr><td colspan="4" class="ops-table-empty">+${sorted.length - UNIT_ROWS_LIMIT} more units</td></tr>`,
    );
  }
  return rows.join("");
}

function actionButton(action, config, label, busyLabel, extraClass = "") {
  const isBusy = state.transmission.pendingActions.has(`${action}:${config.id}`);
  return `<button type="button" class="simple-action-btn ${extraClass} ${isBusy ? "is-loading" : ""}" data-node-action="${action}" data-node-id="${config.id}">${isBusy ? busyLabel : label}</button>`;
}

function renderInspector(config, node, units) {
  const isDegraded = node.integrity < DEGRADED_BELOW;
  const path = sparklinePath(node.sparkline, 400, 40);
  return `
    <div class="node-inspector-content">
      <div class="node-inspector-header">
        <div class="node-inspector-kicker">[ METRICS FOR SELECTED NODE ]</div>
        <h2>${escapeHtml(config.name)}</h2>
        <div class="ping-stat ${isDegraded ? "degraded" : ""}">UPLINK: ${config.uplink} // LATENCY: ${nodeLatencyMs(node.integrity)}ms</div>
        <div class="node-sparkline">
          <svg width="100%" height="40" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true">
            <path d="${path}" fill="none" stroke="${isDegraded ? "#f6b23f" : "#2ec27e"}" stroke-width="2" vector-effect="non-scaling-stroke"></path>
          </svg>
        </div>
      </div>
      <div class="ops-table-wrapper">
        <table class="ops-table">
          <thead><tr><th>UNIT ID</th><th>B/W ALLOC</th><th>PKT LOSS</th><th>ENCRYPTION</th></tr></thead>
          <tbody>${renderUnitRows(units)}</tbody>
        </table>
      </div>
      <div class="node-log-terminal">${node.logs.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>
      <div class="action-list node-actions">
        ${actionButton("power", config, "[ Cycle Node Power ]", "[ >> CYCLING POWER... ]")}
        ${actionButton("purge", config, "[ Purge Routing Cache ]", "[ >> PURGING CACHE... ]")}
        ${actionButton("reroute", config, "[ Reroute Traffic Stream ]", "[ >> MIGRATING HANDSHAKES... ]", "priority")}
      </div>
    </div>`;
}

export function renderTransmission() {
  const units = unitsByNode();
  el.txNodeGrid.innerHTML = TX_NODES.map((config) =>
    renderNodeCard(config, nodeState(config.id), units[config.id].length),
  ).join("");

  const selected = TX_NODES.find((config) => config.id === state.transmission.selectedNodeId);
  el.txNodeInspector.innerHTML = selected
    ? renderInspector(selected, nodeState(selected.id), units[selected.id])
    : '<div class="inspector-empty-state">Select an infrastructure node to manage traffic and bandwidth.</div>';
}

/** Runs a simulated remote action that completes after `durationMs`. */
function runNodeAction(key, durationMs, onDone, onChange) {
  state.transmission.pendingActions.add(key);
  setTimeout(() => {
    state.transmission.pendingActions.delete(key);
    onDone();
    onChange();
  }, durationMs);
}

function handleNodeAction(action, config, onChange) {
  const key = `${action}:${config.id}`;
  if (state.transmission.pendingActions.has(key)) return;
  const node = nodeState(config.id);
  const tag = `[NODE ${config.id}]`;

  if (action === "power") {
    pushEvent(`${tag} Initiating remote power cycle...`, "warn");
    node.integrity = 0;
    node.mode = "Offline";
    runNodeAction(
      key,
      4000,
      () => {
        node.integrity = 100;
        node.mode = "Online";
        pushEvent(`${tag} Power cycle complete. Node online.`, "info");
      },
      onChange,
    );
  } else if (action === "purge") {
    pushEvent(`${tag} Purging internal packet routing cache...`, "info");
    runNodeAction(
      key,
      1500,
      () => pushEvent(`${tag} Cache cleared successfully. Memory optimized.`, "info"),
      onChange,
    );
  } else if (action === "reroute") {
    if (node.integrity >= DEGRADED_BELOW) {
      pushEvent(`${tag} Node is stable. Reroute unnecessary.`, "info");
      return;
    }
    pushEvent(`${tag} Emergency reroute triggered. Migrating handshakes.`, "warn");
    runNodeAction(
      key,
      2500,
      () => {
        node.integrity = 100;
        node.mode = "Online";
        pushEvent(
          `${tag} Traffic successfully rerouted from ${config.name} to secondary uplink.`,
          "info",
        );
      },
      onChange,
    );
  }
  onChange();
}

/** @param {{ onChange: () => void }} actions  called after anything that needs a re-render */
export function bindTransmission({ onChange }) {
  el.viewTransmission.addEventListener("click", (event) => {
    const button = event.target.closest("[data-node-action]");
    if (button) {
      const config = TX_NODES.find((candidate) => candidate.id === button.dataset.nodeId);
      if (config) handleNodeAction(button.dataset.nodeAction, config, onChange);
      return;
    }
    const nodeId = event.target.closest(".node-card")?.dataset.nodeId;
    if (!nodeId) return;
    state.transmission.selectedNodeId =
      state.transmission.selectedNodeId === nodeId ? null : nodeId;
    onChange();
  });

  el.txNodeGrid.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches(".node-card")) {
      event.preventDefault();
      event.target.click();
    }
  });
}
