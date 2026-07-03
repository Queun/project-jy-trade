import { defineConfig } from "drizzle-kit";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const projectRoot = resolveProjectRoot();

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: normalizeDatabaseUrl(process.env.DATABASE_URL ?? `file:${resolve(projectRoot, "data/jy-trade-dev.db")}`, projectRoot),
  },
});

function resolveProjectRoot() {
  const initCwd = process.env.INIT_CWD;
  if (initCwd) {
    const initRoot = findWorkspaceRoot(initCwd);
    if (initRoot) return initRoot;
  }
  return findWorkspaceRoot(process.cwd()) ?? process.cwd();
}

function findWorkspaceRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const packageJson = resolve(current, "package.json");
    if (existsSync(packageJson) && hasWorkspaces(packageJson)) return current;
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}

function hasWorkspaces(packageJson: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces);
  } catch {
    return false;
  }
}

function normalizeDatabaseUrl(databaseUrl: string, root: string): string {
  if (!databaseUrl.startsWith("file:")) return databaseUrl;
  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath || rawPath === ":memory:") return databaseUrl;
  return `file:${isAbsolute(rawPath) ? rawPath : resolve(root, rawPath)}`;
}
