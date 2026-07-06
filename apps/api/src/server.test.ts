import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createDatabaseContext } from "./db/client.js";
import { batches, productMatchCandidates, wdtGoodsSpecs, wdtGoodsSyncRuns } from "./db/schema.js";
import { buildApiServer } from "./server.js";
import type { StockLookupClient } from "./store.js";
import type { WdtGoodsWindowClient } from "./wdtGoodsSync.js";

const orderFile = "ole案例文件——发货前/1订货单/订货通知单 .xls";
const projectRoot = resolve(process.cwd(), "../..");

describe("api server", () => {
  it("responds to health checks", async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "jy-trade-api" });
    await app.close();
  });

  it("creates a batch and runs mock review", async () => {
    const app = buildTestServer();
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFile, mode: "mock" },
      headers: { cookie },
    });
    expect(created.statusCode).toBe(201);
    const batch = created.json();

    const review = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/run-mock-review`,
      payload: { mockDataFile: "examples/mock_flow_data.json" },
      headers: { cookie },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().batch.orderLineCount).toBe(40);

    const lines = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(lines.statusCode).toBe(200);
    expect(lines.json()).toHaveLength(40);
    await app.close();
  });

  it("uploads an order file for browser imports", async () => {
    const app = buildTestServer();
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/order-files",
      payload: {
        fileName: "订货通知单.xlsx",
        contentBase64: Buffer.from("test file").toString("base64"),
      },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      fileName: "订货通知单.xlsx",
    });
    expect(response.json().filePath).toContain("inputs");
    await app.close();
  });

  it("logs in, returns current user, and logs out", async () => {
    const app = buildTestServer();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "admin123" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.username).toBe("admin");
    const cookie = login.headers["set-cookie"];
    expect(cookie).toContain("jy_trade_session=");

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: String(cookie) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("admin");

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: String(cookie) },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: String(cookie) },
    });
    expect(afterLogout.json().user).toBeNull();
    await app.close();
  });

  it("bootstraps fixed operator and reviewer accounts", async () => {
    const app = buildTestServer();

    const operator = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "operator", password: "operator123" },
    });
    expect(operator.statusCode).toBe(200);
    expect(operator.json().user.role).toBe("operator");

    const reviewer = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "reviewer", password: "reviewer123" },
    });
    expect(reviewer.statusCode).toBe(200);
    expect(reviewer.json().user.role).toBe("reviewer");
    await app.close();
  });

  it("enforces role permissions on write operations", async () => {
    const app = buildTestServer();
    const reviewerCookie = await loginCookie(app, "reviewer", "reviewer123");
    const operatorCookie = await loginCookie(app, "operator", "operator123");

    const reviewerCreate = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFile, mode: "mock" },
      headers: { cookie: reviewerCookie },
    });
    expect(reviewerCreate.statusCode).toBe(403);
    expect(reviewerCreate.json().message).toBe("当前账号没有执行此操作的权限");

    const operatorCreate = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFile, mode: "mock" },
      headers: { cookie: operatorCookie },
    });
    expect(operatorCreate.statusCode).toBe(201);
    const batch = operatorCreate.json();

    const operatorSubmit = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/submit-review`,
      headers: { cookie: operatorCookie },
    });
    expect(operatorSubmit.statusCode).toBe(403);

    const reviewerSubmit = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/submit-review`,
      headers: { cookie: reviewerCookie },
    });
    expect(reviewerSubmit.statusCode).toBe(200);
    await app.close();
  });

  it("rejects protected endpoints without a session", async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: "GET", url: "/api/v1/batches" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "Unauthorized" });
    await app.close();
  });

  it("persists batches, review lines, and review decisions across server instances", async () => {
    const databaseUrl = testDatabaseUrl();
    const firstServer = buildTestServer(databaseUrl);
    const firstCookie = await loginCookie(firstServer);
    const created = await firstServer.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFile, mode: "mock" },
      headers: { cookie: firstCookie },
    });
    const batch = created.json();

    await firstServer.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/run-mock-review`,
      payload: { mockDataFile: "examples/mock_flow_data.json" },
      headers: { cookie: firstCookie },
    });
    const linesResponse = await firstServer.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/review-lines`,
      headers: { cookie: firstCookie },
    });
    const [firstLine] = linesResponse.json();
    expect(firstLine).toBeTruthy();

    const decisionResponse = await firstServer.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: { decision: "do_not_ship", approvedShipQty: 0, reason: "测试不发" },
      headers: { cookie: firstCookie },
    });
    expect(decisionResponse.statusCode).toBe(200);
    await firstServer.close();

    const secondServer = buildTestServer(databaseUrl);
    const secondCookie = await loginCookie(secondServer);
    const persistedBatch = await secondServer.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}`,
      headers: { cookie: secondCookie },
    });
    expect(persistedBatch.statusCode).toBe(200);
    expect(persistedBatch.json().orderLineCount).toBe(40);

    const persistedLines = await secondServer.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/review-lines`,
      headers: { cookie: secondCookie },
    });
    const persistedFirstLine = persistedLines.json().find((line: { id: string }) => line.id === firstLine.id);
    expect(persistedFirstLine.decision).toBe("do_not_ship");
    expect(persistedFirstLine.reason).toBe("测试不发");
    await secondServer.close();
  });

  it("validates review decisions", async () => {
    const app = buildTestServer();
    const { batch, firstLine, cookie } = await createReviewedBatch(app);

    const negativeQty = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: { decision: "ship", approvedShipQty: -1, reason: "" },
      headers: { cookie },
    });
    expect(negativeQty.statusCode).toBe(400);

    const doNotShipWithoutReason = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: { decision: "do_not_ship", approvedShipQty: 0, reason: "" },
      headers: { cookie },
    });
    expect(doNotShipWithoutReason.statusCode).toBe(200);

    const overSuggestedWithoutReason = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: { decision: "ship", approvedShipQty: firstLine.suggestedShipQty + 1, reason: "" },
      headers: { cookie },
    });
    expect(overSuggestedWithoutReason.statusCode).toBe(200);

    const overSuggestedWithReason = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: { decision: "ship", approvedShipQty: firstLine.suggestedShipQty + 1, reason: "人工确认额外库存" },
      headers: { cookie },
    });
    expect(overSuggestedWithReason.statusCode).toBe(200);
    expect(overSuggestedWithReason.json()).toMatchObject({
      decision: "ship",
      approvedShipQty: firstLine.suggestedShipQty + 1,
      reason: "人工确认额外库存",
    });
    await app.close();
  });

  it("updates priority lines with review permissions and sorts them first", async () => {
    const app = buildTestServer();
    const { batch, lines, cookie } = await createReviewedBatch(app);
    const targetLine = lines[1];

    const updatedWithoutReason = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${targetLine.id}/priority`,
      payload: { priority: true, reason: "" },
      headers: { cookie },
    });
    expect(updatedWithoutReason.statusCode).toBe(200);
    expect(updatedWithoutReason.json()).toMatchObject({ id: targetLine.id, priority: true, priorityReason: "" });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${targetLine.id}/priority`,
      payload: { priority: true, reason: "门店急用" },
      headers: { cookie },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: targetLine.id, priority: true, priorityReason: "门店急用" });

    const sorted = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(sorted.statusCode).toBe(200);
    expect(sorted.json()[0]).toMatchObject({ id: targetLine.id, priority: true });
    await app.close();
  });

  it("reads priority data from databases that already had is_priority columns", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.client.execute("alter table review_lines add column is_priority integer not null default 0");
    await database.close();

    const app = buildTestServer(databaseUrl);
    const { batch, lines, cookie } = await createReviewedBatch(app);
    await app.close();

    const seededDatabase = createDatabaseContext(databaseUrl);
    await seededDatabase.ready;
    await seededDatabase.client.execute({
      sql: "update review_lines set is_priority = 1, priority_reason = '历史优先' where id = ?",
      args: [lines[1].id],
    });
    await seededDatabase.close();

    const restarted = buildTestServer(databaseUrl);
    const restartedCookie = await loginCookie(restarted);
    const response = await restarted.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/review-lines`,
      headers: { cookie: restartedCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ id: lines[1].id, priority: true, priorityReason: "历史优先" });
    await restarted.close();
  });

  it("rejects priority updates from operator accounts", async () => {
    const app = buildTestServer();
    const { batch, firstLine } = await createReviewedBatch(app);
    const operatorCookie = await loginCookie(app, "operator", "operator123");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/priority`,
      payload: { priority: true, reason: "门店急用" },
      headers: { cookie: operatorCookie },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("bulk approves matched ready and partial lines only", async () => {
    const app = buildTestServer();
    const { batch, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json");

    const bulkApprove = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/bulk-approve`,
      headers: { cookie },
    });
    expect(bulkApprove.statusCode).toBe(200);
    expect(bulkApprove.json().updatedCount).toBe(2);

    const lines = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/review-lines`,
      headers: { cookie },
    });
    const approved = lines.json().filter((line: { decision: string }) => line.decision === "ship");
    expect(approved).toHaveLength(2);
    expect(approved.every((line: { matchStatus: string }) => line.matchStatus === "matched")).toBe(true);
    await app.close();
  });

  it("submits review and allows pending lines", async () => {
    const app = buildTestServer();
    const { batch, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json");

    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/submit-review`,
      headers: { cookie },
    });

    expect(submit.statusCode).toBe(200);
    expect(submit.json().batch.status).toBe("reviewed");
    expect(submit.json().pendingCount).toBeGreaterThan(0);

    const persistedBatch = await app.inject({ method: "GET", url: `/api/v1/batches/${batch.id}`, headers: { cookie } });
    expect(persistedBatch.json().status).toBe("reviewed");
    await app.close();
  });

  it("creates downloadable export files for a reviewed batch", async () => {
    const app = buildTestServer();
    const { batch, cookie } = await createReviewedBatch(app);

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/exports`,
      payload: { type: "review" },
      headers: { cookie },
    });

    expect(exportResponse.statusCode).toBe(201);
    expect(exportResponse.json()).toMatchObject({
      batchId: batch.id,
      type: "review",
      status: "ready",
      createdByUsername: "admin",
    });
    expect(exportResponse.json().downloadUrl).toContain("/download");

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/exports`,
      headers: { cookie },
    });
    expect(listResponse.json()).toHaveLength(1);

    const downloadResponse = await app.inject({
      method: "GET",
      url: exportResponse.json().downloadUrl,
      headers: { cookie },
    });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.headers["content-type"]).toContain("spreadsheetml");
    expect(downloadResponse.body.length).toBeGreaterThan(100);
    await app.close();
  });

  it("runs WDT goods sync and searches cached specs", async () => {
    const app = buildTestServer(testDatabaseUrl(), {
      async queryGoodsWindow({ pageSize }) {
        expect(pageSize).toBe(500);
        return {
          totalCount: 1,
          goods: [
            {
              goods_no: "G1",
              goods_name: "雅漾专研保湿修护面膜",
              spec_list: [
                {
                  spec_no: "3282770392869",
                  spec_name: "25ml*5",
                  barcode: "3282770392869",
                  barcode_list: [{ barcode: "3282770392869", is_master: 1 }],
                },
              ],
            },
          ],
        };
      },
    });
    const cookie = await loginCookie(app);

    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/wdt/goods-sync-runs",
      payload: { mode: "full", startDate: "2026-01-01", endDate: "2026-01-01" },
      headers: { cookie },
    });
    expect(sync.statusCode).toBe(201);
    expect(sync.json()).toMatchObject({ mode: "full", status: "success", fetchedCount: 1, upsertedCount: 1 });

    const latest = await app.inject({
      method: "GET",
      url: "/api/v1/wdt/goods-sync-runs/latest",
      headers: { cookie },
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().status).toBe("success");

    const search = await app.inject({
      method: "GET",
      url: "/api/v1/wdt/goods-specs/search?query=雅漾",
      headers: { cookie },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()[0]).toMatchObject({
      goodsName: "雅漾专研保湿修护面膜",
      specNo: "3282770392869",
      barcodes: ["3282770392869"],
    });
    await app.close();
  });

  it("confirms and updates product mappings", async () => {
    const app = buildTestServer(testDatabaseUrl(), {
      async queryGoodsWindow() {
        return {
          totalCount: 1,
          goods: [
            {
              goods_no: "3282770392869",
              goods_name: "雅漾专研保湿修护面膜",
              spec_list: [
                {
                  spec_no: "3282770392869",
                  spec_name: "25ml*5",
                  barcode: "3282770392869",
                  barcode_list: [{ barcode: "3282770392869", is_master: 1 }],
                },
              ],
            },
          ],
        };
      },
    });
    const cookie = await loginCookie(app);
    await app.inject({
      method: "POST",
      url: "/api/v1/wdt/goods-sync-runs",
      payload: { mode: "full", startDate: "2026-01-01", endDate: "2026-01-01" },
      headers: { cookie },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/product-mappings",
      payload: {
        externalBarcode: "2153722460015",
        externalGoodsCode: "5372246",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        wdtSpecNo: "3282770392869",
        note: "manual confirmation from diagnosis",
      },
      headers: { cookie },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      externalBarcode: "2153722460015",
      wdtSpecNo: "3282770392869",
      status: "confirmed",
      confirmedByUserId: expect.any(String),
    });

    const list = await app.inject({ method: "GET", url: "/api/v1/product-mappings?query=2153722460015", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/v1/product-mappings/${created.json().id}/status`,
      payload: { status: "disabled", note: "wrong mapping" },
      headers: { cookie },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ status: "disabled", note: "wrong mapping" });
    await app.close();
  });

  it("lists product match candidates for mapping confirmation", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db.insert(productMatchCandidates).values({
      id: `candidate-${randomUUID()}`,
      batchId: "diagnosis-order",
      reviewLineId: "line-1",
      externalBarcode: "2153722460015",
      externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
      externalGoodsCode: "5372246",
      wdtSpecNo: "3282770392869",
      wdtGoodsNo: "3282770392869",
      wdtGoodsName: "雅漾专研保湿修护面膜",
      wdtSpecName: "25ml*5",
      wdtBarcode: "3282770392869",
      score: 82,
      basis: "contains_name",
      source: "goods",
      createdAt: "2026-07-03T00:00:00.000Z",
    });
    await database.close();
    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/product-match-candidates?query=2153722460015",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        externalBarcode: "2153722460015",
        wdtSpecNo: "3282770392869",
        score: 82,
        basis: "contains_name",
      }),
    ]);
    await app.close();
  });

  it("runs real review from cached goods specs and read-only WDT stock", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await database.close();

    const stockClient: StockLookupClient = {
      async queryStock(specNo) {
        expect(specNo).toBe("3282770392869");
        return {
          status: 0,
          data: {
            total_count: 2,
            detail_list: [
              { spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 15 },
              { spec_no: specNo, warehouse_no: "LINQI", warehouse_name: "临期仓", available_send_stock: 5 },
            ],
          },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFile, mode: "production_api" },
      headers: { cookie },
    });
    const batch = created.json();

    const review = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/run-real-review`,
      payload: {},
      headers: { cookie },
    });

    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ batch: { status: "review_generated", orderLineCount: 40 }, stockQueriedCount: 1 });

    const lines = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/review-lines`,
      headers: { cookie },
    });
    const matched = lines.json().filter((line: { wdtSpecNo: string }) => line.wdtSpecNo === "3282770392869");
    expect(matched.length).toBeGreaterThan(1);
    expect(matched[0]).toMatchObject({ matchStatus: "matched", mainAvailableBefore: 15 });
    expect(matched[1].mainAvailableBefore).toBeLessThanOrEqual(15);
    await app.close();
  });

  it("blocks real review when latest goods sync failed", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db.insert(wdtGoodsSyncRuns).values({
      id: "wdt-goods-sync-failed",
      mode: "full",
      status: "failed",
      startedAt: "2026-07-03T00:00:00.000Z",
      finishedAt: "2026-07-03T00:01:00.000Z",
      rangeStart: "2026-06-01T00:00:00.000Z",
      rangeEnd: "2026-07-03T00:00:00.000Z",
      windowCount: 1,
      pageCount: 1,
      fetchedCount: 0,
      upsertedCount: 0,
      errorMessage: "fetch failed",
    });
    await database.close();
    const app = buildTestServer(databaseUrl, undefined, fakeStockClient());
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFile, mode: "production_api" },
      headers: { cookie },
    });

    const review = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${created.json().id}/actions/run-real-review`,
      payload: {},
      headers: { cookie },
    });

    expect(review.statusCode).toBe(400);
    expect(review.json().message).toContain("latest goods sync is not success");
    await app.close();
  });

  it("rejects WDT goods sync when client is not configured", async () => {
    const app = buildTestServer();
    const cookie = await loginCookie(app);
    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/wdt/goods-sync-runs",
      payload: { mode: "incremental" },
      headers: { cookie },
    });
    expect(sync.statusCode).toBe(400);
    expect(sync.json().message).toContain("client is not configured");
    await app.close();
  });
});

