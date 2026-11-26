// Vercel function: GET /api/road-risk. The feed lives in lib/road-risk.js;
// its in-memory cache survives between requests while the instance is warm.

import { createRoadRiskHandler } from "../lib/http.js";
import { createRoadRiskFeed } from "../lib/road-risk.js";

export default createRoadRiskHandler(createRoadRiskFeed());
