import { defineConfig } from "drizzle-kit";
import { resolve } from "node:path";

import { ensureSqliteParentDir, normalizeDatabaseUrl, resolveProjectRoot } from "./src/runtimePaths";

const projectRoot = resolveProjectRoot();
const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL ?? `file:${resolve(projectRoot, "data/jy-trade-dev.db")}`, projectRoot);
ensureSqliteParentDir(databaseUrl);

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: databaseUrl,
  },
});
