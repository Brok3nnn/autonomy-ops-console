// HTTP handlers shared by the Vercel functions in api/ and the Express dev
// server. They only use Node's core request/response API, so the same code
// runs in both environments.

/** Lets Vercel's CDN serve one response for 10 minutes, then revalidate in the background. */
export const ROAD_RISK_CACHE_CONTROL = "public, s-maxage=600, stale-while-revalidate=3600";

export function sendJson(res, statusCode, body, headers = {}) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

export function healthHandler(_req, res) {
  sendJson(res, 200, { ok: true, now: new Date().toISOString() }, { "Cache-Control": "no-store" });
}

/**
 * GET /api/road-risk for a feed from lib/road-risk.js. Upstream problems are
 * part of a normal 200 payload; a 500 means a bug in this code.
 *
 * @param {{ getSnapshot: () => Promise<object> }} feed
 * @param {{ logger?: Pick<Console, "error"> }} [options]
 */
export function createRoadRiskHandler(feed, { logger = console } = {}) {
  return async function roadRiskHandler(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(
        res,
        405,
        { error: "method-not-allowed" },
        { Allow: "GET, HEAD", "Cache-Control": "no-store" },
      );
      return;
    }
    try {
      sendJson(res, 200, await feed.getSnapshot(), { "Cache-Control": ROAD_RISK_CACHE_CONTROL });
    } catch (error) {
      logger.error("road-risk: snapshot failed", error);
      sendJson(res, 500, { error: "internal-error" }, { "Cache-Control": "no-store" });
    }
  };
}
