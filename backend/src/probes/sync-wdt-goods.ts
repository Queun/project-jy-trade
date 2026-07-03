import { CreateWdtGoodsSyncRunRequestSchema } from "@jy-trade/shared";
import { resolve } from "node:path";

import { createSqliteStore } from "../../../apps/api/src/store.js";
import { loadDotEnv } from "../integrations/env.js";
import { WdtClient, type WdtGoodsResponse } from "../integrations/wdtClient.js";

loadDotEnv();
process.env.DATABASE_MIGRATIONS_FOLDER ??= "apps/api/drizzle";

const mode = process.argv[2];
if (mode !== "full" && mode !== "incremental") {
  throw new Error("Usage: npm run node:wdt:sync-goods -- <full|incremental> [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--page-size 500]");
}

const request = CreateWdtGoodsSyncRunRequestSchema.parse({
  mode,
  ...parseFlags(process.argv.slice(3)),
});
const profile = process.env.WDT_ENV ?? "test";
const client = WdtClient.fromEnvProfile(profile);
const store = createSqliteStore({
  projectRoot: resolve(process.cwd()),
  wdtGoodsClient: {
    async queryGoodsWindow(input) {
      const response = await client.queryGoodsWindow(input.startTime, input.endTime, input.pageNo, input.pageSize);
      assertWdtSuccess(response);
      return {
        totalCount: response.data?.total_count ?? 0,
        goods: response.data?.goods_list ?? [],
      };
    },
  },
});

try {
  const run = await store.runWdtGoodsSync(request);
  console.log(JSON.stringify({ profile, run }, null, 2));
} finally {
  await store.close();
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

function assertWdtSuccess(response: WdtGoodsResponse): void {
  if (response.status && response.status !== 0) {
    throw new Error(`WDT goods query failed: status=${response.status} message=${response.message ?? ""}`);
  }
}
