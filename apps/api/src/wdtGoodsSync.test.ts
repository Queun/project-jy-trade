import { describe, expect, it } from "vitest";

import {
  buildDateWindows,
  flattenWdtGoodsSpecs,
  runWdtGoodsSync,
  DEFAULT_GOODS_SYNC_PAGE_SIZE,
  type GoodsSyncRepository,
  type GoodsSyncRunRecord,
  type WdtGoodsSpecPayload,
  type WdtGoodsWindowClient,
} from "./wdtGoodsSync.js";

describe("wdt goods sync", () => {
  it("builds windows no longer than 30 days", () => {
    const windows = buildDateWindows(new Date("2026-01-01T00:00:00.000Z"), new Date("2026-03-15T00:00:00.000Z"));
    expect(windows.length).toBe(3);
    for (const window of windows) {
      expect(window.end.getTime() - window.start.getTime()).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
    }
  });

  it("flattens goods and barcode lists into specs", () => {
    const specs = flattenWdtGoodsSpecs([
      {
        goods_no: "G1",
        goods_name: "商品",
        spec_list: [
          {
            spec_no: "S1",
            spec_name: "规格",
            barcode: "B1",
            barcode_list: [{ barcode: "B1", is_master: 1 }, { barcode: "B2" }],
          },
        ],
      },
    ]);

    expect(specs).toMatchObject([
      {
        goodsNo: "G1",
        goodsName: "商品",
        specNo: "S1",
        barcode: "B1",
        barcodes: ["B1", "B2"],
      },
    ]);
  });

  it("syncs multiple pages and records success", async () => {
    const repository = new MemoryGoodsSyncRepository();
    const client: WdtGoodsWindowClient = {
      async queryGoodsWindow({ pageNo, pageSize }) {
        expect(pageSize).toBe(1000);
        return {
          totalCount: 1001,
          goods:
            pageNo === 0
              ? [{ goods_no: "G1", goods_name: "商品1", spec_list: [{ spec_no: "S1", barcode: "B1" }] }]
              : [{ goods_no: "G2", goods_name: "商品2", spec_list: [{ spec_no: "S2", barcode: "B2" }] }],
        };
      },
    };

    const run = await runWdtGoodsSync(repository, client, {
      mode: "full",
      startDate: "2026-01-01",
      endDate: "2026-01-01",
      pageSize: 1000,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(run.status).toBe("success");
    expect(run.pageCount).toBe(2);
    expect(run.fetchedCount).toBe(2);
    expect(run.upsertedCount).toBe(2);
    expect(repository.specs.map((spec) => spec.specNo).sort()).toEqual(["S1", "S2"]);
  });

  it("uses page size 500 by default", async () => {
    const repository = new MemoryGoodsSyncRepository();
    const pageSizes: number[] = [];
    const client: WdtGoodsWindowClient = {
      async queryGoodsWindow({ pageSize }) {
        pageSizes.push(pageSize);
        return { totalCount: 0, goods: [] };
      },
    };

    await runWdtGoodsSync(repository, client, {
      mode: "full",
      startDate: "2026-01-01",
      endDate: "2026-01-01",
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(DEFAULT_GOODS_SYNC_PAGE_SIZE).toBe(500);
    expect(pageSizes).toEqual([500]);
  });

  it("retries a failed page and succeeds", async () => {
    const repository = new MemoryGoodsSyncRepository();
    let attempts = 0;
    const client: WdtGoodsWindowClient = {
      async queryGoodsWindow() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary fetch failed");
        return { totalCount: 1, goods: [{ goods_no: "G1", spec_list: [{ spec_no: "S1" }] }] };
      },
    };

    const run = await runWdtGoodsSync(repository, client, {
      mode: "full",
      startDate: "2026-01-01",
      endDate: "2026-01-01",
      maxRetries: 3,
      retryDelaysMs: [0, 0, 0],
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(run.status).toBe("success");
    expect(attempts).toBe(2);
    expect(repository.specs.map((spec) => spec.specNo)).toEqual(["S1"]);
  });

  it("records failed page context after all retries", async () => {
    const repository = new MemoryGoodsSyncRepository();
    repository.specs.push({ specNo: "OLD" } as WdtGoodsSpecPayload);
    const client: WdtGoodsWindowClient = {
      async queryGoodsWindow() {
        throw new Error("fetch failed");
      },
    };

    const run = await runWdtGoodsSync(repository, client, {
      mode: "full",
      startDate: "2026-01-01",
      endDate: "2026-01-01",
      pageSize: 500,
      maxRetries: 3,
      retryDelaysMs: [0, 0, 0],
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("goods.Goods.queryWithSpec");
    expect(run.errorMessage).toContain("page_no=0");
    expect(run.errorMessage).toContain("page_size=500");
    expect(run.errorMessage).toContain("attempts=3");
    expect(repository.specs.map((spec) => spec.specNo)).toContain("OLD");
  });

  it("records failure without deleting existing specs", async () => {
    const repository = new MemoryGoodsSyncRepository();
    repository.specs.push({ specNo: "OLD" } as WdtGoodsSpecPayload);
    const client: WdtGoodsWindowClient = {
      async queryGoodsWindow() {
        throw new Error("network failed");
      },
    };

    const run = await runWdtGoodsSync(repository, client, {
      mode: "full",
      startDate: "2026-01-01",
      endDate: "2026-01-01",
      now: new Date("2026-01-02T00:00:00.000Z"),
      maxRetries: 1,
    });

    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("network failed");
    expect(repository.specs.map((spec) => spec.specNo)).toContain("OLD");
  });

  it("uses latest successful run with overlap for incremental sync", async () => {
    const repository = new MemoryGoodsSyncRepository();
    repository.latestSuccess = {
      ...repository.newRun("full"),
      status: "success",
      rangeEnd: "2026-02-10T00:00:00.000Z",
    };
    const starts: string[] = [];
    const client: WdtGoodsWindowClient = {
      async queryGoodsWindow({ startTime }) {
        starts.push(startTime);
        return { totalCount: 0, goods: [] };
      },
    };

    await runWdtGoodsSync(repository, client, {
      mode: "incremental",
      endDate: "2026-02-11",
      overlapDays: 1,
      now: new Date("2026-02-11T12:00:00.000Z"),
    });

    expect(starts[0]).toBe("2026-02-09 00:00:00");
  });
});

class MemoryGoodsSyncRepository implements GoodsSyncRepository {
  runs: GoodsSyncRunRecord[] = [];
  specs: WdtGoodsSpecPayload[] = [];
  latestSuccess?: GoodsSyncRunRecord;

  async createGoodsSyncRun(input: Parameters<GoodsSyncRepository["createGoodsSyncRun"]>[0]) {
    const run: GoodsSyncRunRecord = {
      ...input,
      finishedAt: "",
      windowCount: 0,
      pageCount: 0,
      fetchedCount: 0,
      upsertedCount: 0,
      errorMessage: "",
    };
    this.runs.push(run);
    return run;
  }

  async finishGoodsSyncRun(runId: string, patch: Parameters<GoodsSyncRepository["finishGoodsSyncRun"]>[1]) {
    const index = this.runs.findIndex((run) => run.id === runId);
    const next = { ...this.runs[index], ...patch };
    this.runs[index] = next;
    if (next.status === "success") this.latestSuccess = next;
    return next;
  }

  async getLatestSuccessfulGoodsSyncRun() {
    return this.latestSuccess;
  }

  async upsertGoodsSpecs(specs: WdtGoodsSpecPayload[]) {
    for (const spec of specs) {
      const index = this.specs.findIndex((item) => item.specNo === spec.specNo);
      if (index >= 0) this.specs[index] = spec;
      else this.specs.push(spec);
    }
    return specs.length;
  }

  newRun(mode: GoodsSyncRunRecord["mode"]): GoodsSyncRunRecord {
    return {
      id: "run",
      mode,
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "",
      rangeStart: "2026-01-01T00:00:00.000Z",
      rangeEnd: "2026-01-01T00:00:00.000Z",
      windowCount: 0,
      pageCount: 0,
      fetchedCount: 0,
      upsertedCount: 0,
      errorMessage: "",
    };
  }
}
