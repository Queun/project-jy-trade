import { createHash } from "node:crypto";

export interface WdtClientConfig {
  sid: string;
  appkey: string;
  appsecret: string;
  baseUrl?: string;
}

export interface WdtCallOptions {
  pageNo?: number;
  pageSize?: number;
  calcTotal?: number;
  pagination?: boolean;
}

export interface WdtGoodsSpec {
  spec_no?: string;
  spec_code?: string;
  barcode?: string;
  spec_name?: string;
  deleted?: number;
  barcode_list?: Array<{
    barcode?: string;
    is_master?: number;
    type?: number;
  }>;
}

export interface WdtGoods {
  goods_no?: string;
  goods_name?: string;
  deleted?: number;
  spec_list?: WdtGoodsSpec[];
}

export interface WdtGoodsResponse {
  status?: number;
  message?: string;
  data?: {
    total_count?: number;
    goods_list?: WdtGoods[];
  };
}

export interface WdtStockRow {
  spec_no?: string;
  barcode?: string;
  goods_no?: string;
  goods_name?: string;
  spec_name?: string;
  warehouse_no?: string;
  warehouse_name?: string;
  defect?: boolean;
  stock_num?: number;
  available_send_stock?: number;
  available_send_num?: number | string;
  available_stock?: number | string;
  available_num?: number | string;
  available_qty?: number | string;
  available?: number | string;
  avail_stock?: number | string;
  avail_num?: number | string;
  库存?: number | string;
  可发库存?: number | string;
  可发数?: number | string;
  可发数量?: number | string;
  可发?: number | string;
  可发货量?: number | string;
}

export interface WdtStockResponse {
  status?: number;
  message?: string;
  data?: {
    total_count?: number;
    detail_list?: WdtStockRow[];
  };
}

export function getWdtAvailableSendStock(row: WdtStockRow): number {
  return numberFromWdtCell(
    row.available_send_stock
      ?? row.available_send_num
      ?? row.available_stock
      ?? row.available_num
      ?? row.available_qty
      ?? row.available
      ?? row.avail_stock
      ?? row.avail_num
      ?? row.可发库存
      ?? row.可发数
      ?? row.可发数量
      ?? row.可发
      ?? row.可发货量,
  );
}

export function getWdtStockNum(row: WdtStockRow): number {
  return numberFromWdtCell(row.stock_num ?? row.库存);
}

function numberFromWdtCell(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value.trim()) : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export interface WdtSuiteRow {
  suite_no?: string;
  suite_name?: string;
  barcode?: string;
  suite_spec_name?: string;
  spec_no?: string;
  spec_name?: string;
}

export interface WdtSuiteResponse {
  status?: number;
  message?: string;
  data?: {
    total_count?: number;
    suite_list?: WdtSuiteRow[];
  };
}

const DEFAULT_BASE_URL = "http://47.92.239.46/openapi";
const WDT_TS_OFFSET = 1325347200;

export function splitAppSecret(appsecret: string): { secret: string; salt: string } {
  const separator = appsecret.indexOf(":");
  if (separator <= 0 || separator === appsecret.length - 1) {
    throw new Error("WDT appsecret must use secret:salt format");
  }
  return {
    secret: appsecret.slice(0, separator),
    salt: appsecret.slice(separator + 1),
  };
}

export function wdtSign(params: Record<string, string>, secret: string): string {
  const payload = [
    secret,
    ...Object.keys(params)
      .filter((key) => key !== "sign")
      .sort()
      .flatMap((key) => [key, params[key] ?? ""]),
    secret,
  ].join("");

  return createHash("md5").update(payload, "utf8").digest("hex");
}

export class WdtClient {
  private readonly sid: string;
  private readonly appkey: string;
  private readonly secret: string;
  private readonly salt: string;
  private readonly baseUrl: string;

  constructor(config: WdtClientConfig) {
    const { secret, salt } = splitAppSecret(config.appsecret);
    this.sid = config.sid;
    this.appkey = config.appkey;
    this.secret = secret;
    this.salt = salt;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  getDebugInfo(): { baseUrl: string; sid: string; appkey: string } {
    return {
      baseUrl: this.baseUrl,
      sid: this.sid,
      appkey: this.appkey,
    };
  }

  static fromEnv(): WdtClient {
    return WdtClient.fromEnvProfile(process.env.WDT_ENV);
  }

  static fromEnvProfile(profile?: string): WdtClient {
    const normalizedProfile = normalizeWdtProfile(profile);
    const prefix = normalizedProfile === "prod" || normalizedProfile === "production" ? "WDT_PROD" : "WDT";
    const sid = process.env[`${prefix}_SID`];
    const appkey = process.env[`${prefix}_APPKEY`];
    const appsecret = process.env[`${prefix}_APPSECRET`];
    if (!sid || !appkey || !appsecret) {
      throw new Error(`Missing ${prefix}_SID, ${prefix}_APPKEY, or ${prefix}_APPSECRET`);
    }
    return new WdtClient({
      sid,
      appkey,
      appsecret,
      baseUrl: process.env[`${prefix}_API_BASE`] ?? process.env.WDT_API_BASE,
    });
  }

  async call(method: string, params: Record<string, unknown>, options: WdtCallOptions = {}): Promise<unknown> {
    const body = JSON.stringify([params]);
    const query: Record<string, string> = {
      body,
      key: this.appkey,
      method,
      salt: this.salt,
      sid: this.sid,
      timestamp: String(Math.floor(Date.now() / 1000) - WDT_TS_OFFSET),
      v: "1.0",
    };
    if (options.pagination ?? true) {
      query.calc_total = String(options.calcTotal ?? 1);
      query.page_no = String(options.pageNo ?? 0);
      query.page_size = String(options.pageSize ?? 20);
    }
    query.sign = wdtSign(query, this.secret);

    const requestQuery = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key !== "body") requestQuery.set(key, value);
    }

