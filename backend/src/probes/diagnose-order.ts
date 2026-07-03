import { resolve } from "node:path";

import { diagnoseOrderWithDatabase } from "../flows/diagnoseOrder.js";
import { loadDotEnv } from "../integrations/env.js";
import { WdtClient } from "../integrations/wdtClient.js";

loadDotEnv();
process.env.DATABASE_MIGRATIONS_FOLDER ??= "apps/api/drizzle";

const orderFile = process.argv[2];
const outputFile = process.argv[3];
const allowStaleCache = process.argv.slice(4).includes("--allow-stale-cache");

if (!orderFile || !outputFile) {
  throw new Error('Usage: npm run node:diagnose-order -- "<order-file.xls>" outputs\\order-match-diagnosis.xlsx');
}

const profile = process.env.WDT_ENV ?? "test";
const client = WdtClient.fromEnvProfile(profile);

const result = await diagnoseOrderWithDatabase(client, {
  orderFile: resolve(process.cwd(), orderFile),
  outputFile: resolve(process.cwd(), outputFile),
  migrationsFolder: "apps/api/drizzle",
  allowStaleCache,
});

console.log(JSON.stringify({ profile, ...result }, null, 2));
