import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GDELT_URL,
  OPEN_METEO_URL,
  ProviderError,
  backoffDelayMs,
  createRoadRiskFeed,
  parseGdeltArticles,
  parseGdeltTimestamp,
  parseRetryAfter,
  scoreGdeltArticles,
  scoreWeather,
  scoreWeatherSample,
  weatherCodeRisk,
} from "../lib/road-risk.js";

const MINUTE = 60 * 1000;
const NOW = Date.UTC(2026, 10, 26, 9, 0, 0);

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

const calmWeather = [{ current: { temperature_2m: 12, wind_speed_10m: 5, weather_code: 0 } }];
const gdeltBody = {
  articles: [
    { title: "Unfall auf der A1 bei Linz", seendate: "20261126T080000Z" },
    { title: "Snow storm closes Austrian pass", seendate: "20261120T080000Z" },
  ],
};

/** Fake upstream: routes by URL, counts calls, returns queued responses. */
function fakeUpstream({
  weather = () => jsonResponse(calmWeather),
  news = () => jsonResponse(gdeltBody),
} = {}) {
  const calls = { weather: 0, news: 0 };
  const fetch = async (url) => {
    if (url === OPEN_METEO_URL) {
      calls.weather += 1;
      return weather(calls.weather);
    }
    if (url === GDELT_URL) {
      calls.news += 1;
      return news(calls.news);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetch, calls };
}

function fakeClock(start = NOW) {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

describe("weatherCodeRisk", () => {
  it("maps WMO weather codes to risk points", () => {
    assert.equal(weatherCodeRisk(0), 0);
    assert.equal(weatherCodeRisk(2), 5);
    assert.equal(weatherCodeRisk(45), 12);
    assert.equal(weatherCodeRisk(63), 18);
    assert.equal(weatherCodeRisk(66), 28);
    assert.equal(weatherCodeRisk(75), 32);
    assert.equal(weatherCodeRisk(95), 40);
  });

  it("treats missing codes as unknown, not as clear sky", () => {
    assert.equal(weatherCodeRisk(undefined), 8);
    assert.equal(weatherCodeRisk(null), 8);
    assert.equal(weatherCodeRisk("not-a-code"), 8);
    assert.equal(weatherCodeRisk(7), 10);
  });
});

describe("weather scoring", () => {
  it("scores calm weather at the 8-point baseline", () => {
    assert.equal(scoreWeatherSample({ temperature_2m: 12, wind_speed_10m: 5, weather_code: 0 }), 8);
  });

  it("adds wind, precipitation, temperature and code risk, capped at 100", () => {
    // wind (40-18)*2.1=46.2 -> 36, wet (1+0.9)*12=22.8, frost 10, rain code 18
    const score = scoreWeatherSample({
      wind_speed_10m: 40,
      precipitation: 1,
      rain: 1,
      temperature_2m: -3,
      weather_code: 61,
    });
    assert.equal(Math.round(score * 10) / 10, 94.8);
    assert.equal(
      scoreWeatherSample({
        wind_speed_10m: 200,
        snowfall: 50,
        temperature_2m: -20,
        weather_code: 99,
      }),
      100,
    );
  });

  it("averages all locations and accepts a single-location object", () => {
    const payload = [{ current: { weather_code: 0 } }, { current: { weather_code: 95 } }];
    assert.equal(scoreWeather(payload), Math.round((8 + 48) / 2));
    assert.equal(scoreWeather({ current: { weather_code: 0 } }), 8);
  });

  it("rejects a response without current conditions", () => {
    assert.throws(
      () => scoreWeather({ error: true }),
      (error) => error.code === "invalid-response",
    );
  });
});

describe("GDELT parsing", () => {
  it("parses seendate timestamps", () => {
    assert.equal(parseGdeltTimestamp("20261126T091500Z"), Date.UTC(2026, 10, 26, 9, 15, 0));
    assert.equal(parseGdeltTimestamp("2026-11-26"), null);
    assert.equal(parseGdeltTimestamp(undefined), null);
  });

  it("returns the article list, or an empty list for {}", () => {
    assert.equal(parseGdeltArticles(JSON.stringify(gdeltBody)).length, 2);
    assert.deepEqual(parseGdeltArticles("{}"), []);
  });

  it("recognises the plain-text rate-limit notice", () => {
    assert.throws(
      () => parseGdeltArticles("Please limit requests to one every 5 seconds."),
      (error) => error instanceof ProviderError && error.code === "rate-limited",
    );
  });

  it("rejects bodies that are not JSON objects", () => {
    assert.throws(
      () => parseGdeltArticles("<html>error</html>"),
      (error) => error.code === "invalid-response",
    );
    assert.throws(
      () => parseGdeltArticles("null"),
      (error) => error.code === "invalid-response",
    );
  });

  it("scores volume, recency and keywords", () => {
    // 2 articles, 1 within 72 h, 1 weather keyword (snow/storm), 2 incident keywords (unfall, snow/storm)
    assert.deepEqual(scoreGdeltArticles(gdeltBody.articles, NOW), {
      news: Math.round(12 + 2 * 0.9 + 1 * 1.2 + 1 * 1.5),
      incidents: Math.round(10 + 2 * 3 + 1 * 1.4),
    });
    assert.deepEqual(scoreGdeltArticles([], NOW), { news: 16, incidents: 12 });
  });
});

describe("Retry-After and backoff", () => {
  it("parses delta seconds and HTTP dates", () => {
    assert.equal(parseRetryAfter("120", NOW), 120000);
    assert.equal(parseRetryAfter(new Date(NOW + 90000).toUTCString(), NOW), 90000);
    assert.equal(parseRetryAfter("soon", NOW), null);
    assert.equal(parseRetryAfter(null, NOW), null);
    assert.equal(parseRetryAfter("999999999", NOW), 24 * 60 * MINUTE);
  });

  it("doubles the delay per failure up to the cap", () => {
    const options = { backoffBaseMs: MINUTE, backoffMaxMs: 30 * MINUTE };
    assert.deepEqual(
      [1, 2, 3, 6, 10].map((failures) => backoffDelayMs(failures, options)),
      [MINUTE, 2 * MINUTE, 4 * MINUTE, 30 * MINUTE, 30 * MINUTE],
    );
  });
});

describe("createRoadRiskFeed", () => {
  it("reports live scores and their providers", async () => {
    const clock = fakeClock();
    const upstream = fakeUpstream();
    const snapshot = await createRoadRiskFeed({
      fetch: upstream.fetch,
      now: clock.now,
    }).getSnapshot();

    assert.equal(snapshot.generatedAt, new Date(NOW).toISOString());
    assert.deepEqual(snapshot.signals.weather, { score: 8, provider: "openMeteo" });
    assert.equal(snapshot.signals.news.provider, "gdelt");
    assert.equal(typeof snapshot.signals.incidents.score, "number");
    assert.equal(snapshot.providers.openMeteo.status, "live");
    assert.equal(snapshot.providers.gdelt.status, "live");
    assert.equal(snapshot.providers.gdelt.error, null);
  });

  it("serves cached values without calling upstream within the TTL", async () => {
    const clock = fakeClock();
    const upstream = fakeUpstream();
    const feed = createRoadRiskFeed({ fetch: upstream.fetch, now: clock.now });
    await feed.getSnapshot();
    clock.advance(5 * MINUTE);
    await feed.getSnapshot();
    assert.deepEqual(upstream.calls, { weather: 1, news: 1 });

    clock.advance(6 * MINUTE); // weather TTL (10 min) expired, news TTL (15 min) not yet
    await feed.getSnapshot();
    assert.deepEqual(upstream.calls, { weather: 2, news: 1 });
  });

  it("honours 429 + Retry-After and does not call upstream while backing off", async () => {
    const clock = fakeClock();
    const upstream = fakeUpstream({
      news: () =>
        jsonResponse("Please limit requests", { status: 429, headers: { "Retry-After": "600" } }),
    });
    const feed = createRoadRiskFeed({ fetch: upstream.fetch, now: clock.now });

    const first = await feed.getSnapshot();
    assert.equal(first.providers.gdelt.status, "unavailable");
    assert.equal(first.providers.gdelt.error, "rate-limited");
    assert.equal(first.providers.gdelt.retryAt, new Date(NOW + 10 * MINUTE).toISOString());
    assert.equal(first.signals.news.score, null);
    assert.equal(first.signals.incidents.score, null);
    assert.equal(first.providers.openMeteo.status, "live");

    clock.advance(9 * MINUTE);
    await feed.getSnapshot();
    assert.equal(upstream.calls.news, 1);

    clock.advance(2 * MINUTE);
    await feed.getSnapshot();
    assert.equal(upstream.calls.news, 2);
  });

  it("keeps the last good value as cached when a refresh fails", async () => {
    const clock = fakeClock();
    const upstream = fakeUpstream({
      weather: (call) =>
        call === 1 ? jsonResponse(calmWeather) : jsonResponse({}, { status: 503 }),
    });
    const feed = createRoadRiskFeed({ fetch: upstream.fetch, now: clock.now });
    await feed.getSnapshot();

    clock.advance(11 * MINUTE);
    const snapshot = await feed.getSnapshot();
    assert.equal(snapshot.providers.openMeteo.status, "cached");
    assert.equal(snapshot.providers.openMeteo.error, "http-503");
    assert.equal(snapshot.providers.openMeteo.updatedAt, new Date(NOW).toISOString());
    assert.equal(snapshot.signals.weather.score, 8);
    assert.equal(snapshot.providers.openMeteo.retryAt, new Date(NOW + 12 * MINUTE).toISOString());
  });

  it("drops a value that is older than maxStaleMs", async () => {
    const clock = fakeClock();
    const upstream = fakeUpstream({
      weather: (call) =>
        call === 1 ? jsonResponse(calmWeather) : Promise.reject(new TypeError("fetch failed")),
    });
    const feed = createRoadRiskFeed({
      fetch: upstream.fetch,
      now: clock.now,
      maxStaleMs: 60 * MINUTE,
    });
    await feed.getSnapshot();

    clock.advance(61 * MINUTE);
    const snapshot = await feed.getSnapshot();
    assert.equal(snapshot.providers.openMeteo.status, "unavailable");
    assert.equal(snapshot.providers.openMeteo.error, "network-error");
    assert.equal(snapshot.signals.weather.score, null);
  });

  it("shares one upstream request between concurrent snapshots", async () => {
    const upstream = fakeUpstream();
    const feed = createRoadRiskFeed({ fetch: upstream.fetch, now: fakeClock().now });
    await Promise.all([feed.getSnapshot(), feed.getSnapshot(), feed.getSnapshot()]);
    assert.deepEqual(upstream.calls, { weather: 1, news: 1 });
  });

  it("answers within the timeout when an upstream hangs", async (t) => {
    // AbortSignal.timeout() does not keep the event loop alive; without this
    // timer Node 22 cancels the test before the signal fires.
    const keepAlive = setTimeout(() => {}, 5000);
    t.after(() => clearTimeout(keepAlive));
    const hang = (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    const feed = createRoadRiskFeed({
      fetch: (url, init) =>
        url === GDELT_URL ? hang(url, init) : Promise.resolve(jsonResponse(calmWeather)),
      timeoutMs: 50,
    });

    const started = performance.now();
    const snapshot = await feed.getSnapshot();
    assert.ok(performance.now() - started < 1000);
    assert.equal(snapshot.providers.gdelt.status, "unavailable");
    assert.equal(snapshot.providers.gdelt.error, "timeout");
    assert.equal(snapshot.providers.openMeteo.status, "live");
  });
});
