import { describe, expect, it } from "vitest";

import type { WdtSyncRunDto } from "@jy-trade/shared";
import type { WdtStockRow } from "../../../backend/src/integrations/wdtClient.js";
import type { StockLookupClient } from "./store.js";
import {
  executeCombinedSync,
  startCombinedSync,
  WDT_SYNC_BATCH_SIZE,
  type CombinedSyncRepository,
} from "./wdtCombinedSync.js";

describe("combined WDT goods and stock sync", () => {
  it("queries 3,800 specs in 95 batches of at most 40 and records progress before activation", async () => {
    const repository = new MemoryCombinedSyncRepository();
    repository.specNos = Array.from({ length: 3_800 }, (_, index) => `SPEC-${String(index + 1).padStart(4, "0")}`);
    const requestedBatches: string[][] = [];
    const stockClient = stockClientWithBatchQuery(async (specNos) => {
      requestedBatches.push([...specNos]);
      return {
        status: 0,
        data: {
          detail_list: specNos.map((specNo) => ({
            spec_no: specNo,
            warehouse_no: "WH-01",
            warehouse_name: "主仓",
            available_send_stock: 10,
          })),
        },
      };
    });

    expect(WDT_SYNC_BATCH_SIZE).toBe(40);
    await executeCombinedSync(repository, stockClient, "run-large");

    expect(requestedBatches).toHaveLength(95);
    expect(requestedBatches.every((batch) => batch.length === 40)).toBe(true);
    expect(requestedBatches.flat()).toEqual(repository.specNos);
    expect(repository.stockWrites).toHaveLength(95);
    expect(repository.run).toMatchObject({
      status: "success",
      stage: "complete",
      totalSpecCount: 3_800,
      processedSpecCount: 3_800,
      totalBatchCount: 95,
      completedBatchCount: 95,
      stockRowCount: 3_800,
    });
    expect(repository.progressPatches.at(-2)).toMatchObject({
      processedSpecCount: 3_800,
      completedBatchCount: 95,
      stockRowCount: 3_800,
    });
    expect(repository.activateCalls).toEqual(["run-large"]);
    expect(repository.failCalls).toHaveLength(0);
  });

  it("deduplicates and trims specs, writes verified zero-stock specs, and activates only after all batches succeed", async () => {
    const repository = new MemoryCombinedSyncRepository();
    repository.specNos = [" SPEC-B ", "SPEC-A", "SPEC-B", "", "   "];
    const events: string[] = [];
    repository.onWrite = (_runId, requestedSpecNos) => {
      events.push(`write:${requestedSpecNos.join(",")}`);
    };
    repository.onActivate = () => {
      events.push("activate");
    };
    const stockClient = stockClientWithBatchQuery(async (specNos) => {
      events.push(`query:${specNos.join(",")}`);
      return {
        status: 0,
        data: {
          // SPEC-B is deliberately omitted: the repository must still receive it
          // in requestedSpecNos so it can persist a verified zero-stock marker.
          detail_list: [{ spec_no: "SPEC-A", warehouse_no: "WH-01", available_send_stock: 3 }],
        },
      };
    });

    await executeCombinedSync(repository, stockClient, "run-success");

    expect(repository.stockWrites).toEqual([
      {
        runId: "run-success",
        requestedSpecNos: ["SPEC-A", "SPEC-B"],
        rows: [{ spec_no: "SPEC-A", warehouse_no: "WH-01", available_send_stock: 3 }],
      },
    ]);
    expect(events).toEqual([
      "query:SPEC-A,SPEC-B",
      "write:SPEC-A,SPEC-B",
      "activate",
    ]);
    expect(repository.run).toMatchObject({
      status: "success",
      stage: "complete",
      totalSpecCount: 2,
      processedSpecCount: 2,
      totalBatchCount: 1,
      completedBatchCount: 1,
      stockRowCount: 1,
    });
  });

  it("marks the run failed and never activates when a stock batch fails", async () => {
    const repository = new MemoryCombinedSyncRepository();
    repository.specNos = Array.from({ length: 41 }, (_, index) => `SPEC-${index + 1}`);
    let queryCount = 0;
    const stockClient = stockClientWithBatchQuery(async () => {
      queryCount += 1;
      if (queryCount === 1) {
        return {
          status: 0,
          data: { detail_list: [{ spec_no: "SPEC-1", warehouse_no: "WH-01", available_send_stock: 1 }] },
        };
      }
      return { status: 500, message: "库存接口不可用" };
    });

    await executeCombinedSync(repository, stockClient, "run-stock-failure");

    expect(queryCount).toBe(2);
    expect(repository.stockWrites).toHaveLength(1);
    expect(repository.activateCalls).toHaveLength(0);
    expect(repository.failCalls).toEqual([
      expect.objectContaining({
        runId: "run-stock-failure",
        errorCode: "WDT_STOCK_ERROR",
        errorMessage: "旺店通库存同步失败",
        errorDetail: expect.stringContaining("status=500 message=库存接口不可用"),
      }),
    ]);
    expect(repository.run).toMatchObject({
      status: "failed",
      errorCode: "WDT_STOCK_ERROR",
      errorMessage: "旺店通库存同步失败",
    });
  });

  it("rejects a paginated or unrelated stock response instead of treating omitted specs as zero stock", async () => {
    const repository = new MemoryCombinedSyncRepository();
    repository.specNos = ["SPEC-1", "SPEC-2"];
    const stockClient = stockClientWithBatchQuery(async () => ({
      status: 0,
      data: {
        total_count: 2,
        detail_list: [{ spec_no: "OTHER-SPEC", warehouse_no: "WH-01", available_send_stock: 1 }],
      },
    }));

    await executeCombinedSync(repository, stockClient, "run-incomplete");

    expect(repository.stockWrites).toHaveLength(0);
    expect(repository.activateCalls).toHaveLength(0);
    expect(repository.failCalls[0]).toMatchObject({
      runId: "run-incomplete",
      errorCode: "WDT_STOCK_INCOMPLETE",
      errorMessage: "旺店通库存响应不完整，本次快照未生效",
    });
  });

  it.each([
    {
      name: "concurrency response",
      firstAttempt: () => Promise.resolve({ status: 100, message: "请求并发超限" }),
    },
    {
      name: "frequency exception",
      firstAttempt: () => Promise.reject(new Error("旺店通频率限制，请稍后重试")),
    },
  ])("retries a transient $name and then completes", async ({ firstAttempt }) => {
    const repository = new MemoryCombinedSyncRepository();
    repository.specNos = ["SPEC-1"];
    let attempts = 0;
    const stockClient = stockClientWithBatchQuery(async () => {
      attempts += 1;
      if (attempts === 1) return firstAttempt();
      return {
        status: 0,
        data: { detail_list: [{ spec_no: "SPEC-1", warehouse_no: "WH-01", available_send_stock: 8 }] },
      };
    });

    await executeCombinedSync(repository, stockClient, "run-retry");

    expect(attempts).toBe(2);
    expect(repository.activateCalls).toHaveLength(1);
    expect(repository.failCalls).toHaveLength(0);
    expect(repository.run.status).toBe("success");
  });

  it("returns the existing active run without creating or starting another task", async () => {
    const repository = new MemoryCombinedSyncRepository();
    repository.activeRun = makeRun({ id: "run-already-active", status: "running", stage: "stock" });
    let stockQueryCount = 0;
    const stockClient = stockClientWithBatchQuery(async () => {
      stockQueryCount += 1;
      return { status: 0, data: { detail_list: [] } };
    });

    const result = await startCombinedSync(repository, stockClient, "manual");

    expect(result).toEqual({
      run: repository.activeRun,
      alreadyRunning: true,
    });
    expect(result.task).toBeUndefined();
    expect(repository.createCalls).toHaveLength(0);
    expect(repository.goodsSyncCalls).toBe(0);
    expect(stockQueryCount).toBe(0);
  });
});

