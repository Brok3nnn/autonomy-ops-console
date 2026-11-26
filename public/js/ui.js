// Small UI helpers shared by several views.

import { TIMING } from "./config.js";
import { el } from "./dom.js";
import { state } from "./state.js";

/** Shows the red toast in the map corner for a few seconds. */
export function showEmergencyNotice(text) {
  el.emergencyNotice.textContent = text;
  el.emergencyNotice.hidden = false;
  el.emergencyNotice.classList.add("is-visible");

  clearTimeout(state.emergencyNoticeTimeoutId);
  state.emergencyNoticeTimeoutId = setTimeout(() => {
    el.emergencyNotice.classList.remove("is-visible");
    el.emergencyNotice.hidden = true;
    state.emergencyNoticeTimeoutId = null;
  }, TIMING.emergencyNoticeMs);
}