function buildTestServer(databaseUrl = testDatabaseUrl(), wdtGoodsClient?: WdtGoodsWindowClient, stockClient?: StockLookupClient) {
  return buildApiServer({ databaseUrl, projectRoot, logger: false, wdtGoodsClient, stockClient });
}

function testDatabaseUrl() {
  return `file:../../outputs/api-test-${randomUUID()}.db`;
}

async function createReviewedBatch(app: ReturnType<typeof buildApiServer>, mockDataFile = "examples/mock_flow_data.json") {
  const cookie = await loginCookie(app);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/batches",
    payload: { filePath: orderFile, mode: "mock" },
    headers: { cookie },
  });
  const batch = created.json();
  await app.inject({
    method: "POST",
    url: `/api/v1/batches/${batch.id}/actions/run-mock-review`,
    payload: { mockDataFile },
    headers: { cookie },
  });
  const linesResponse = await app.inject({
    method: "GET",
    url: `/api/v1/batches/${batch.id}/review-lines`,
    headers: { cookie },
  });
  const lines = linesResponse.json();
  return { batch, lines, firstLine: lines[0], cookie };
}

async function loginCookie(app: ReturnType<typeof buildApiServer>, username = "admin", password = "admin123") {
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  return String(login.headers["set-cookie"]);
}

async function seedSuccessfulGoodsCache(database: ReturnType<typeof createDatabaseContext>) {
  const now = "2026-07-03T00:00:00.000Z";
  await database.db.insert(wdtGoodsSyncRuns).values({
    id: "wdt-goods-sync-success",
    mode: "full",
    status: "success",
    startedAt: now,
    finishedAt: now,
    rangeStart: "2026-06-01T00:00:00.000Z",
    rangeEnd: now,
    windowCount: 1,
    pageCount: 1,
    fetchedCount: 1,
    upsertedCount: 1,
    errorMessage: "",
  });
  await database.db.insert(wdtGoodsSpecs).values({
    id: "wdt-goods-spec-3282770392869",
    goodsNo: "3282770392869",
    goodsName: "雅漾专研保湿修护面膜",
    specNo: "3282770392869",
    specName: "25ml*5",
    specCode: "",
    barcode: "2153722460015",
    barcodesJson: JSON.stringify(["2153722460015", "3282770392869"]),
    deleted: 0,
    modified: now,
    rawJson: "{}",
    syncedAt: now,
  });
}

function fakeStockClient(): StockLookupClient {
  return {
    async queryStock() {
      return { status: 0, data: { total_count: 0, detail_list: [] } };
    },
  };
}
