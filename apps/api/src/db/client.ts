import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import * as schema from "./schema.js";

const defaultMigrationsFolder = "drizzle";

export function createDatabaseContext(
  databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl(),
  migrationsFolder = process.env.DATABASE_MIGRATIONS_FOLDER ?? defaultMigrationsFolder,
) {
  ensureSqliteParentDir(databaseUrl);
  const client = createClient({ url: databaseUrl });
  const db = drizzle(client, { schema });
  const ready = migrate(db, { migrationsFolder: resolve(process.cwd(), migrationsFolder) });

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
  if (initCwd && existsSync(resolve(initCwd, "package.json"))) return initCwd;
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "package.json"))) return cwd;
  const twoUp = resolve(cwd, "../..");
  if (existsSync(resolve(twoUp, "package.json"))) return twoUp;
  return cwd;
}

function ensureSqliteParentDir(databaseUrl: string) {
  const filePath = sqliteFilePath(databaseUrl);
  if (!filePath) return;
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function sqliteFilePath(databaseUrl: string): string | undefined {
  if (!databaseUrl.startsWith("file:")) return undefined;
  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath || rawPath === ":memory:") return undefined;
  return isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
}

export type SqliteClient = Client;