    const response = await fetch(`${this.baseUrl}?${requestQuery.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body,
    });

    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {
        status: "non_json_response",
        raw: text,
      };
    }
  }

  queryWarehouse(warehouseNo?: string): Promise<unknown> {
    return this.call("setting.Warehouse.queryWarehouse", warehouseNo ? { warehouse_no: warehouseNo } : {});
  }

  queryGoodsByBarcode(barcode: string): Promise<WdtGoodsResponse> {
    return this.call("goods.Goods.queryWithSpec", { barcode, hide_deleted: 1 }) as Promise<WdtGoodsResponse>;
  }

  queryGoodsBySpecNo(specNo: string): Promise<WdtGoodsResponse> {
    return this.call("goods.Goods.queryWithSpec", { spec_no: specNo, hide_deleted: 1 }) as Promise<WdtGoodsResponse>;
  }

  queryGoodsByGoodsNo(goodsNo: string): Promise<WdtGoodsResponse> {
    return this.call("goods.Goods.queryWithSpec", { goods_no: goodsNo, hide_deleted: 1 }) as Promise<WdtGoodsResponse>;
  }

  queryGoodsByName(goodsName: string): Promise<WdtGoodsResponse> {
    return this.call("goods.Goods.queryWithSpec", { goods_name: goodsName, hide_deleted: 1, ...recentModifiedRange() }) as Promise<WdtGoodsResponse>;
  }

  queryGoodsBySpecName(specName: string): Promise<WdtGoodsResponse> {
    return this.call("goods.Goods.queryWithSpec", { spec_name: specName, hide_deleted: 1, ...recentModifiedRange() }) as Promise<WdtGoodsResponse>;
  }

  queryRecentGoodsCandidates(pageNo = 0, pageSize = 100): Promise<WdtGoodsResponse> {
    return this.call(
      "goods.Goods.queryWithSpec",
      { hide_deleted: 1, ...recentModifiedRange() },
      { pageNo, pageSize },
    ) as Promise<WdtGoodsResponse>;
  }

  queryGoodsWindow(startTime: string, endTime: string, pageNo = 0, pageSize = 1000): Promise<WdtGoodsResponse> {
    return this.call(
      "goods.Goods.queryWithSpec",
      { hide_deleted: 1, start_time: startTime, end_time: endTime },
      { pageNo, pageSize },
    ) as Promise<WdtGoodsResponse>;
  }

  querySuites(params: Record<string, unknown>, pageNo = 0, pageSize = 1000): Promise<WdtSuiteResponse> {
    return this.call("goods.Suite.search", params, { pageNo, pageSize }) as Promise<WdtSuiteResponse>;
  }

  queryStock(specNo: string, warehouseNo?: string): Promise<WdtStockResponse> {
    return this.queryStocks([specNo], warehouseNo);
  }

  queryStocks(specNos: string[], warehouseNo?: string): Promise<WdtStockResponse> {
    return this.call(
      "wms.StockSpec.search2",
      {
        spec_nos: specNos,
        ...(warehouseNo ? { warehouse_no: warehouseNo } : {}),
      },
      { pageSize: 1000 },
    ) as Promise<WdtStockResponse>;
  }

  queryRecentStockCandidates(warehouseNo?: string): Promise<WdtStockResponse> {
    return this.call(
      "wms.StockSpec.search2",
      {
        ...recentModifiedRange(),
        ...(warehouseNo ? { warehouse_no: warehouseNo } : {}),
      },
      { pageSize: 100 },
    ) as Promise<WdtStockResponse>;
  }
}

export function normalizeWdtProfile(profile?: string): string {
  const normalized = profile?.trim();
  return normalized ? normalized : "test";
}

function recentModifiedRange(): { start_time: string; end_time: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
  return {
    start_time: formatDateTime(start),
    end_time: formatDateTime(end),
  };
}

function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