function stockClientWithBatchQuery(
  queryStocks: NonNullable<StockLookupClient["queryStocks"]>,
): StockLookupClient {
  return {
    async queryStock() {
      throw new Error("single-SKU stock lookup should not be used by combined sync tests");
    },
    queryStocks,
  };
}

function makeRun(patch: Partial<WdtSyncRunDto> = {}): WdtSyncRunDto {
  return {
    id: "run",
    trigger: "manual",
    status: "queued",
    stage: "queued",
    goodsSyncRunId: "",
    totalSpecCount: 0,
    processedSpecCount: 0,
    totalBatchCount: 0,
    completedBatchCount: 0,
    stockRowCount: 0,
    startedAt: "2026-07-11T00:00:00.000Z",
    finishedAt: "",
    lastProgressAt: "2026-07-11T00:00:00.000Z",
    activeSnapshotRunId: "",
    activeSnapshotAt: "",
    activeSnapshotTrigger: "",
    errorCode: "",
    errorMessage: "",
    errorDetail: "",
    ...patch,
  };
}

class MemoryCombinedSyncRepository implements CombinedSyncRepository {
  run = makeRun();
  activeRun?: WdtSyncRunDto;
  specNos: string[] = [];
  goodsRun = { id: "goods-run", status: "success" as const, errorMessage: "" };
  goodsSyncCalls = 0;
  createCalls: Array<{ id: string; trigger: WdtSyncRunDto["trigger"]; now: string }> = [];
  progressPatches: Array<Partial<WdtSyncRunDto>> = [];
  stockWrites: Array<{ runId: string; requestedSpecNos: string[]; rows: WdtStockRow[] }> = [];
  activateCalls: string[] = [];
  failCalls: Array<{
    runId: string;
    errorCode: string;
    errorMessage: string;
    errorDetail: string;
    finishedAt: string;
  }> = [];
  onWrite?: (runId: string, requestedSpecNos: string[], rows: WdtStockRow[]) => void;
  onActivate?: (runId: string) => void;

