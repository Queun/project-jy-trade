import { buildApiServer } from "./server.js";
import { loadDotEnv } from "../../../backend/src/integrations/env.js";

loadDotEnv();
const port = Number(process.env.API_PORT ?? 3001);
const server = buildApiServer();

try {
  await server.listen({ port, host: "0.0.0.0" });
  server.log.info(`API listening on http://localhost:${port}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
