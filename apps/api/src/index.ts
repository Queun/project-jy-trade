import { buildApiServer } from "./server.js";
import { loadDotEnv } from "../../../backend/src/integrations/env.js";
import { resolve } from "node:path";

loadDotEnv();
loadDotEnv(resolve(process.cwd(), "../../.env"));
const port = Number(process.env.API_PORT ?? 3001);
const server = buildApiServer();
let shuttingDown = false;

async function shutdown(signal: "SIGINT" | "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  server.log.info({ signal }, "API shutdown requested");
  try {
    await server.close();
  } catch (error) {
    server.log.error(error, "API shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.listen({ port, host: "0.0.0.0" });
  server.log.info(`API listening on http://localhost:${port}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
