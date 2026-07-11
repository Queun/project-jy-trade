import { normalizeWdtProfile, WdtClient, type WdtGoodsResponse, type WdtStockResponse } from "../../../backend/src/integrations/wdtClient.js";
import type { StockLookupClient } from "./store.js";
import type { WdtGoodsWindowClient } from "./wdtGoodsSync.js";

export interface WdtReadClients {
  goodsClient: WdtGoodsWindowClient;
  stockClient: StockLookupClient;
}

export function createWdtReadClientsFromEnv(profile = normalizeWdtProfile(process.env.WDT_ENV)): WdtReadClients | undefined {
  try {
    const client = WdtClient.fromEnvProfile(profile);
    return {
      goodsClient: {
        async queryGoodsWindow(input) {
          const response = await client.queryGoodsWindow(input.startTime, input.endTime, input.pageNo, input.pageSize);
          assertWdtGoodsSuccess(response);
          return {
            totalCount: response.data?.total_count ?? 0,
            goods: response.data?.goods_list ?? [],
          };
        },
      },
      stockClient: {
        async queryStock(specNo, warehouseNo) {
          const response = await client.queryStock(specNo, warehouseNo);
          assertWdtStockSuccess(response);
          return response;
        },
        async queryStocks(specNos, warehouseNo) {
          const response = await client.queryStocks(specNos, warehouseNo);
          assertWdtStockSuccess(response);
          return response;
        },
      },
    };
  } catch {
    return undefined;
  }
}

function assertWdtGoodsSuccess(response: WdtGoodsResponse): void {
  if (response.status && response.status !== 0) {
    throw new Error(`WDT goods query failed: status=${response.status} message=${response.message ?? ""}`);
  }
}

function assertWdtStockSuccess(response: WdtStockResponse): void {
  if (response.status && response.status !== 0) {
    throw new Error(`WDT stock query failed: status=${response.status} message=${response.message ?? ""}`);
  }
}
