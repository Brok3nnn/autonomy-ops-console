// Road-risk feed shared by the Vercel function (api/road-risk.js) and the
// Express dev server. It turns two public sources into 0-100 scores:
//
//   weather    Open-Meteo current conditions in six Austrian cities
//   news       GDELT article list for Austrian road and traffic news
//   incidents  the same GDELT articles, counted for incident keywords
//
// Each provider is cached in memory with its own refresh interval, backs off
// after failures (honouring 429 and Retry-After), and keeps its last good
// value for a while. A snapshot never waits longer than one upstream timeout,
// and reports per provider whether its value is live, cached or unavailable.

/** Cities sampled for weather, as [name, latitude, longitude]. */
export const WEATHER_LOCATIONS = [
  ["Vienna", 48.2082, 16.3738],
  ["Graz", 47.0707, 15.4395],
  ["Salzburg", 47.8095, 13.055],
  ["Innsbruck", 47.2692, 11.4041],
  ["Klagenfurt", 46.6247, 14.3053],
  ["Linz", 48.3069, 14.2858],
];

export const OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast" +
  `?latitude=${WEATHER_LOCATIONS.map(([, lat]) => lat).join(",")}` +
  `&longitude=${WEATHER_LOCATIONS.map(([, , lng]) => lng).join(",")}` +
  "&current=temperature_2m,precipitation,rain,snowfall,wind_speed_10m,weather_code";

export const GDELT_QUERY = "austria (traffic OR road OR accident OR closure OR weather)";
export const GDELT_URL =
  "https://api.gdeltproject.org/api/v2/doc/doc" +
  `?query=${encodeURIComponent(GDELT_QUERY)}&mode=ArtList&maxrecords=50&format=json`;

const USER_AGENT = "autonomy-ops-console/1.0 (+https://github.com/Brok3nnn/autonomy-ops-console)";

export const DEFAULT_OPTIONS = {
  /** Per-request upstream timeout. Both providers run in parallel. */
  timeoutMs: 2500,
  /** A value younger than its provider's TTL is served without a request. */
  weatherTtlMs: 10 * 60 * 1000,
  newsTtlMs: 15 * 60 * 1000,
  /** After this, a last good value is dropped and the provider is "unavailable". */
  maxStaleMs: 6 * 60 * 60 * 1000,
  /** Backoff after consecutive failures: base * 2^(failures - 1), capped. */
  backoffBaseMs: 60 * 1000,
  backoffMaxMs: 30 * 60 * 1000,
};

/** Longest Retry-After we honour, so a bogus header cannot disable a provider for days. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A failed upstream call. `code` is part of the API response. */
export class ProviderError extends Error {
  /**
   * @param {"timeout" | "network-error" | "rate-limited" | "invalid-response" | `http-${number}`} code
   * @param {{ retryAfterMs?: number | null, cause?: unknown }} [details]
   */
  constructor(code, { retryAfterMs = null, cause } = {}) {
    super(code, { cause });
    this.name = "ProviderError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

/**
 * Risk points for a WMO weather code as used by Open-Meteo.
 * Unknown or missing codes count as mildly risky.
 */
export function weatherCodeRisk(code) {
  if (code === null || code === undefined || code === "") return 8;
  const value = Number(code);
  if (Number.isNaN(value)) return 8;
  if (value === 0) return 0; // clear sky
  if ([1, 2].includes(value)) return 5; // mainly clear, partly cloudy
  if ([3, 45, 48].includes(value)) return 12; // overcast, fog
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(value)) return 18; // drizzle, rain, showers
  if ([56, 57, 66, 67].includes(value)) return 28; // freezing drizzle and rain
  if ([71, 73, 75, 77, 85, 86].includes(value)) return 32; // snow
  if ([95, 96, 99].includes(value)) return 40; // thunderstorm
  return 10;
}

/** 0-100 risk for one location's `current` block. */
export function scoreWeatherSample(current = {}) {
  const wind = toNumber(current.wind_speed_10m); // km/h
  const precipitation = toNumber(current.precipitation); // mm
  const rain = toNumber(current.rain); // mm
  const snowfall = toNumber(current.snowfall); // cm
  const temperature = toNumber(current.temperature_2m); // °C

  const windRisk = clamp((wind - 18) * 2.1, 0, 36);
  const wetRisk = clamp((precipitation + rain * 0.9 + snowfall * 1.3) * 12, 0, 36);
  let temperatureRisk = 0;
  if (temperature <= -7) temperatureRisk = 18;
  else if (temperature <= -1) temperatureRisk = 10;
  else if (temperature >= 35) temperatureRisk = 16;
  else if (temperature >= 30) temperatureRisk = 10;

  return clamp(
    8 + windRisk + wetRisk + temperatureRisk + weatherCodeRisk(current.weather_code),
    0,
    100,
  );
}

/**
 * Average risk over all locations in an Open-Meteo response (an array for
 * several locations, an object for one).
 */
export function scoreWeather(payload) {
  const samples = (Array.isArray(payload) ? payload : [payload]).filter(
    (sample) => sample?.current,
  );
  if (samples.length === 0) throw new ProviderError("invalid-response");
  const total = samples.reduce((sum, sample) => sum + scoreWeatherSample(sample.current), 0);
  return Math.round(total / samples.length);
}

/** GDELT "seendate" (e.g. 20261126T091500Z) to epoch ms, or null. */
export function parseGdeltTimestamp(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value ?? ""));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/**
 * Articles from a GDELT DOC API response body. GDELT sometimes answers a
 * rate limit with HTTP 200 and a plain-text notice, and an empty result with
 * `{}`, so the body is checked before parsing.
 */
