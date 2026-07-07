import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import * as schema from "./schema.js";
import { ensureSqliteParentDir, normalizeDatabaseUrl, resolveProjectRoot } from "../runtimePaths.js";

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

function resolveMigrationsFolder(migrationsFolder: string, projectRoot: string): string {
  if (isAbsolute(migrationsFolder)) return migrationsFolder;
  const apiWorkspaceFolder = resolve(projectRoot, "apps/api", migrationsFolder);
  if (existsSync(apiWorkspaceFolder)) return apiWorkspaceFolder;
  return resolve(projectRoot, migrationsFolder);
}

export type SqliteClient = Client;
