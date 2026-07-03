import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolveProjectRoot();

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? resolve(projectRoot, "data/jy-trade-dev.db"),
  },
});

function resolveProjectRoot() {
  const initCwd = process.env.INIT_CWD;
  if (initCwd && existsSync(resolve(initCwd, "package.json"))) return initCwd;
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "package.json"))) return cwd;
  const twoUp = resolve(cwd, "../..");
  if (existsSync(resolve(twoUp, "package.json"))) return twoUp;
  return cwd;
}
