import { createDatabaseContext } from "../../../apps/api/src/db/client.js";
import { wdtSuiteComponents, wdtSuites } from "../../../apps/api/src/db/schema.js";
import { createSuiteSyncRepository, runWdtSuiteSync } from "../../../apps/api/src/wdtSuiteSync.js";
import type { GoodsSyncMode } from "../../../apps/api/src/wdtGoodsSync.js";
import { loadDotEnv } from "../integrations/env.js";
import { WdtClient, type WdtSuiteResponse } from "../integrations/wdtClient.js";

loadDotEnv();
process.env.DATABASE_MIGRATIONS_FOLDER ??= "apps/api/drizzle";

const mode = process.argv[2];
if (mode !== "full" && mode !== "incremental") {
  throw new Error("Usage: npm run node:wdt:sync-suites -- <full|incremental> [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--page-size 500]");
}
const syncMode: GoodsSyncMode = mode;

const request = {
  mode: syncMode,
  ...parseFlags(process.argv.slice(3)),
};
const profile = process.env.WDT_ENV ?? "test";
const client = WdtClient.fromEnvProfile(profile);
const database = createDatabaseContext(process.env.DATABASE_URL, process.env.DATABASE_MIGRATIONS_FOLDER);
const repository = createSuiteSyncRepository(database);

try {
  await database.ready;
  const run = await runWdtSuiteSync(repository, {
    async querySuitesWindow(input) {
      const response = await client.querySuites({
        start_time: input.startTime,
        end_time: input.endTime,
      }, input.pageNo, input.pageSize);
      assertWdtSuccess(response);
      return {
        totalCount: response.data?.total_count ?? 0,
        suites: response.data?.suite_list ?? [],
      };
    },
  }, request);
  const counts = await readSuiteCounts();
  console.log(JSON.stringify({ profile, run, counts }, null, 2));
} finally {
  await database.close();
}

async function readSuiteCounts() {
  const suiteRows = await database.db.select().from(wdtSuites);
  const componentRows = await database.db.select().from(wdtSuiteComponents);
  return {
    suites: suiteRows.length,
    components: componentRows.length,
    examples: suiteRows.slice(0, 5).map((row) => ({
      suiteNo: row.suiteNo,
      suiteName: row.suiteName,
      barcode: row.barcode,
    })),
  };
}

function parseFlags(args: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  const normalizedArgs = args.filter((arg) => arg !== "--");
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = normalizedArgs[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    index += 1;
    if (key === "start-date") parsed.startDate = value;
    else if (key === "end-date") parsed.endDate = value;
    else if (key === "page-size") parsed.pageSize = Number(value);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return parsed;
}

function assertWdtSuccess(response: WdtSuiteResponse): void {
  if (response.status && response.status !== 0) {
    throw new Error(`WDT suite query failed: status=${response.status} message=${response.message ?? ""}`);
  }
}
