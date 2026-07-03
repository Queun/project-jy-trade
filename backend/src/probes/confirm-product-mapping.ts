import { ConfirmProductMappingRequestSchema } from "@jy-trade/shared";
import { resolve } from "node:path";

import { createSqliteStore } from "../../../apps/api/src/store.js";
import { loadDotEnv } from "../integrations/env.js";

loadDotEnv();
process.env.DATABASE_MIGRATIONS_FOLDER ??= "apps/api/drizzle";

const request = ConfirmProductMappingRequestSchema.parse(parseFlags(process.argv.slice(2)));
const store = createSqliteStore({ projectRoot: resolve(process.cwd()) });

try {
  const mapping = await store.confirmProductMapping(request);
  console.log(JSON.stringify(mapping, null, 2));
} finally {
  await store.close();
}

function parseFlags(args: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    index += 1;
    if (key === "external-barcode") parsed.externalBarcode = value;
    else if (key === "external-code") parsed.externalGoodsCode = value;
    else if (key === "external-name") parsed.externalGoodsName = value;
    else if (key === "wdt-spec-no") parsed.wdtSpecNo = value;
    else if (key === "source-batch-id") parsed.sourceBatchId = value;
    else if (key === "note") parsed.note = value;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return parsed;
}