  async findActiveRun() {
    return this.activeRun;
  }

  async createRun(input: { id: string; trigger: WdtSyncRunDto["trigger"]; now: string }) {
    this.createCalls.push(input);
    this.run = makeRun({ id: input.id, trigger: input.trigger, startedAt: input.now, lastProgressAt: input.now });
    return this.run;
  }

  async updateRun(_runId: string, patch: Partial<WdtSyncRunDto>) {
    this.progressPatches.push(patch);
    this.run = { ...this.run, ...patch };
  }

  async runGoodsIncremental() {
    this.goodsSyncCalls += 1;
    return this.goodsRun;
  }

  async loadStockSpecNos() {
    return [...this.specNos];
  }

  async writeStockBatch(runId: string, requestedSpecNos: string[], rows: WdtStockRow[]) {
    const record = { runId, requestedSpecNos: [...requestedSpecNos], rows: rows.map((row) => ({ ...row })) };
    this.stockWrites.push(record);
    this.onWrite?.(runId, requestedSpecNos, rows);
    return rows.length;
  }

  async activateRun(runId: string, finishedAt: string) {
    this.activateCalls.push(runId);
    this.onActivate?.(runId);
    this.run = {
      ...this.run,
      status: "success",
      stage: "complete",
      finishedAt,
      activeSnapshotRunId: runId,
      activeSnapshotAt: finishedAt,
      activeSnapshotTrigger: this.run.trigger,
    };
  }

  async failRun(
    runId: string,
    errorCode: string,
    errorMessage: string,
    errorDetail: string,
    finishedAt: string,
  ) {
    this.failCalls.push({ runId, errorCode, errorMessage, errorDetail, finishedAt });
    this.run = {
      ...this.run,
      status: "failed",
      finishedAt,
      errorCode,
      errorMessage,
      errorDetail,
    };
  }

}
