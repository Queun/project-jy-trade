import { describe, expect, it } from "vitest";

import {
  flattenWdtSuites,
  runWdtSuiteSync,
  type SuiteSyncRepository,
  type SuiteSyncRunRecord,
  type WdtSuitePayload,
  type WdtSuiteWindowClient,
} from "./wdtSuiteSync.js";

describe("wdt suite sync", () => {
  it("queries date-only suite windows as complete Shanghai calendar days", async () => {
    const repository = new MemorySuiteSyncRepository();
    const windows: Array<{ startTime: string; endTime: string }> = [];
    const client: WdtSuiteWindowClient = {
      async querySuitesWindow({ startTime, endTime }) {
        windows.push({ startTime, endTime });
        return { totalCount: 0, suites: [] };
      },
    };

    await runWdtSuiteSync(repository, client, {
      mode: "full",
      startDate: "2026-07-16",
      endDate: "2026-07-16",
      now: new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(windows).toEqual([{
      startTime: "2026-07-16 00:00:00",
      endTime: "2026-07-16 23:59:59",
    }]);
  });

  it("flattens suite detail rows into local payloads", () => {
    const suites = flattenWdtSuites([
      {
        suite_no: "2150317560013",
        suite_name: "lelabo护发素(33檀香系列)50ml",
        barcode: "2150317560013",
        detail_list: [
          {
            rec_id: 1,
            spec_no: "021700004",
            goods_no: "021700004",
            goods_name: "【中小样】le labo护发素(33檀香系列)",
            spec_name: "50ml",
            barcode: "021700004",
            num: 1,
            ratio: 1,
          },
        ],
      },
    ]);

    expect(suites).toMatchObject([
      {
        suiteNo: "2150317560013",
        suiteName: "lelabo护发素(33檀香系列)50ml",
        barcode: "2150317560013",
        components: [
          {
            recId: "1",
            specNo: "021700004",
            goodsNo: "021700004",
            quantity: 1,
            ratio: 1,
          },
        ],
      },
    ]);
  });

  it("syncs suite pages and records success", async () => {
    const repository = new MemorySuiteSyncRepository();
    const client: WdtSuiteWindowClient = {
      async querySuitesWindow({ pageNo, pageSize }) {
        expect(pageSize).toBe(1);
        return {
          totalCount: 2,
          suites: [
            {
              suite_no: pageNo === 0 ? "SUITE-1" : "SUITE-2",
              suite_name: pageNo === 0 ? "组合装1" : "组合装2",
              barcode: pageNo === 0 ? "BAR-1" : "BAR-2",
              detail_list: [{ rec_id: 1, spec_no: pageNo === 0 ? "SPEC-1" : "SPEC-2", num: 1 }],
            },
          ],
        };
      },
    };

    const run = await runWdtSuiteSync(repository, client, {
      mode: "full",
      startDate: "2026-07-01",
      endDate: "2026-07-01",
      pageSize: 1,
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(run.status).toBe("success");
    expect(run.pageCount).toBe(2);
    expect(run.fetchedCount).toBe(2);
    expect(run.upsertedCount).toBe(2);
    expect(repository.suites.map((suite) => suite.suiteNo).sort()).toEqual(["SUITE-1", "SUITE-2"]);
  });
});

class MemorySuiteSyncRepository implements SuiteSyncRepository {
  runs: SuiteSyncRunRecord[] = [];
  suites: WdtSuitePayload[] = [];
  latestSuccess?: SuiteSyncRunRecord;

  async createSuiteSyncRun(input: Parameters<SuiteSyncRepository["createSuiteSyncRun"]>[0]) {
    const run: SuiteSyncRunRecord = {
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

  async finishSuiteSyncRun(runId: string, patch: Parameters<SuiteSyncRepository["finishSuiteSyncRun"]>[1]) {
    const index = this.runs.findIndex((run) => run.id === runId);
    const next = { ...this.runs[index], ...patch };
    this.runs[index] = next;
    if (next.status === "success") this.latestSuccess = next;
    return next;
  }

  async getLatestSuccessfulSuiteSyncRun() {
    return this.latestSuccess;
  }

  async upsertSuites(suites: WdtSuitePayload[]) {
    for (const suite of suites) {
      const index = this.suites.findIndex((item) => item.suiteNo === suite.suiteNo);
      if (index >= 0) this.suites[index] = suite;
      else this.suites.push(suite);
    }
    return suites.length;
  }
}
