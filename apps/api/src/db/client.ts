import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import * as schema from "./schema.js";

const defaultMigrationsFolder = "drizzle";

export function createDatabaseContext(
  databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl(),
  migrationsFolder = process.env.DATABASE_MIGRATIONS_FOLDER ?? defaultMigrationsFolder,
) {
  const projectRoot = resolveProjectRoot();
  const normalizedDatabaseUrl = normalizeDatabaseUrl(databaseUrl, projectRoot);
  ensureSqliteParentDir(normalizedDatabaseUrl);
  const client = createClient({ url: normalizedDatabaseUrl });
  const db = drizzle(client, { schema });
  const ready = migrate(db, { migrationsFolder: resolveMigrationsFolder(migrationsFolder, projectRoot) });

  return {
    db,
    client,
    ready,
    async close() {
      await Promise.resolve(client.close());
    },
  };
}

export type DatabaseContext = ReturnType<typeof createDatabaseContext>;

function defaultDatabaseUrl() {
  return `file:${resolve(resolveProjectRoot(), "data/jy-trade-dev.db")}`;
}

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

function ensureSqliteParentDir(databaseUrl: string) {
  const filePath = sqliteFilePath(databaseUrl);
  if (!filePath) return;
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function normalizeDatabaseUrl(databaseUrl: string, projectRoot: string): string {
  const filePath = sqliteFilePath(databaseUrl, projectRoot);
  return filePath ? `file:${filePath}` : databaseUrl;
}

function sqliteFilePath(databaseUrl: string, projectRoot = resolveProjectRoot()): string | undefined {
  if (!databaseUrl.startsWith("file:")) return undefined;
  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath || rawPath === ":memory:") return undefined;
  return isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath);
}

function resolveMigrationsFolder(migrationsFolder: string, projectRoot: string): string {
  if (isAbsolute(migrationsFolder)) return migrationsFolder;
  const apiWorkspaceFolder = resolve(projectRoot, "apps/api", migrationsFolder);
  if (existsSync(apiWorkspaceFolder)) return apiWorkspaceFolder;
  return resolve(projectRoot, migrationsFolder);
}

export type SqliteClient = Client;
