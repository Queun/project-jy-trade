import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { loadDotEnv } from "../integrations/env.js";
import { WdtClient } from "../integrations/wdtClient.js";

type ProbeMode = "read" | "all";
type ApiRisk = "read" | "write";

interface ProbeDefinition {
  category: string;
  pageName: string;
  method: string;
  risk: ApiRisk;
  purpose: string;
  pagination?: boolean;
  buildParams: (env: NodeJS.ProcessEnv) => Record<string, unknown>;
}

interface ProbeResult {
  category: string;
  pageName: string;
  method: string;
  risk: ApiRisk;
  purpose: string;
  params: Record<string, unknown>;
  called: boolean;
  ok: boolean;
  skippedReason?: string;
  status?: unknown;
  message?: string;
  topLevelKeys?: string[];
  fieldPaths?: FieldPath[];
}

interface FieldPath {
  path: string;
  type: string;
  example?: unknown;
}

const DEFAULT_TEST_BARCODE = "test001";
const DEFAULT_TEST_SPEC_NO = "ghs_123";

const probes: ProbeDefinition[] = [
  {
    category: "base",
    pageName: "warehouse query",
    method: "setting.Warehouse.queryWarehouse",
    risk: "read",
    purpose: "Read warehouse master data for main/near-expiry warehouse configuration.",
    buildParams: (env) => optional({ warehouse_no: profileValue(env, "WAREHOUSE_NO") }),
  },
  {
    category: "base",
    pageName: "shop query",
    method: "setting.Shop.queryShop",
    risk: "read",
    purpose: "Read shop master data for order source mapping.",
    buildParams: (env) => optional({ shop_no: profileValue(env, "SHOP_NO") }),
  },
  {
    category: "base",
    pageName: "logistics query",
    method: "setting.Logistics.queryLogistics",
    risk: "read",
    purpose: "Read logistics company master data for order/export field validation.",
    buildParams: () => ({}),
  },
  {
    category: "base",
    pageName: "virtual warehouse search",
    method: "setting.strategy.VirtualWarehouse.warehouseSearch",
    risk: "read",
    purpose: "Read virtual warehouse strategy data.",
    buildParams: () => recentRange(),
  },
  {
    category: "base",
    pageName: "virtual warehouse query",
    method: "setting.strategy.VirtualWarehouse.query",
    risk: "read",
    purpose: "Read virtual warehouse and physical warehouse relations.",
    buildParams: () => ({}),
  },
  {
    category: "goods",
    pageName: "goods with specs query",
    method: "goods.Goods.queryWithSpec",
    risk: "read",
    purpose: "Read goods/spec data for barcode, goods_no, spec_no, and name matching.",
    buildParams: (env) => ({
      ...optional({ barcode: profileValue(env, "BARCODE") ?? (isProductionEnv(env) ? undefined : DEFAULT_TEST_BARCODE) }),
      hide_deleted: 1,
      ...(isProductionEnv(env) && !profileValue(env, "BARCODE") ? recentRange() : {}),
    }),
  },
  {
    category: "goods",
    pageName: "api goods search",
    method: "goods.ApiGoods.search",
    risk: "read",
    purpose: "Read platform goods mapping data.",
    buildParams: (env) => ({
      ...recentRange(),
      ...optional({ shop_no: profileValue(env, "SHOP_NO"), platform_id: profileValue(env, "PLATFORM_ID") }),
    }),
  },
  {
    category: "goods",
    pageName: "suite search",
    method: "goods.Suite.search",
    risk: "read",
    purpose: "Read suite/bundle goods data for kits, samples, and combos.",
    buildParams: () => recentRange(),
  },
  {
    category: "stock",
    pageName: "stock search",
    method: "wms.StockSpec.search",
    risk: "read",
    purpose: "Read stock data through the older stock endpoint for comparison.",
    buildParams: (env) => ({
      ...recentRange(),
      ...optional({
        spec_no: profileValue(env, "SPEC_NO") ?? (isProductionEnv(env) ? undefined : DEFAULT_TEST_SPEC_NO),
        warehouse_no: profileValue(env, "WAREHOUSE_NO"),
      }),
    }),
  },
  {
    category: "stock",
    pageName: "stock search2",
    method: "wms.StockSpec.search2",
    risk: "read",
    purpose: "Read stock data through the current primary stock endpoint.",
    buildParams: (env) => ({
      ...optional({ spec_nos: arrayParam(profileValue(env, "SPEC_NO") ?? (isProductionEnv(env) ? undefined : DEFAULT_TEST_SPEC_NO)) }),
      ...optional({ warehouse_no: profileValue(env, "WAREHOUSE_NO") }),
    }),
  },
  {
    category: "stock",
    pageName: "available stock query",
    method: "wms.StockSpec.queryAvailableStock",
    risk: "read",
    purpose: "Read available stock for shipment suggestions.",
    buildParams: (env) => ({
      ...recentRange(),
      ...optional({ spec_no: profileValue(env, "SPEC_NO") ?? (isProductionEnv(env) ? undefined : DEFAULT_TEST_SPEC_NO) }),
      ...optional({ warehouse_no: profileValue(env, "WAREHOUSE_NO") }),
    }),
  },
  {
    category: "stock",
    pageName: "stock detail search",
    method: "wms.StockSpec.stockDetailSearch",
    risk: "read",
    purpose: "Read stock detail data, including stock position and batch details.",
    pagination: false,
    buildParams: (env) => optional({ stock_spec_id: profileValue(env, "STOCK_SPEC_ID") }),
  },
  {
    category: "stock",
    pageName: "default position search",
    method: "wms.PositionCapacity.search",
    risk: "read",
    purpose: "Read SKU default positions for warehouse handoff data.",
    buildParams: (env) =>
      optional({
        spec_no: profileValue(env, "SPEC_NO") ?? (isProductionEnv(env) ? undefined : DEFAULT_TEST_SPEC_NO),
        warehouse_no: profileValue(env, "WAREHOUSE_NO"),
      }),
  },
  {
    category: "stock",
    pageName: "virtual warehouse stock search",
    method: "setting.strategy.VirtualWarehouse.stockSearch",
    risk: "read",
    purpose: "Read virtual warehouse stock data.",
    buildParams: (env) =>
      optional({
        spec_no: profileValue(env, "SPEC_NO") ?? (isProductionEnv(env) ? undefined : DEFAULT_TEST_SPEC_NO),
        shop_no: profileValue(env, "SHOP_NO"),
      }),
  },
  {
    category: "stock",
    pageName: "stock change history",
    method: "wms.StockSpec.queryChangeHistory",
    risk: "read",
    purpose: "Read stock change history for refresh and exception diagnosis.",
    buildParams: (env) => ({
      ...recentDateRange(),
      ...optional({
        spec_no: profileValue(env, "SPEC_NO") ?? (isProductionEnv(env) ? undefined : DEFAULT_TEST_SPEC_NO),
        warehouse_no: profileValue(env, "WAREHOUSE_NO"),
      }),
    }),
  },
  {
    category: "order",
    pageName: "trade query with detail",
    method: "sales.TradeQuery.queryWithDetail",
    risk: "read",
    purpose: "Read ERP sales order data for future reconciliation.",
    buildParams: () => recentRange({ minutes: 60 }),
  },
  {
    category: "order",
    pageName: "raw trade search",
    method: "sales.RawTrade.search",
    risk: "read",
    purpose: "Read raw trade data for future push/reconciliation flows.",
    buildParams: () => recentRange(),
  },
  {
    category: "order",
    pageName: "sales stockout query with detail",
    method: "wms.stockout.Sales.queryWithDetail",
    risk: "read",
    purpose: "Read sales stockout data for shipment processing reconciliation.",
    buildParams: () => recentRange({ minutes: 60 }),
  },
  {
    category: "order",
    pageName: "sales stockout position detail",
    method: "wms.stockout.Sales.searchPositionDetail",
    risk: "read",
    purpose: "Read actual sales stockout position details.",
    buildParams: () => recentRange({ minutes: 60 }),
  },
  {
    category: "order",
    pageName: "logistics sync list",
    method: "sales.LogisticsSync.getSyncListExt",
    risk: "read",
    purpose: "Read logistics sync queue data for future logistics loop closure.",
    buildParams: () => recentRange(),
  },
  {
    category: "order",
    pageName: "stock sync calc",
    method: "sales.StockSync.calcStock",
    risk: "read",
    purpose: "Calculate platform goods stock sync values for future stock sync strategy.",
    pagination: false,
    buildParams: (env) => optional({ apiGoodsId: numericEnv(profileValue(env, "API_GOODS_ID")), forceSync: false }),
  },
  {
    category: "order",
    pageName: "stock sync batch calc",
    method: "sales.StockSync.batchCalcStock",
    risk: "read",
    purpose: "Batch calculate platform goods stock sync values.",
    pagination: false,
    buildParams: (env) =>
      profileValue(env, "API_GOODS_ID") ? { params: [{ api_goods_id: numericEnv(profileValue(env, "API_GOODS_ID")), force_sync: false }] } : {},
  },
  {
    category: "order",
    pageName: "raw trade push",
    method: "sales.RawTrade.pushSelf",
    risk: "write",
    purpose: "Push sales orders to ERP. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "order",
    pageName: "raw trade push2",
    method: "sales.RawTrade.pushSelf2",
    risk: "write",
    purpose: "Push self-platform orders to ERP. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "order",
    pageName: "trade import upload",
    method: "sales.TradeImport.upload",
    risk: "write",
    purpose: "Upload completed orders. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "order",
    pageName: "logistics sync update",
    method: "sales.LogisticsSync.update",
    risk: "write",
    purpose: "Update logistics sync status. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "goods",
    pageName: "api goods upload",
    method: "goods.ApiGoods.upload",
    risk: "write",
    purpose: "Write platform goods. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "goods",
    pageName: "goods push",
    method: "goods.Goods.push",
    risk: "write",
    purpose: "Create or update ERP goods. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "goods",
    pageName: "suite upload",
    method: "goods.Suite.upload2",
    risk: "write",
    purpose: "Create or update suites. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "stock",
    pageName: "stocktake create",
    method: "wms.StockPd.stockSyncByPd",
    risk: "write",
    purpose: "Create stocktake data. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "stock",
    pageName: "other stockin create",
    method: "wms.stockin.Other.createOtherOrder",
    risk: "write",
    purpose: "Create other stock-in order. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "stock",
    pageName: "other stockout create",
    method: "wms.stockout.Other.createOther",
    risk: "write",
    purpose: "Create other stock-out order. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "stock",
    pageName: "virtual warehouse create",
    method: "setting.strategy.VirtualWarehouse.create",
    risk: "write",
    purpose: "Create virtual warehouse orders. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
  {
    category: "stock",
    pageName: "goods batch create",
    method: "wms.GoodsBatch.createByApi",
    risk: "write",
    purpose: "Create goods batch numbers. Permission may be requested, but this probe never calls it by default.",
    buildParams: () => ({}),
  },
];

loadDotEnv();

const mode = parseMode(process.argv[2]);
const outputFile = process.argv[3] ?? `outputs/wdt-contract-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const profile = process.env.WDT_ENV ?? "test";
if (isProductionEnv(process.env) && mode !== "read") {
  throw new Error("Production WDT contract probe only allows read mode. Write APIs must not be called.");
}
const client = WdtClient.fromEnvProfile(profile);
const results: ProbeResult[] = [];

for (const probe of probes) {
  const params = probe.buildParams(process.env);
  if (probe.risk === "write" && mode !== "all") {
    results.push({
      ...probeBase(probe, params),
      called: false,
      ok: true,
      skippedReason: "Write API skipped by default. It must not be called without a separate write test plan and explicit confirmation.",
    });
    continue;
  }

  if (probe.risk === "write") {
    results.push({
      ...probeBase(probe, params),
      called: false,
      ok: false,
      skippedReason: "This tool refuses automatic write API calls.",
    });
    continue;
  }

  try {
    const missingReason = missingRequiredParams(probe, params);
    if (missingReason) {
      results.push({
        ...probeBase(probe, params),
        called: false,
        ok: false,
        skippedReason: missingReason,
      });
      continue;
    }
    const response = await client.call(probe.method, params, { pageSize: 5, pagination: probe.pagination });
    results.push({
      ...probeBase(probe, params),
      called: true,
      ok: isOkResponse(response),
      status: readStatus(response),
      message: readMessage(response),
      topLevelKeys: isRecord(response) ? Object.keys(response) : [],
      fieldPaths: collectFieldPaths(response),
    });
  } catch (error) {
    results.push({
      ...probeBase(probe, params),
      called: true,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  mode,
  profile,
  baseUrl: isProductionEnv(process.env)
    ? process.env.WDT_PROD_API_BASE ?? "http://wdt.wangdian.cn/openapi"
    : process.env.WDT_API_BASE ?? "http://47.92.239.46/openapi",
  summary: {
    total: results.length,
    called: results.filter((item) => item.called).length,
    skipped: results.filter((item) => !item.called).length,
    ok: results.filter((item) => item.ok).length,
    failed: results.filter((item) => item.called && !item.ok).length,
  },
  results,
};

mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputFile, summary: report.summary }, null, 2));

function parseMode(value: string | undefined): ProbeMode {
  if (value == null || value === "read") return "read";
  if (value === "all") return "all";
  throw new Error("Usage: tsx backend/src/probes/wdt-contract.ts [read|all] [outputFile]");
}

function optional<T extends Record<string, unknown>>(params: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== ""));
}

function profileValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return isProductionEnv(env) ? env[`WDT_PROD_${name}`] : env[`WDT_TEST_${name}`];
}

function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return env.WDT_ENV === "prod" || env.WDT_ENV === "production";
}

function profileEnvName(env: NodeJS.ProcessEnv, name: string): string {
  return isProductionEnv(env) ? `WDT_PROD_${name}` : `WDT_TEST_${name}`;
}

function arrayParam(value: string | undefined): string[] | undefined {
  return value ? [value] : undefined;
}

function recentRange(options: { minutes?: number } = {}): Record<string, unknown> {
  const end = new Date();
  const start = new Date(end.getTime() - (options.minutes ?? 7 * 24 * 60) * 60 * 1000);
  return {
    start_time: formatDateTime(start),
    end_time: formatDateTime(end),
  };
}

function recentDateRange(): Record<string, unknown> {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    start_date: formatDateTime(start),
    end_date: formatDateTime(end),
  };
}

function numericEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function missingRequiredParams(probe: ProbeDefinition, params: Record<string, unknown>): string | undefined {
  if (probe.method === "wms.StockSpec.search2" && !Array.isArray(params.spec_nos)) {
    return `Missing ${profileEnvName(process.env, "SPEC_NO")}; this API requires a spec_no list.`;
  }
  if (probe.method === "wms.StockSpec.queryAvailableStock" && params.spec_no == null) {
    return `Missing ${profileEnvName(process.env, "SPEC_NO")}; this API requires a spec_no.`;
  }
  if (probe.method === "wms.StockSpec.stockDetailSearch" && params.stock_spec_id == null) {
    return `Missing ${profileEnvName(process.env, "STOCK_SPEC_ID")}; this API requires a stock rec_id/stock_spec_id.`;
  }
  if (probe.method === "sales.StockSync.calcStock" && params.apiGoodsId == null) {
    return `Missing ${profileEnvName(process.env, "API_GOODS_ID")}; this API requires a platform goods rec_id.`;
  }
  if (probe.method === "sales.StockSync.batchCalcStock" && !Array.isArray(params.params)) {
    return `Missing ${profileEnvName(process.env, "API_GOODS_ID")}; batch stock sync requires platform goods rec_id values.`;
  }
  return undefined;
}

function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function probeBase(probe: ProbeDefinition, params: Record<string, unknown>): Omit<ProbeResult, "called" | "ok"> {
  return {
    category: probe.category,
    pageName: probe.pageName,
    method: probe.method,
    risk: probe.risk,
    purpose: probe.purpose,
    params,
  };
}

function isOkResponse(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const status = response.status;
  return status === 0 || status === "0";
}

function readStatus(response: unknown): unknown {
  return isRecord(response) ? response.status : undefined;
}

function readMessage(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const message = response.message ?? response.msg ?? response.error_msg ?? response.errmsg;
  return message == null ? undefined : String(message);
}

function collectFieldPaths(value: unknown): FieldPath[] {
  const fields = new Map<string, FieldPath>();
  visit(value, "$", fields, 0);
  return [...fields.values()].slice(0, 600);
}

function visit(value: unknown, path: string, fields: Map<string, FieldPath>, depth: number): void {
  if (depth > 8 || fields.size >= 600) return;

  const type = fieldType(value);
  if (!fields.has(path)) {
    fields.set(path, {
      path,
      type,
      ...exampleFor(path, value),
    });
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) {
      visit(item, `${path}[]`, fields, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visit(child, `${path}.${key}`, fields, depth + 1);
  }
}

function fieldType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function exampleFor(path: string, value: unknown): { example?: unknown } {
  if (value == null || typeof value === "object") return {};
  const key = path.toLowerCase();
  if (/(phone|mobile|tel|address|receiver|consignee|id_card|identity|token|secret|sign|key|sid|password|pwd)/.test(key)) {
    return { example: "[redacted]" };
  }
  if (typeof value === "string") {
    return { example: value.length > 80 ? `${value.slice(0, 80)}...` : value };
  }
  return { example: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
