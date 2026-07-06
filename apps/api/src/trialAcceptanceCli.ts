import { resolve } from "node:path";

import { generateTrialAcceptanceReport } from "./trialAcceptanceReport.js";

const args = parseArgs(process.argv.slice(2));

if (!args.batchId || !args.output) {
  throw new Error("Usage: npm run node:trial-acceptance -- --batch-id <batchId> --output outputs/trial-acceptance-real.xlsx [--require-production-api]");
}

const result = await generateTrialAcceptanceReport({
  batchId: args.batchId,
  outputFile: resolve(process.cwd(), args.output),
  requireProductionApi: args.requireProductionApi,
});

console.log(JSON.stringify(result, null, 2));

function parseArgs(argv: string[]) {
  const parsed: { batchId?: string; output?: string; requireProductionApi?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--batch-id") parsed.batchId = argv[++index];
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg === "--require-production-api") parsed.requireProductionApi = true;
  }
  return parsed;
}