export function parseGdeltArticles(text) {
  if (/please limit requests/i.test(text)) throw new ProviderError("rate-limited");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new ProviderError("invalid-response", { cause: error });
  }
  if (payload === null || typeof payload !== "object") throw new ProviderError("invalid-response");
  return Array.isArray(payload.articles) ? payload.articles : [];
}

// German terms are deliberate: many Austrian outlets publish in German.
const INCIDENT_KEYWORDS = [
  "accident",
  "crash",
  "collision",
  "closure",
  "blocked",
  "flood",
  "snow",
  "storm",
  "fire",
  "jam",
  "unfall",
  "sperre",
];
const WEATHER_KEYWORDS = ["weather", "rain", "snow", "storm", "wind", "fog", "ice", "wetter"];
const RECENT_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * News and incident scores from GDELT article titles: article volume,
 * articles seen in the last 72 hours, and weather / incident keywords.
 */
export function scoreGdeltArticles(articles, nowMs) {
  if (articles.length === 0) return { news: 16, incidents: 12 };

  let incidentMentions = 0;
  let weatherMentions = 0;
  let recentMentions = 0;
  for (const article of articles) {
    const title = String(article?.title ?? "").toLowerCase();
    if (INCIDENT_KEYWORDS.some((keyword) => title.includes(keyword))) incidentMentions += 1;
    if (WEATHER_KEYWORDS.some((keyword) => title.includes(keyword))) weatherMentions += 1;
    const seenAt = parseGdeltTimestamp(article?.seendate);
    if (seenAt !== null && seenAt >= nowMs - RECENT_WINDOW_MS) recentMentions += 1;
  }

  return {
    news: Math.round(
      clamp(12 + articles.length * 0.9 + recentMentions * 1.2 + weatherMentions * 1.5, 8, 95),
    ),
    incidents: Math.round(clamp(10 + incidentMentions * 3 + recentMentions * 1.4, 8, 98)),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Null if absent or invalid. */
export function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = String(value).trim();
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - nowMs;
  if (!Number.isFinite(ms)) return null;
  return clamp(ms, 0, MAX_RETRY_AFTER_MS);
}

/**
 * GET a URL and read the body as text within one timeout. Maps every failure
 * to a ProviderError; 429 and 503 carry their Retry-After.
 */
export async function requestText(fetchImpl, url, { timeoutMs, nowMs }) {
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new ProviderError(isTimeout ? "timeout" : "network-error", { cause: error });
  }

  if (response.ok) return text;
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  if (response.status === 429) throw new ProviderError("rate-limited", { retryAfterMs });
  throw new ProviderError(`http-${response.status}`, {
    retryAfterMs: response.status === 503 ? retryAfterMs : null,
  });
}

// ---------------------------------------------------------------------------
// Providers and cache
// ---------------------------------------------------------------------------

