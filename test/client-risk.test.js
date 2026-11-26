import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIVE_MAX_AGE_MS,
  SIMULATION_BASELINE,
  buildRiskPanelModel,
  computeOverallRisk,
  describeProvider,
  effectiveProviderStatus,
  gaugeArcPath,
  normalizeRoadRiskPayload,
  riskLevel,
  scoreToGaugeAngle,
  simulationInputs,
} from "../public/js/lib/risk.js";

const NOW = Date.UTC(2026, 10, 26, 9, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

const payload = {
  generatedAt: iso(NOW),
  signals: {
    weather: { score: 40, provider: "openMeteo" },
    news: { score: null, provider: "gdelt" },
    incidents: { score: null, provider: "gdelt" },
  },
  providers: {
    openMeteo: {
      name: "Open-Meteo",
      status: "live",
      updatedAt: iso(NOW),
      checkedAt: iso(NOW),
      retryAt: null,
      error: null,
    },
    gdelt: {
      name: "GDELT",
      status: "unavailable",
      updatedAt: null,
      checkedAt: iso(NOW),
      retryAt: iso(NOW + 5 * 60 * 1000),
      error: "rate-limited",
    },
  },
};

describe("computeOverallRisk", () => {
  it("uses the 0.34 / 0.28 / 0.38 weights when every input is present", () => {
    assert.equal(
      computeOverallRisk({ weather: 50, news: 20, incidents: 80 }),
      Math.round(50 * 0.34 + 20 * 0.28 + 80 * 0.38),
    );
  });

  it("rescales the weights over the inputs that are available", () => {
    assert.equal(computeOverallRisk({ weather: 40, news: null, incidents: null }), 40);
    assert.equal(
      computeOverallRisk({ weather: 40, news: null, incidents: 70 }),
      Math.round((40 * 0.34 + 70 * 0.38) / (0.34 + 0.38)),
    );
  });

  it("returns null without inputs and clamps out-of-range scores", () => {
    assert.equal(
      computeOverallRisk({ weather: null, news: undefined, incidents: Number.NaN }),
      null,
    );
    assert.equal(computeOverallRisk({ weather: 250, news: 100, incidents: 100 }), 100);
  });
});

describe("risk levels and gauge", () => {
  it("bands scores at 45 and 75", () => {
    assert.equal(riskLevel(44).label, "Stable");
    assert.equal(riskLevel(45).label, "Watch closely");
    assert.equal(riskLevel(75).className, "status-hold");
  });

  it("maps 0..100 onto the upper half circle", () => {
    assert.equal(scoreToGaugeAngle(0), 180);
    assert.equal(scoreToGaugeAngle(50), 270);
    assert.equal(scoreToGaugeAngle(150), 360);
    assert.equal(
      gaugeArcPath(160, 142, 108, 180, 360),
      "M 52.00 142.00 A 108 108 0 0 1 268.00 142.00",
    );
  });
});

describe("normalizeRoadRiskPayload", () => {
  it("keeps valid scores and provider timestamps", () => {
    const normalized = normalizeRoadRiskPayload(payload);
    assert.equal(normalized.signals.weather.score, 40);
    assert.equal(normalized.providers.gdelt.retryAt, NOW + 5 * 60 * 1000);
    assert.equal(normalized.providers.openMeteo.updatedAt, NOW);
  });

  it("never shows a score from an unavailable provider or a malformed payload", () => {
    const tampered = structuredClone(payload);
    tampered.signals.news.score = 55;
    assert.equal(normalizeRoadRiskPayload(tampered).signals.news.score, null);

    const garbage = normalizeRoadRiskPayload({
      signals: { weather: { score: "high", provider: "x" } },
    });
    assert.deepEqual(garbage.signals.weather, { score: null, providerId: "x" });
    assert.equal(normalizeRoadRiskPayload(null).signals.incidents.score, null);
  });
});

describe("provider status text", () => {
  const providers = normalizeRoadRiskPayload(payload).providers;

  it("treats an old 'live' reading as cached", () => {
    const old = { ...providers.openMeteo, updatedAt: NOW - LIVE_MAX_AGE_MS - 1 };
    assert.equal(effectiveProviderStatus(old, NOW), "cached");
    assert.equal(effectiveProviderStatus(providers.openMeteo, NOW), "live");
  });

  it("explains why a provider is unavailable and when it is retried", () => {
    const { status, text } = describeProvider(providers.gdelt, NOW);
    assert.equal(status, "unavailable");
    assert.match(text, /^GDELT · unavailable · rate-limited, retry \d{2}:\d{2}$/);
    assert.match(
      describeProvider({ ...providers.gdelt, error: "http-502", retryAt: null }, NOW).text,
      /HTTP 502$/,
    );
  });
});

describe("buildRiskPanelModel", () => {
  it("shows partial inputs honestly", () => {
    const model = buildRiskPanelModel(
      { payload: normalizeRoadRiskPayload(payload), error: null },
      NOW,
    );
    assert.deepEqual(
      model.entries.map((entry) => [entry.key, entry.score, entry.source.status]),
      [
        ["weather", 40, "live"],
        ["news", null, "unavailable"],
        ["incidents", null, "unavailable"],
      ],
    );
    assert.equal(model.overall.score, 40);
    assert.equal(model.overall.note, "Based on 1 of 3 inputs");
  });

  it("reports an unreachable API and the initial loading state", () => {
    const failed = buildRiskPanelModel({ payload: null, error: "unreachable" }, NOW);
    assert.equal(failed.entries[0].source.text, "Risk API unreachable");
    assert.equal(failed.overall.score, null);
    assert.equal(
      buildRiskPanelModel({ payload: null, error: null }, NOW).entries[0].source.status,
      "pending",
    );
  });
});

describe("simulationInputs", () => {
  it("falls back to the neutral baseline for missing inputs", () => {
    assert.deepEqual(simulationInputs(normalizeRoadRiskPayload(payload)), {
      weather: 40,
      news: SIMULATION_BASELINE.news,
      incidents: SIMULATION_BASELINE.incidents,
    });
    assert.deepEqual(simulationInputs(null), SIMULATION_BASELINE);
  });
});
