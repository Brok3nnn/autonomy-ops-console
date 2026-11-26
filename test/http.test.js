import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "../dev-server.js";
import { ROAD_RISK_CACHE_CONTROL, createRoadRiskHandler } from "../lib/http.js";

/** Minimal stand-in for Node's ServerResponse. */
function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

const snapshot = { generatedAt: "2026-11-26T09:00:00.000Z", signals: {}, providers: {} };

describe("road-risk handler", () => {
  it("returns the snapshot with CDN cache headers", async () => {
    const res = fakeResponse();
    await createRoadRiskHandler({ getSnapshot: async () => snapshot })({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], ROAD_RISK_CACHE_CONTROL);
    assert.match(res.headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(res.body), snapshot);
  });

  it("rejects other methods with 405", async () => {
    const res = fakeResponse();
    await createRoadRiskHandler({ getSnapshot: async () => snapshot })({ method: "POST" }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "GET, HEAD");
  });

  it("answers 500 without caching when the feed throws", async () => {
    const res = fakeResponse();
    const logger = { error: () => {} };
    const handler = createRoadRiskHandler(
      { getSnapshot: async () => Promise.reject(new Error("bug")) },
      { logger },
    );
    await handler({ method: "GET" }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.headers["cache-control"], "no-store");
  });
});

describe("dev server", () => {
  let server;
  let baseUrl;

  before(async () => {
    const roadRisk = createRoadRiskHandler({ getSnapshot: async () => snapshot });
    server = createApp({ roadRisk }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it("serves the page, the modules and both API routes", async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Autonomy Ops · Supervision console<\/title>/);

    const main = await fetch(`${baseUrl}/js/main.js`);
    assert.equal(main.status, 200);
    assert.match(main.headers.get("content-type"), /javascript/);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal((await health.json()).ok, true);

    const risk = await fetch(`${baseUrl}/api/road-risk`);
    assert.equal(risk.headers.get("cache-control"), ROAD_RISK_CACHE_CONTROL);
    assert.deepEqual(await risk.json(), snapshot);
  });
});
