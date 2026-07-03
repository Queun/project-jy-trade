import { loadDotEnv } from "../integrations/env.js";
import { WdtClient } from "../integrations/wdtClient.js";
import { readFileSync } from "node:fs";

loadDotEnv();

const target = process.argv[2];
const value = process.argv[3];
const warehouseNo = process.argv[4];
const profile = process.env.WDT_ENV ?? "test";

if (!target) {
  throw new Error("Usage: tsx backend/src/probes/wdt-api.ts <warehouse|goods|stock> [value] [warehouseNo]");
}

const client = WdtClient.fromEnvProfile(profile);

let result: unknown;
if (target === "debug") {
  result = {
    profile,
    ...client.getDebugInfo(),
  };
} else if (target === "warehouse") {
  result = await client.queryWarehouse(value);
} else if (target === "goods") {
  if (!value) throw new Error("goods requires barcode");
  result = await client.queryGoodsByBarcode(value);
} else if (target === "stock") {
  if (!value) throw new Error("stock requires specNo");
  result = await client.queryStock(value, warehouseNo);
} else if (target === "call") {
  if (!value) throw new Error("call requires method");
  assertReadOnlyCall(value);
  const params = parseParams(process.argv.slice(4));
  result = await client.call(value, params);
} else {
  throw new Error(`Unknown target: ${target}`);
}

console.log(JSON.stringify(result, null, 2));

function parseParams(args: string[]): Record<string, unknown> {
  if (args.length === 0) return {};
  const [first, ...rest] = args;
  if (first?.startsWith("@")) {
    return JSON.parse(readFileSync(first.slice(1), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  }
  if (rest.length === 0 && first?.trim().startsWith("{")) {
    return JSON.parse(first) as Record<string, unknown>;
  }
  return Object.fromEntries(args.map((arg) => parseKeyValue(arg)));
}

function parseKeyValue(value: string): [string, unknown] {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error(`Expected key=value param, got: ${value}`);
  const key = value.slice(0, separator);
  const raw = value.slice(separator + 1);
  if (isListParam(key)) return [key, raw.split(",").map((item) => item.trim()).filter(Boolean)];
  if (raw === "true") return [key, true];
  if (raw === "false") return [key, false];
  return [key, raw];
}

function isListParam(key: string): boolean {
  return key === "spec_nos";
}

function assertReadOnlyCall(method: string): void {
  if (!isProductionProfile()) return;
  if (/(push|upload|create|update|delete|import|syncbypd)/i.test(method)) {
    throw new Error(`Refusing to call write-like WDT method in production profile: ${method}`);
  }
}

function isProductionProfile(): boolean {
  return profile === "prod" || profile === "production";
}
