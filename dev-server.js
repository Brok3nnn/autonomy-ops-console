// Local server: serves public/ and mounts the same handlers that Vercel
// deploys from api/. Not used in production on Vercel.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import healthHandler from "./api/health.js";
import roadRiskHandler from "./api/road-risk.js";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

/** @param {{ health?: Function, roadRisk?: Function }} [handlers] injectable for tests */
export function createApp({ health = healthHandler, roadRisk = roadRiskHandler } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.all("/api/health", health);
  app.all("/api/road-risk", roadRisk);
  app.use(express.static(PUBLIC_DIR));
  return app;
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp().listen(port, () => {
    console.log(`Autonomy Ops console running on http://localhost:${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