/** Delay before the next attempt after `failures` consecutive failures. */
export function backoffDelayMs(failures, { backoffBaseMs, backoffMaxMs }) {
  return Math.min(backoffBaseMs * 2 ** Math.max(0, failures - 1), backoffMaxMs);
}

const PROVIDERS = {
  openMeteo: {
    name: "Open-Meteo",
    ttlOption: "weatherTtlMs",
    async load(context) {
      const text = await requestText(context.fetch, OPEN_METEO_URL, context);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new ProviderError("invalid-response", { cause: error });
      }
      return { weather: scoreWeather(payload) };
    },
  },
  gdelt: {
    name: "GDELT",
    ttlOption: "newsTtlMs",
    async load(context) {
      const text = await requestText(context.fetch, GDELT_URL, context);
      return scoreGdeltArticles(parseGdeltArticles(text), context.nowMs);
    },
  },
};

/** Which provider and which field of its value each signal comes from. */
const SIGNALS = {
  weather: "openMeteo",
  news: "gdelt",
  incidents: "gdelt",
};

function toIso(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Creates an independent feed with its own cache. Tests inject `fetch` and
 * `now`; production uses the defaults.
 *
 * @param {{ fetch?: typeof fetch, now?: () => number } & Partial<typeof DEFAULT_OPTIONS>} [config]
 */
export function createRoadRiskFeed({
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  ...overrides
} = {}) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const entries = Object.fromEntries(
    Object.keys(PROVIDERS).map((id) => [
      id,
      {
        value: null,
        updatedAt: null,
        checkedAt: null,
        error: null,
        failures: 0,
        retryAt: null,
        inFlight: null,
      },
    ]),
  );

  function hasUsableValue(entry, nowMs) {
    return entry.value !== null && nowMs - entry.updatedAt <= options.maxStaleMs;
  }

  async function refresh(id) {
    const provider = PROVIDERS[id];
    const entry = entries[id];
    const nowMs = now();
    const isFresh = entry.value !== null && nowMs - entry.updatedAt < options[provider.ttlOption];
    const isBackingOff = entry.retryAt !== null && nowMs < entry.retryAt;
    if (isFresh || isBackingOff) return;

    // Concurrent snapshots share one upstream request per provider.
    entry.inFlight ??= (async () => {
      entry.checkedAt = now();
      try {
        entry.value = await provider.load({
          fetch: fetchImpl,
          timeoutMs: options.timeoutMs,
          nowMs: now(),
        });
        entry.updatedAt = now();
        entry.error = null;
        entry.failures = 0;
        entry.retryAt = null;
      } catch (error) {
        const failure =
          error instanceof ProviderError
            ? error
            : new ProviderError("invalid-response", { cause: error });
        entry.error = failure.code;
        entry.failures += 1;
        entry.retryAt =
          now() + Math.max(backoffDelayMs(entry.failures, options), failure.retryAfterMs ?? 0);
      } finally {
        entry.inFlight = null;
      }
    })();
    await entry.inFlight;
  }

  function describe(id, nowMs) {
    const provider = PROVIDERS[id];
    const entry = entries[id];
    const usable = hasUsableValue(entry, nowMs);
    let status = "unavailable";
    if (usable) status = nowMs - entry.updatedAt < options[provider.ttlOption] ? "live" : "cached";
    return {
      name: provider.name,
      status,
      updatedAt: usable ? toIso(entry.updatedAt) : null,
      checkedAt: toIso(entry.checkedAt),
      retryAt: entry.retryAt !== null && entry.retryAt > nowMs ? toIso(entry.retryAt) : null,
      error: entry.error,
    };
  }

  /**
   * Refreshes whatever is due (in parallel, each bounded by the timeout) and
   * returns the API payload.
   */
  async function getSnapshot() {
    await Promise.all(Object.keys(PROVIDERS).map((id) => refresh(id)));
    const nowMs = now();

    const providers = Object.fromEntries(
      Object.keys(PROVIDERS).map((id) => [id, describe(id, nowMs)]),
    );
    const signals = Object.fromEntries(
      Object.entries(SIGNALS).map(([signal, id]) => {
        const entry = entries[id];
        const score = hasUsableValue(entry, nowMs) ? entry.value[signal] : null;
        return [signal, { score, provider: id }];
      }),
    );
    return { generatedAt: toIso(nowMs), signals, providers };
  }

  return { getSnapshot };
}
