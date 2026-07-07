import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export function resolveProjectRoot(start = process.cwd()): string {
  const initCwd = process.env.INIT_CWD;
  if (initCwd) {
    const initRoot = findWorkspaceRoot(initCwd);
    if (initRoot) return initRoot;
  }
  return findWorkspaceRoot(start) ?? resolve(start);
}

export function normalizeDatabaseUrl(databaseUrl: string, projectRoot = resolveProjectRoot()): string {
  const filePath = sqliteFilePath(databaseUrl, projectRoot);
  return filePath ? `file:${filePath}` : databaseUrl;
}

export function ensureSqliteParentDir(databaseUrl: string): void {
  const filePath = sqliteFilePath(databaseUrl);
  if (!filePath) return;
  mkdirSync(dirname(filePath), { recursive: true });
}

export function resolveRuntimeDir(configuredPath: string | undefined, fallbackPath: string, projectRoot = resolveProjectRoot()): string {
  const trimmed = configuredPath?.trim();
  if (!trimmed) return fallbackPath;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
}

export function ensureRuntimeDir(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function sqliteFilePath(databaseUrl: string, projectRoot = resolveProjectRoot()): string | undefined {
  if (!databaseUrl.startsWith("file:")) return undefined;
  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath || rawPath === ":memory:") return undefined;
  return isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath);
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
