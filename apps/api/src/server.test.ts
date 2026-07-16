import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createSampleOrderFile } from "@jy-trade/workflow";
import type { ReviewLineDto } from "@jy-trade/shared";

import { createDatabaseContext } from "./db/client.js";
import {
  auditLogs,
  batches,
  externalProductComponents,
  externalProducts,
  exportsTable,
  productMatchCandidates,
  reviewDecisions,
  reviewLines,
  storeAddresses,
  wdtGoodsSpecs,
  wdtGoodsSyncRuns,
  wdtStockSnapshotRows,
  wdtStockSnapshotSpecs,
  wdtStockSnapshotWarehouseCoverage,
  wdtSuiteComponents,
  wdtSuites,
  wdtSyncRuns,
} from "./db/schema.js";
import { buildApiServer } from "./server.js";
import { millisecondsUntilNextShanghaiHour, millisecondsUntilNextShanghaiSyncBoundary, snapshotIsOlderThan, type StockLookupClient, type StoreOptions } from "./store.js";
import type { WdtGoodsWindowClient } from "./wdtGoodsSync.js";

const projectRoot = resolve(process.cwd(), "../..");
const orderFile = createSampleOrderFile(resolve(projectRoot, "outputs/fixtures/sample-order.xlsx"));
const mixedOrderFile = createSampleOrderFile(resolve(projectRoot, "outputs/fixtures/sample-order-mixed.xlsx"), 4);

describe("api server", () => {
  beforeEach(() => {
    clearRuntimeEnvForTests();
  });

  it("responds to health checks", async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "jy-trade-api" });
    await app.close();
  });

  it("schedules configured sync intervals on Asia/Shanghai natural boundaries and evaluates snapshot age", () => {
    const beforeBoundary = Date.parse("2026-07-11T03:59:59.500Z"); // 11:59:59.500 in Shanghai
    expect(millisecondsUntilNextShanghaiHour(beforeBoundary)).toBe(500);
    const atBoundary = Date.parse("2026-07-11T04:00:00.000Z"); // 12:00 in Shanghai
    expect(millisecondsUntilNextShanghaiHour(atBoundary)).toBe(60 * 60 * 1_000);
    expect(millisecondsUntilNextShanghaiSyncBoundary(atBoundary, 2)).toBe(2 * 60 * 60 * 1_000);
    expect(millisecondsUntilNextShanghaiSyncBoundary(atBoundary, 6)).toBe(6 * 60 * 60 * 1_000);
    expect(millisecondsUntilNextShanghaiSyncBoundary(atBoundary, 24)).toBe(12 * 60 * 60 * 1_000);
    expect(snapshotIsOlderThan("2026-07-11T03:00:00.000Z", atBoundary)).toBe(false);
    expect(snapshotIsOlderThan("2026-07-11T02:59:59.999Z", atBoundary)).toBe(true);
    expect(snapshotIsOlderThan("invalid", atBoundary)).toBe(true);
  });

  it("allows the trial deployment to use the default admin password in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.JY_TRADE_BOOTSTRAP_PASSWORD;
    const app = buildTestServer();

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "yjmy" },
    });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  it("only bootstraps the configured admin account in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.JY_TRADE_BOOTSTRAP_USERNAME = "release-admin";
    process.env.JY_TRADE_BOOTSTRAP_PASSWORD = "correct-horse-battery-staple";
    const app = buildTestServer();

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "release-admin", password: "correct-horse-battery-staple" },
    });
    expect(adminLogin.statusCode).toBe(200);

    for (const [username, password] of [["operator", "operator123"], ["reviewer", "reviewer123"]]) {
      const demoLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password },
      });
      expect(demoLogin.statusCode).toBe(401);
    }

    await app.close();
  });

  it("synchronizes the configured production admin password for an existing database", async () => {
    const databaseUrl = testDatabaseUrl();
    const developmentApp = buildTestServer(databaseUrl);
    const initialLogin = await developmentApp.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "yjmy" },
    });
    expect(initialLogin.statusCode).toBe(200);
    await developmentApp.close();

    process.env.NODE_ENV = "production";
    process.env.JY_TRADE_BOOTSTRAP_USERNAME = "admin";
    process.env.JY_TRADE_BOOTSTRAP_PASSWORD = "new-production-password";
    const productionApp = buildTestServer(databaseUrl);

    const updatedLogin = await productionApp.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "new-production-password" },
    });
    expect(updatedLogin.statusCode).toBe(200);

    const oldLogin = await productionApp.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "yjmy" },
    });
    expect(oldLogin.statusCode).toBe(401);
    await productionApp.close();
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

  it("uses configured runtime directories for uploads and exports", async () => {
    const previousUploadDir = process.env.JY_TRADE_UPLOAD_DIR;
    const previousExportsDir = process.env.JY_TRADE_EXPORTS_DIR;
    const runtimeRoot = resolve(projectRoot, "outputs", `runtime-dirs-${randomUUID()}`);
    const uploadDir = resolve(runtimeRoot, "uploads");
    const exportsDir = resolve(runtimeRoot, "exports");
    process.env.JY_TRADE_UPLOAD_DIR = uploadDir;
    process.env.JY_TRADE_EXPORTS_DIR = exportsDir;

    try {
      const databaseUrl = testDatabaseUrl();
      const app = buildTestServer(databaseUrl);
      const cookie = await loginCookie(app);
      const upload = await app.inject({
        method: "POST",
        url: "/api/v1/order-files",
        payload: {
          fileName: "订货通知单.xlsx",
          contentBase64: Buffer.from("test file").toString("base64"),
        },
        headers: { cookie },
      });

      expect(upload.statusCode).toBe(201);
      expect(upload.json().filePath).toContain(uploadDir);
      expect(existsSync(upload.json().filePath)).toBe(true);

      const { batch } = await createReviewedBatch(app);
      const exportResponse = await app.inject({
        method: "POST",
        url: `/api/v1/batches/${batch.id}/exports`,
        payload: { type: "review" },
        headers: { cookie },
      });
      expect(exportResponse.statusCode).toBe(201);

      const database = createDatabaseContext(databaseUrl);
      await database.ready;
      const [exportRow] = await database.db.select().from(exportsTable).where(eq(exportsTable.id, exportResponse.json().id)).limit(1);
      await database.close();
      expect(exportRow.filePath).toContain(exportsDir);
      expect(existsSync(exportRow.filePath)).toBe(true);

      await app.close();
    } finally {
      if (previousUploadDir === undefined) {
        delete process.env.JY_TRADE_UPLOAD_DIR;
      } else {
        process.env.JY_TRADE_UPLOAD_DIR = previousUploadDir;
      }
      if (previousExportsDir === undefined) {
        delete process.env.JY_TRADE_EXPORTS_DIR;
      } else {
        process.env.JY_TRADE_EXPORTS_DIR = previousExportsDir;
      }
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("logs in, returns current user, and logs out", async () => {
    const app = buildTestServer();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "yjmy" },
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

  it("lets admins delete batches and cleans related runtime data", async () => {
    const databaseUrl = testDatabaseUrl();
    const app = buildTestServer(databaseUrl);
    const { batch, firstLine, cookie } = await createReviewedBatch(app);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: { decision: "do_not_ship", approvedShipQty: 0, reason: "测试不发" },
      headers: { cookie },
    });
    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/exports`,
      payload: { type: "review" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);

    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    const [exportRow] = await database.db.select().from(exportsTable).where(eq(exportsTable.batchId, batch.id));
    expect(exportRow).toBeTruthy();
    expect(existsSync(exportRow.filePath)).toBe(true);
    await database.close();

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/batches/${batch.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ batchId: batch.id, deleted: true });

    const afterDatabase = createDatabaseContext(databaseUrl);
    await afterDatabase.ready;
    expect(await afterDatabase.db.select().from(batches).where(eq(batches.id, batch.id))).toHaveLength(0);
    expect(await afterDatabase.db.select().from(reviewLines).where(eq(reviewLines.batchId, batch.id))).toHaveLength(0);
    expect(await afterDatabase.db.select().from(reviewDecisions).where(eq(reviewDecisions.batchId, batch.id))).toHaveLength(0);
    expect(await afterDatabase.db.select().from(exportsTable).where(eq(exportsTable.batchId, batch.id))).toHaveLength(0);
    const logs = await afterDatabase.db.select().from(auditLogs).where(eq(auditLogs.action, "batch.delete"));
    expect(logs.some((log) => log.entityId === batch.id)).toBe(true);
    await afterDatabase.close();
    expect(existsSync(exportRow.filePath)).toBe(false);
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

    const operatorDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/batches/${batch.id}`,
      headers: { cookie: operatorCookie },
    });
    expect(operatorDelete.statusCode).toBe(403);

    const reviewerDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/batches/${batch.id}`,
      headers: { cookie: reviewerCookie },
    });
    expect(reviewerDelete.statusCode).toBe(403);

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
    const databaseUrl = testDatabaseUrl();
    const app = buildTestServer(databaseUrl);
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

    const positiveQtyNormalizesToShip = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: {
        decision: "do_not_ship",
        approvedShipQty: 1,
        fulfillmentWarehouseNo: firstLine.suggestedWarehouseNo,
        fulfillmentWarehouseName: firstLine.suggestedWarehouseName,
        reason: "最终数量优先",
      },
      headers: { cookie },
    });
    expect(positiveQtyNormalizesToShip.statusCode).toBe(200);
    expect(positiveQtyNormalizesToShip.json()).toMatchObject({
      decision: "ship",
      approvedShipQty: 1,
      fulfillmentWarehouseNo: firstLine.suggestedWarehouseNo,
      fulfillmentWarehouseName: firstLine.suggestedWarehouseName,
    });

    const shipWithoutWarehouse = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: { decision: "ship", approvedShipQty: firstLine.suggestedShipQty, reason: "" },
      headers: { cookie },
    });
    expect(shipWithoutWarehouse.statusCode).toBe(200);
    const submitWithoutWarehouse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false },
      headers: { cookie },
    });
    expect(submitWithoutWarehouse.statusCode).toBe(400);
    expect(submitWithoutWarehouse.json().message).toContain("未选择仓库");

    const overSuggestedWithoutReason = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: firstLine.suggestedShipQty + 1,
        fulfillmentWarehouseNo: firstLine.suggestedWarehouseNo,
        fulfillmentWarehouseName: firstLine.suggestedWarehouseName,
        reason: "",
      },
      headers: { cookie },
    });
    expect(overSuggestedWithoutReason.statusCode).toBe(200);

    const overSuggestedWithReason = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${firstLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: firstLine.suggestedShipQty + 1,
        fulfillmentWarehouseNo: firstLine.suggestedWarehouseNo,
        fulfillmentWarehouseName: firstLine.suggestedWarehouseName,
        reason: "人工确认额外库存",
      },
      headers: { cookie },
    });
    expect(overSuggestedWithReason.statusCode).toBe(200);
    expect(overSuggestedWithReason.json()).toMatchObject({
      decision: "ship",
      approvedShipQty: firstLine.suggestedShipQty + 1,
      reason: "人工确认额外库存",
    });
    await app.close();
    const auditDatabase = createDatabaseContext(databaseUrl);
    await auditDatabase.ready;
    const decisionLogs = await auditDatabase.db.select().from(auditLogs).where(eq(auditLogs.action, "review_line.update_decision"));
    expect(decisionLogs.some((log) => {
      const payload = JSON.parse(log.payloadJson) as { next?: { fulfillmentWarehouseNo?: string; fulfillmentWarehouseName?: string } };
      return payload.next?.fulfillmentWarehouseNo === firstLine.suggestedWarehouseNo
        && payload.next?.fulfillmentWarehouseName === firstLine.suggestedWarehouseName;
    })).toBe(true);
    await auditDatabase.close();
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

  it("gets and updates warehouse usage settings for admins only", async () => {
    const app = buildTestServer();
    const adminCookie = await loginCookie(app);
    const operatorCookie = await loginCookie(app, "operator", "operator123");

    const defaults = await app.inject({
      method: "GET",
      url: "/api/v1/settings/warehouse-usage",
      headers: { cookie: operatorCookie },
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({
      includeMainWarehouse: true,
      includeNearExpiryWarehouse: true,
      includeDefectWarehouse: false,
      includeOtherWarehouses: false,
    });

    const forbidden = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/warehouse-usage",
      payload: {
        includeMainWarehouse: true,
        includeNearExpiryWarehouse: false,
        includeDefectWarehouse: false,
        includeOtherWarehouses: true,
      },
      headers: { cookie: operatorCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/warehouse-usage",
      payload: {
        includeMainWarehouse: true,
        includeNearExpiryWarehouse: false,
        includeDefectWarehouse: false,
        includeOtherWarehouses: true,
      },
      headers: { cookie: adminCookie },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      includeMainWarehouse: true,
      includeNearExpiryWarehouse: false,
      includeDefectWarehouse: false,
      includeOtherWarehouses: true,
      updatedByUsername: "admin",
    });
    await app.close();
  });

  it("gets and updates the WDT automatic sync interval for admins only", async () => {
    const app = buildTestServer();
    const adminCookie = await loginCookie(app);
    const operatorCookie = await loginCookie(app, "operator", "operator123");

    const defaults = await app.inject({ method: "GET", url: "/api/v1/settings/wdt-sync", headers: { cookie: operatorCookie } });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({ intervalHours: 1, autoSyncEnabled: false });

    const forbidden = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/wdt-sync",
      payload: { intervalHours: 6 },
      headers: { cookie: operatorCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/wdt-sync",
      payload: { intervalHours: 3 },
      headers: { cookie: adminCookie },
    });
    expect(invalid.statusCode).toBe(400);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/wdt-sync",
      payload: { intervalHours: 6 },
      headers: { cookie: adminCookie },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ intervalHours: 6, autoSyncEnabled: false, updatedByUsername: "admin" });
    await app.close();
  });

  it("migrates legacy warehouse usage settings from app_settings", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.client.execute(`
      create table if not exists app_settings (
        key text primary key not null,
        value_json text not null,
        updated_at text not null,
        updated_by_user_id text
      )
    `);
    await database.client.execute({
      sql: "insert into app_settings (key, value_json, updated_at, updated_by_user_id) values (?, ?, ?, ?)",
      args: [
        "warehouse_usage",
        JSON.stringify({ enabledBuckets: { main: true, nearExpiry: false, defect: true, other: true } }),
        "2026-07-06T08:05:26.244Z",
        "legacy-user",
      ],
    });
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings/warehouse-usage",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      includeMainWarehouse: true,
      includeNearExpiryWarehouse: false,
      includeDefectWarehouse: true,
      includeOtherWarehouses: true,
      updatedByUserId: "legacy-user",
    });
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
    expect(approved.every((line: { suggestedWarehouseNo: string; fulfillmentWarehouseNo: string }) =>
      line.fulfillmentWarehouseNo === line.suggestedWarehouseNo && Boolean(line.fulfillmentWarehouseNo))).toBe(true);
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

  it("allows explicitly confirmed unmapped lines and exports their imported goods code", async () => {
    const databaseUrl = testDatabaseUrl();
    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: mixedOrderFile, mode: "mock" },
      headers: { cookie },
    });
    const batchId = created.json().id;
    await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batchId}/actions/run-mock-review`,
      payload: { mockDataFile: "examples/mock_flow_mixed.json" },
      headers: { cookie },
    });
    const initialLines = await app.inject({ method: "GET", url: `/api/v1/batches/${batchId}/review-lines`, headers: { cookie } });
    let lines = initialLines.json();
    const unmappedLine = lines.find((line: { matchStatus: string; externalGoodsCode: string }) =>
      line.matchStatus === "not_found" && Boolean(line.externalGoodsCode));
    const barcodeFallbackLine = lines.find((line: { matchStatus: string; externalBarcode: string }) =>
      line.matchStatus === "ambiguous" && Boolean(line.externalBarcode));
    expect(unmappedLine).toBeTruthy();
    expect(barcodeFallbackLine).toBeTruthy();

    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db.update(reviewLines).set({ externalGoodsCode: "" }).where(eq(reviewLines.id, barcodeFallbackLine.id));
    await database.close();
    const refreshedLines = await app.inject({ method: "GET", url: `/api/v1/batches/${batchId}/review-lines`, headers: { cookie } });
    lines = refreshedLines.json();

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batchId}/review-lines/${unmappedLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 2,
        fulfillmentWarehouseNo: "001",
        fulfillmentWarehouseName: "主仓",
        reason: "业务员确认紧急做单",
      },
      headers: { cookie },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ decision: "ship", approvedShipQty: 2, matchStatus: "not_found" });
    const updatedBarcodeFallback = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batchId}/review-lines/${barcodeFallbackLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 1,
        fulfillmentWarehouseNo: "001",
        fulfillmentWarehouseName: "主仓",
        reason: "业务员确认按原始条码做单",
      },
      headers: { cookie },
    });
    expect(updatedBarcodeFallback.statusCode).toBe(200);
    await seedStoreAddresses(app, cookie, lines);

    const warning = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batchId}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false, confirmUnmappedProducts: false },
      headers: { cookie },
    });
    expect(warning.statusCode).toBe(409);
    expect(warning.json()).toMatchObject({
      requiresConfirmation: true,
      code: "UNMAPPED_PRODUCTS",
      affectedCount: 2,
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batchId}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false, confirmUnmappedProducts: true },
      headers: { cookie },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().batch.status).toBe("reviewed");

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batchId}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    const download = await app.inject({ method: "GET", url: exportResponse.json().downloadUrl, headers: { cookie } });
    const workbook = XLSX.read(download.rawPayload, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        商家编码: unmappedLine.externalGoodsCode,
        货品数量: 2,
      }),
      expect.objectContaining({
        商家编码: barcodeFallbackLine.externalBarcode,
        货品数量: 1,
      }),
    ]));

    const matchedLine = lines.find((line: { matchStatus: string; approvedShipQty: number }) =>
      line.matchStatus === "matched" && line.approvedShipQty > 0);
    expect(matchedLine).toBeTruthy();
    const missingCodeDatabase = createDatabaseContext(databaseUrl);
    await missingCodeDatabase.ready;
    await missingCodeDatabase.db.update(reviewLines).set({
      matchStatus: "not_found",
      externalGoodsCode: "",
      externalBarcode: "",
    }).where(eq(reviewLines.id, matchedLine.id));
    await missingCodeDatabase.close();
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batchId}/actions/submit-review`,
      payload: { confirmUnverifiedStock: true, confirmUnmappedProducts: true },
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toContain("没有可用于做单的原始商品编码或条码");
    await app.close();
  });

  it("keeps forced unmapped confirmed-order quantities consistent across all exports", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSuccessfulStockSnapshot(database, { verifiedSpecNos: [] });
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-未映射强制做单.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({
          rows: [{
            noticeNo: "NOTICE-URGENT-SUITE",
            goodsCode: "URGENT-SUITE-CODE",
            barcode: "URGENT-SUITE-BARCODE",
            goodsName: "未映射紧急套盒",
            orderQty: "6",
            shipQty: "6",
          }],
        }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().batch).toMatchObject({ sourceType: "confirmed_order", status: "review_generated" });

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    const [line] = linesResponse.json() as ReviewLineDto[];
    expect(line).toMatchObject({ matchStatus: "not_found", suggestedShipQty: 0, suggestedWarehouseNo: "", approvedShipQty: 0 });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines/${line.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 6,
        fulfillmentWarehouseNo: "001",
        fulfillmentWarehouseName: "主仓",
        reason: "业务员确认紧急做单",
      },
      headers: { cookie },
    });
    expect(updated.statusCode).toBe(200);
    await seedStoreAddresses(app, cookie, [line]);

    const warning = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false, confirmUnmappedProducts: false },
      headers: { cookie },
    });
    expect(warning.statusCode).toBe(409);
    expect(warning.json()).toMatchObject({ requiresConfirmation: true, code: "UNMAPPED_PRODUCTS", affectedCount: 1 });

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false, confirmUnmappedProducts: true },
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);

    const reviewExport = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "review" },
      headers: { cookie },
    });
    const reviewDownload = await app.inject({ method: "GET", url: reviewExport.json().downloadUrl, headers: { cookie } });
    const reviewWorkbook = XLSX.read(reviewDownload.rawPayload, { type: "buffer" });
    const reviewRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(reviewWorkbook.Sheets["订货审批单明细"], { defval: "" });
    expect(reviewRows).toEqual([expect.objectContaining({
      商品编码: "URGENT-SUITE-CODE",
      订货数量: 6,
      发货数量: 6,
      主仓: "",
      临期仓: "",
    })]);

    const confirmedExport = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "confirmed" },
      headers: { cookie },
    });
    const confirmedDownload = await app.inject({ method: "GET", url: confirmedExport.json().downloadUrl, headers: { cookie } });
    const confirmedWorkbook = XLSX.read(confirmedDownload.rawPayload, { type: "buffer" });
    const confirmedRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(confirmedWorkbook.Sheets["订货审批单明细"], { defval: "" });
    expect(confirmedRows).toEqual([expect.objectContaining({
      商品编码: "URGENT-SUITE-CODE",
      发货数量: 6,
      主仓: 6,
      临期仓: "",
    })]);

    const makeOrderExport = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    const makeOrderDownload = await app.inject({ method: "GET", url: makeOrderExport.json().downloadUrl, headers: { cookie } });
    const makeOrderWorkbook = XLSX.read(makeOrderDownload.rawPayload, { type: "buffer" });
    const makeOrderRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(makeOrderWorkbook.Sheets["Sheet1"], { defval: "" });
    expect(makeOrderRows).toEqual([expect.objectContaining({
      商家编码: "URGENT-SUITE-CODE",
      货品数量: 6,
      仓库名称: "主仓",
    })]);
    await app.close();
  });

  it("creates downloadable export files for a reviewed batch", async () => {
    const app = buildTestServer();
    mkdirSync(resolve(projectRoot, "outputs"), { recursive: true });
    const tempOrderFile = resolve(projectRoot, "outputs", `review-export-source-${randomUUID()}.xls`);
    copyFileSync(resolve(projectRoot, orderFile), tempOrderFile);
    const { batch, lines, firstLine, cookie } = await createReviewedBatch(app, "examples/mock_flow_data.json", tempOrderFile);
    unlinkSync(tempOrderFile);

    expect(firstLine.contractPrice).not.toBe("");
    expect(JSON.parse(firstLine.orderRawJson)).toMatchObject({
      订货通知单号: firstLine.orderNoticeNo,
      含税合同进价: firstLine.contractPrice,
    });

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

    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["订货审批单明细"]);
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["订货审批单明细"], { defval: "" });
    const header = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets["订货审批单明细"], { header: 1 })[0];
    expect(header).toEqual([
      "审批单号",
      "通知单号",
      "收货地编码",
      "收货地名称",
      "要货地编码",
      "要货地名称",
      "业务员",
      "物流模式",
      "送货日期",
      "截止日期",
      "商品编码",
      "商品条码",
      "商品名称",
      "规格",
      "运输规格",
      "订货数量",
      "发货数量",
      "订货箱数",
      "合同进价",
      "主仓",
      "临期仓",
    ]);
    expect(rows).toHaveLength(lines.length);
    expect(rows[0]).toMatchObject({
      审批单号: firstLine.orderApprovalNo,
      通知单号: firstLine.orderNoticeNo,
      收货地编码: "",
      收货地名称: firstLine.storeName,
      要货地编码: "",
      要货地名称: firstLine.storeName,
      业务员: firstLine.salesperson,
      物流模式: firstLine.deliveryMode,
      送货日期: "",
      截止日期: firstLine.deadlineDate,
      商品编码: firstLine.externalGoodsCode,
      商品条码: firstLine.externalBarcode,
      商品名称: firstLine.externalGoodsName,
      规格: firstLine.originalSpec,
      运输规格: firstLine.transportSpec,
      订货数量: firstLine.orderQty,
      发货数量: firstLine.approvedShipQty,
      订货箱数: firstLine.orderBoxQty,
      合同进价: firstLine.contractPrice,
      主仓: firstLine.suggestedWarehouseName.includes("主仓") ? firstLine.suggestedShipQty : "",
      临期仓: "",
    });
    await app.close();
  });

  it("creates confirmed shipment exports with only approved shippable lines", async () => {
    const app = buildTestServer();
    const { batch, lines, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json");
    const shipLine = lines.find((line: { decision: string; approvedShipQty: number }) => line.decision === "ship" && line.approvedShipQty > 0);
    const pendingLine = lines.find((line: { decision: string }) => line.decision === "pending");
    expect(shipLine).toBeTruthy();
    expect(pendingLine).toBeTruthy();

    await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${shipLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 3,
        fulfillmentWarehouseNo: shipLine.suggestedWarehouseNo,
        fulfillmentWarehouseName: shipLine.suggestedWarehouseName,
        reason: "",
      },
      headers: { cookie },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${pendingLine.id}/decision`,
      payload: { decision: "do_not_ship", approvedShipQty: 0, reason: "" },
      headers: { cookie },
    });

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/exports`,
      payload: { type: "confirmed" },
      headers: { cookie },
    });

    expect(exportResponse.statusCode).toBe(201);
    expect(exportResponse.json()).toMatchObject({ type: "confirmed", status: "ready" });
    expect(exportResponse.json().fileName).toMatch(/\.xlsx$/);

    const downloadResponse = await app.inject({
      method: "GET",
      url: exportResponse.json().downloadUrl,
      headers: { cookie },
    });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.headers["content-type"]).toContain("spreadsheetml");

    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["订货审批单明细"]);
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["订货审批单明细"], { defval: "" });
    const header = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets["订货审批单明细"], { header: 1 })[0];
    expect(header).toEqual([
      "审批单号",
      "通知单号",
      "收货地编码",
      "收货地名称",
      "业务员",
      "截止日期",
      "商品编码",
      "商品条码",
      "商品名称",
      "规格",
      "订货数量",
      "发货数量",
      "合同进价",
      "主仓",
      "临期仓",
      "备注",
    ]);

    const exportedLine = rows.find((row) => row["通知单号"] === shipLine.orderNoticeNo && row["商品条码"] === shipLine.externalBarcode);
    expect(exportedLine).toMatchObject({
      审批单号: shipLine.orderApprovalNo,
      通知单号: shipLine.orderNoticeNo,
      收货地编码: "",
      收货地名称: shipLine.storeName,
      业务员: shipLine.salesperson,
      截止日期: shipLine.deadlineDate,
      商品编码: shipLine.externalGoodsCode,
      商品条码: shipLine.externalBarcode,
      商品名称: shipLine.externalGoodsName,
      规格: shipLine.originalSpec,
      订货数量: shipLine.orderQty,
      发货数量: 3,
      合同进价: shipLine.contractPrice,
      主仓: 3,
      临期仓: "",
      备注: "",
    });
    expect(rows.some((row) => row["通知单号"] === pendingLine.orderNoticeNo && row["商品条码"] === pendingLine.externalBarcode)).toBe(false);
    await app.close();
  });

  it("requires confirmed-order review submission before exporting final make-order rows", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869");
    await database.db.insert(storeAddresses).values({
      id: "store-address-confirmed-order",
      storeNo: "S001",
      storeName: "Ole确定单门店",
      normalizedStoreName: "ole确定单门店",
      receiver: "确定单收件人",
      phone: "18800005555",
      address: "确定单测试地址",
      isVip: 0,
      note: "",
      sourceSheet: "手工维护",
      sourceRow: 0,
      importedAt: "",
      rawJson: "{}",
      updatedByUserId: null,
      updatedByUsername: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, fixedWarehouseStockClient());
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({ extraFirstSheet: true }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      fileName: "确定单.xlsx",
      sheetName: "确定单",
      parsedRowCount: 2,
      matchedRowCount: 2,
      unmatchedRowCount: 0,
      batch: { status: "review_generated", orderLineCount: 2 },
    });

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(linesResponse.statusCode).toBe(200);
    expect(linesResponse.json()).toHaveLength(2);
    expect(linesResponse.json()[0]).toMatchObject({
      orderNoticeNo: "NOTICE-1",
      decision: "ship",
      approvedShipQty: 2,
      wdtSpecNo: "3282770392869",
    });

    const blockedExport = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(blockedExport.statusCode).toBe(400);
    expect(blockedExport.json().message).toContain("提交审核");

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false },
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().batch.status).toBe("reviewed");

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    expect(exportResponse.json()).toMatchObject({ type: "wdt_import", status: "ready" });
    expect(exportResponse.json().fileName).toMatch(/\.xlsx$/);

    const downloadResponse = await app.inject({
      method: "GET",
      url: exportResponse.json().downloadUrl,
      headers: { cookie },
    });
    expect(downloadResponse.headers["content-type"]).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["Sheet1", "不做单表"]);
    expect(workbook.Sheets["Sheet1"]["!autofilter"]).toEqual({ ref: workbook.Sheets["Sheet1"]["!ref"] });
    expect(workbook.Sheets["不做单表"]["!ref"]).toBe("A1:AW1");
    expect(workbook.Sheets["不做单表"]["!autofilter"]).toEqual({ ref: "A1:AW1" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row["原始单号"]))).toHaveLength(1);
    for (const row of rows) {
      expect(String(row["原始单号"])).toMatch(/^JY\d{6}[A-Z0-9]{8}$/);
      expect(row).toMatchObject({
        收件人: "确定单收件人",
        手机: "18800005555",
        地址: "确定单测试地址",
        客服备注: "NOTICE-1、NOTICE-2",
        仓库名称: "主仓",
        业务员: "admin",
        商家编码: "3282770392869",
      });
    }
    expect(rows.map((row) => row["货品数量"])).toEqual([2, 3]);
    expect(rows.map((row) => row["货品价格"])).toEqual([12.5, 12.5]);

    const repeatedExport = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    const repeatedDownload = await app.inject({
      method: "GET",
      url: repeatedExport.json().downloadUrl,
      headers: { cookie },
    });
    const repeatedWorkbook = XLSX.read(repeatedDownload.rawPayload, { type: "buffer" });
    const repeatedRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(repeatedWorkbook.Sheets["Sheet1"], { defval: "" });
    expect(repeatedRows.map((row) => row["原始单号"])).toEqual(rows.map((row) => row["原始单号"]));
    await app.close();
  });

  it("imports 1,039 confirmed-order rows without exceeding SQLite variable limits", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await database.db.insert(wdtGoodsSpecs).values({
      id: "wdt-goods-spec-ambiguous-large-import",
      goodsNo: "AMBIGUOUS-LARGE-IMPORT",
      goodsName: "雅漾专研保湿修护面膜候选",
      specNo: "AMBIGUOUS-LARGE-IMPORT",
      specName: "25ml*5",
      specCode: "",
      barcode: "2153722460015",
      barcodesJson: JSON.stringify(["2153722460015"]),
      deleted: 0,
      modified: "2026-07-13T00:00:00.000Z",
      rawJson: "{}",
      syncedAt: "2026-07-13T00:00:00.000Z",
    });
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const rowCount = 1_039;
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-1039行.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({
          rows: Array.from({ length: rowCount }, (_, index) => ({
            noticeNo: `NOTICE-LARGE-${index + 1}`,
            goodsCode: "",
            barcode: "2153722460015",
            goodsName: "雅漾专研保湿修护面膜",
            shipQty: "1",
          })),
        }),
      },
      headers: { cookie },
    });

    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      parsedRowCount: rowCount,
      unmatchedRowCount: rowCount,
      batch: { orderLineCount: rowCount, status: "review_generated" },
    });
    const batchId = imported.json().batch.id;
    const linesResponse = await app.inject({ method: "GET", url: `/api/v1/batches/${batchId}/review-lines`, headers: { cookie } });
    expect(linesResponse.statusCode).toBe(200);
    expect(linesResponse.json()).toHaveLength(rowCount);
    const rebuilt = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batchId}/actions/rebuild-confirmed-order`,
      payload: { strategy: "preserve" },
      headers: { cookie },
    });
    expect(rebuilt.statusCode).toBe(200);
    const rebuiltLines = await app.inject({ method: "GET", url: `/api/v1/batches/${batchId}/review-lines`, headers: { cookie } });
    expect(rebuiltLines.json()).toHaveLength(rowCount);

    const verification = createDatabaseContext(databaseUrl);
    await verification.ready;
    const persistedDecisions = await verification.db.select().from(reviewDecisions).where(eq(reviewDecisions.batchId, batchId));
    const persistedCandidates = await verification.db.select().from(productMatchCandidates).where(eq(productMatchCandidates.batchId, batchId));
    await verification.close();
    expect(persistedDecisions).toHaveLength(rowCount);
    expect(persistedCandidates).toHaveLength(2);
    await app.close();
  });

  it("rolls back the batch when confirmed-order review persistence fails", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await database.client.execute(`
      CREATE TRIGGER fail_confirmed_review_insert
      BEFORE INSERT ON review_lines
      WHEN NEW.sort_order > 1
      BEGIN
        SELECT RAISE(ABORT, 'forced confirmed-order persistence failure');
      END
    `);
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: { fileName: "确定单-事务失败.xlsx", contentBase64: confirmedOrderWorkbookBase64() },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(500);

    const verification = createDatabaseContext(databaseUrl);
    await verification.ready;
    const [batchRows, lineRows, decisionRows, candidateRows, auditRows] = await Promise.all([
      verification.db.select().from(batches),
      verification.db.select().from(reviewLines),
      verification.db.select().from(reviewDecisions),
      verification.db.select().from(productMatchCandidates),
      verification.db.select().from(auditLogs),
    ]);
    await verification.close();
    expect(batchRows).toHaveLength(0);
    expect(lineRows).toHaveLength(0);
    expect(decisionRows).toHaveLength(0);
    expect(candidateRows).toHaveLength(0);
    expect(auditRows.filter((row) => row.action === "confirmed_order.import")).toHaveLength(0);
    await app.close();
  });

  it("keeps make-order groups separate and places identical original numbers together", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869");
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, fixedWarehouseStockClient());
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-分仓.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({
          rows: [
            { noticeNo: "NOTICE-MAIN", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "2", mainWarehouseQty: "2" },
            { noticeNo: "NOTICE-NEAR", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "3", mainWarehouseQty: "", nearExpiryWarehouseQty: "3" },
            { noticeNo: "NOTICE-MAIN-SECOND", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "1", mainWarehouseQty: "1" },
            { noticeNo: "NOTICE-OTHER-STORE", storeNo: "S002", storeName: "Ole确定单二店", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "1", mainWarehouseQty: "1" },
          ],
        }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    const lines = linesResponse.json();
    expect(lines.map((line: { suggestedWarehouseName: string }) => line.suggestedWarehouseName)).toEqual(["主仓", "主仓", "主仓", "主仓"]);
    for (const line of lines) {
      const nearExpiry = line.orderNoticeNo === "NOTICE-NEAR";
      const decisionResponse = await app.inject({
        method: "PATCH",
        url: `/api/v1/batches/${imported.json().batch.id}/review-lines/${line.id}/decision`,
        payload: {
          decision: "ship",
          approvedShipQty: line.plannedShipQty,
          fulfillmentWarehouseNo: nearExpiry ? "LINQI" : "001",
          fulfillmentWarehouseName: nearExpiry ? "临期仓" : "主仓",
          reason: nearExpiry ? "人工改为临期仓" : "",
        },
        headers: { cookie },
      });
      expect(decisionResponse.statusCode).toBe(200);
    }
    await seedStoreAddresses(app, cookie, lines);
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false },
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    const downloadResponse = await app.inject({ method: "GET", url: exportResponse.json().downloadUrl, headers: { cookie } });
    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    expect(rows.map((row) => row["仓库名称"])).toEqual(["主仓", "主仓", "临期仓", "主仓"]);
    expect(new Set(rows.map((row) => row["原始单号"]))).toHaveLength(3);
    expect(rows[0]["原始单号"]).toBe(rows[1]["原始单号"]);
    expect(rows[1]["原始单号"]).not.toBe(rows[2]["原始单号"]);
    await app.close();
  });

  it("keeps confirmed-order source warehouse fields only in raw data and does not use them for allocation", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-仓库待确认.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({
          rows: [
            { noticeNo: "NOTICE-MISSING", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "2", mainWarehouseQty: "", nearExpiryWarehouseQty: "" },
            { noticeNo: "NOTICE-CONFLICT", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "3", mainWarehouseQty: "1", nearExpiryWarehouseQty: "2" },
          ],
        }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);
    const linesResponse = await app.inject({ method: "GET", url: `/api/v1/batches/${imported.json().batch.id}/review-lines`, headers: { cookie } });
    expect(linesResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderNoticeNo: "NOTICE-MISSING",
        plannedShipQty: 2,
        suggestedShipQty: 0,
        decision: "pending",
        fulfillmentWarehouseNo: "",
        status: "库存未验证",
      }),
      expect.objectContaining({
        orderNoticeNo: "NOTICE-CONFLICT",
        plannedShipQty: 3,
        suggestedShipQty: 0,
        decision: "pending",
        fulfillmentWarehouseNo: "",
        status: "库存未验证",
      }),
    ]));
    const conflictRaw = JSON.parse(linesResponse.json().find((line: { orderNoticeNo: string }) => line.orderNoticeNo === "NOTICE-CONFLICT").orderRawJson);
    expect(conflictRaw).toMatchObject({ 主仓: "1", 临期仓: "2" });
    expect(linesResponse.json().every((line: { matchMessage: string }) => !line.matchMessage.includes("主仓和临期仓"))).toBe(true);
    await app.close();
  });

  it("allocates confirmed-order quantities from shared snapshot stock without calling the realtime API", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869", 4, "MAIN-A", "OLE主仓");
    await database.db.insert(storeAddresses).values({
      id: "store-address-confirmed-order-stock",
      storeNo: "S001",
      storeName: "Ole确定单门店",
      normalizedStoreName: "ole确定单门店",
      receiver: "确定单收件人",
      phone: "18800005555",
      address: "确定单测试地址",
      isVip: 0,
      note: "",
      sourceSheet: "手工维护",
      sourceRow: 0,
      importedAt: "",
      rawJson: "{}",
      updatedByUserId: null,
      updatedByUsername: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    await database.close();

    const stockClient = failingRealtimeStockClient();
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-库存提示.xlsx",
        contentBase64: confirmedOrderWorkbookBase64(),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(linesResponse.statusCode).toBe(200);
    expect(linesResponse.json()).toHaveLength(2);
    expect(linesResponse.json()).toEqual([
      expect.objectContaining({
        plannedShipQty: 2,
        suggestedShipQty: 2,
        approvedShipQty: 2,
        decision: "ship",
        status: "库存充足",
        mainAvailableBefore: 4,
        suggestedWarehouseName: "OLE主仓",
      }),
      expect.objectContaining({
        plannedShipQty: 3,
        suggestedShipQty: 2,
        approvedShipQty: 2,
        decision: "ship",
        status: "部分满足",
        mainAvailableBefore: 4,
        matchMessage: expect.stringContaining("确定单计划发货 3，系统按当前库存建议 2"),
      }),
    ]);
    expect(linesResponse.json().reduce((sum: number, line: { suggestedShipQty: number }) => sum + line.suggestedShipQty, 0)).toBe(4);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false },
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    const downloadResponse = await app.inject({
      method: "GET",
      url: exportResponse.json().downloadUrl,
      headers: { cookie },
    });
    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    expect(rows.map((row) => row["货品数量"])).toEqual([2, 2]);
    await app.close();
  });

  it("keeps zero-plan confirmed-order rows in review and skips them during export", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869");
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, fixedWarehouseStockClient());
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-零计划量.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({
          rows: [
            { noticeNo: "NOTICE-ZERO", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", orderQty: "10", shipQty: "0" },
            { noticeNo: "NOTICE-POSITIVE", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", orderQty: "6", shipQty: "2" },
          ],
        }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ parsedRowCount: 2, skippedRowCount: 0, batch: { status: "review_generated" } });

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(linesResponse.statusCode).toBe(200);
    const zeroLine = linesResponse.json().find((line: { orderNoticeNo: string }) => line.orderNoticeNo === "NOTICE-ZERO");
    expect(zeroLine).toMatchObject({
      orderQty: 10,
      plannedShipQty: 0,
      suggestedShipQty: 0,
      approvedShipQty: 0,
      decision: "do_not_ship",
      fulfillmentWarehouseNo: "",
    });
    const positiveLine = linesResponse.json().find((line: { orderNoticeNo: string }) => line.orderNoticeNo === "NOTICE-POSITIVE");
    expect(positiveLine).toMatchObject({ orderQty: 6, plannedShipQty: 2, suggestedShipQty: 2, approvedShipQty: 2 });

    await seedStoreAddresses(app, cookie, linesResponse.json());
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false },
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);
    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    const downloadResponse = await app.inject({ method: "GET", url: exportResponse.json().downloadUrl, headers: { cookie } });
    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ 客服备注: "NOTICE-POSITIVE", 货品数量: 2 });
    await app.close();
  });

  it("supports preserve and replace strategies when rebuilding confirmed-order suggestions", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869", 10);
    await database.close();

    const stockClient = failingRealtimeStockClient();
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: { fileName: "确定单-重算策略.xlsx", contentBase64: confirmedOrderWorkbookBase64() },
      headers: { cookie },
    });
    const initialLines = await app.inject({ method: "GET", url: `/api/v1/batches/${imported.json().batch.id}/review-lines`, headers: { cookie } });
    const [firstLine] = initialLines.json();
    const manualDecision = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines/${firstLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 7,
        fulfillmentWarehouseNo: "LINQI",
        fulfillmentWarehouseName: "临期仓",
        reason: "人工保留结果",
      },
      headers: { cookie },
    });
    expect(manualDecision.statusCode).toBe(200);
    const priority = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines/${firstLine.id}/priority`,
      payload: { priority: true, reason: "VIP临时优先" },
      headers: { cookie },
    });
    expect(priority.statusCode).toBe(200);

    const availableSendStock = 3;
    const preserveDatabase = createDatabaseContext(databaseUrl);
    await preserveDatabase.ready;
    await seedSingleWarehouseSnapshot(preserveDatabase, "3282770392869", availableSendStock, "001", "主仓", "2026-07-03T00:02:00.000Z");
    await preserveDatabase.close();
    const preserved = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/rebuild-confirmed-order`,
      payload: { strategy: "preserve" },
      headers: { cookie },
    });
    expect(preserved.statusCode).toBe(200);
    expect(preserved.json().batch.status).toBe("review_generated");
    const preservedLines = await app.inject({ method: "GET", url: `/api/v1/batches/${imported.json().batch.id}/review-lines`, headers: { cookie } });
    expect(preservedLines.json().find((line: { id: string }) => line.id === firstLine.id)).toMatchObject({
      suggestedShipQty: 2,
      suggestedWarehouseNo: "001",
      approvedShipQty: 7,
      fulfillmentWarehouseNo: "LINQI",
      reason: "人工保留结果",
      priority: true,
      priorityReason: "VIP临时优先",
    });

    const replacementAvailableSendStock = 1;
    const replaceDatabase = createDatabaseContext(databaseUrl);
    await replaceDatabase.ready;
    await seedSingleWarehouseSnapshot(replaceDatabase, "3282770392869", replacementAvailableSendStock, "001", "主仓", "2026-07-03T00:03:00.000Z");
    await replaceDatabase.close();
    const replaced = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/rebuild-confirmed-order`,
      payload: { strategy: "replace" },
      headers: { cookie },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().batch.status).toBe("review_generated");
    const replacedLines = await app.inject({ method: "GET", url: `/api/v1/batches/${imported.json().batch.id}/review-lines`, headers: { cookie } });
    expect(replacedLines.json().find((line: { id: string }) => line.id === firstLine.id)).toMatchObject({
      suggestedShipQty: 1,
      approvedShipQty: 1,
      fulfillmentWarehouseNo: "001",
      fulfillmentWarehouseName: "主仓",
      reason: "人工保留结果",
      priority: true,
      priorityReason: "VIP临时优先",
    });
    await app.close();
  });

  it("applies VIP-first fair allocation to confirmed-order planned quantities", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedVipAllocationGoodsCache(database);
    await seedVipStoreAddress(database, "VIP-1", "VIP一店");
    await seedVipStoreAddress(database, "VIP-2", "VIP二店");
    await seedSingleWarehouseSnapshot(database, "VIP-SPEC", 6);
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, fixedWarehouseStockClient(6));
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-VIP分货.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({
          rows: [
            { noticeNo: "VIP-ORDER-1", storeNo: "VIP-1", storeName: "VIP一店", goodsCode: "VIP-GOODS", barcode: "VIP-BARCODE", goodsName: "VIP分货测试商品", shipQty: "4" },
            { noticeNo: "VIP-ORDER-2", storeNo: "VIP-2", storeName: "VIP二店", goodsCode: "VIP-GOODS", barcode: "VIP-BARCODE", goodsName: "VIP分货测试商品", shipQty: "4" },
            { noticeNo: "REG-ORDER-1", storeNo: "REG-1", storeName: "普通一店", goodsCode: "VIP-GOODS", barcode: "VIP-BARCODE", goodsName: "VIP分货测试商品", shipQty: "4" },
            { noticeNo: "REG-ORDER-2", storeNo: "REG-2", storeName: "普通二店", goodsCode: "VIP-GOODS", barcode: "VIP-BARCODE", goodsName: "VIP分货测试商品", shipQty: "4" },
          ],
        }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);
    const linesResponse = await app.inject({ method: "GET", url: `/api/v1/batches/${imported.json().batch.id}/review-lines`, headers: { cookie } });
    const byStore = reviewLinesByStore(linesResponse.json());
    expect(byStore.get("VIP-1")).toMatchObject({ plannedShipQty: 4, suggestedShipQty: 3, approvedShipQty: 3, status: "部分满足" });
    expect(byStore.get("VIP-2")).toMatchObject({ plannedShipQty: 4, suggestedShipQty: 3, approvedShipQty: 3, status: "部分满足" });
    expect(byStore.get("REG-1")).toMatchObject({ plannedShipQty: 4, suggestedShipQty: 0, approvedShipQty: 0, status: "库存不足" });
    expect(byStore.get("REG-2")).toMatchObject({ plannedShipQty: 4, suggestedShipQty: 0, approvedShipQty: 0, status: "库存不足" });
    await app.close();
  });

  it("reads confirmed-order stock from one local snapshot without calling the realtime client", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    const now = "2026-07-03T00:00:00.000Z";
    await database.db.insert(wdtGoodsSpecs).values({
      id: "wdt-goods-spec-confirmed-order-batch-2",
      goodsNo: "GOODS-2",
      goodsName: "批量库存商品2",
      specNo: "SPEC-2",
      specName: "规格2",
      specCode: "",
      barcode: "BARCODE-2",
      barcodesJson: JSON.stringify(["BARCODE-2", "SPEC-2"]),
      deleted: 0,
      modified: now,
      rawJson: "{}",
      syncedAt: now,
    });
    await seedSuccessfulStockSnapshot(database, {
      verifiedSpecNos: ["3282770392869", "SPEC-2"],
      rows: [
        { specNo: "3282770392869", warehouseNo: "MAIN-A", warehouseName: "OLE主仓", availableSendStock: 6 },
        { specNo: "SPEC-2", warehouseNo: "MAIN-A", warehouseName: "OLE主仓", availableSendStock: 8 },
      ],
    });
    await database.close();

    const stockBatches: string[][] = [];
    const stockClient: StockLookupClient = {
      async queryStock() {
        throw new Error("single stock query should not be used");
      },
      async queryStocks(specNos) {
        stockBatches.push(specNos);
        return {
          status: 0,
          data: {
            total_count: specNos.length,
            detail_list: specNos.map((specNo, index) => ({
              spec_no: specNo,
              warehouse_no: "MAIN-A",
              warehouse_name: "OLE主仓",
              available_send_stock: index === 0 ? 6 : 8,
            })),
          },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-批量库存.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({
          rows: [
            { noticeNo: "NOTICE-1", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "2" },
            { noticeNo: "NOTICE-2", goodsCode: "SPEC-2", barcode: "BARCODE-2", goodsName: "批量库存商品2", shipQty: "3" },
          ],
        }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);
    expect(stockBatches).toEqual([]);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(linesResponse.statusCode).toBe(200);
    expect(linesResponse.json().map((line: { mainAvailableBefore: number }) => line.mainAvailableBefore)).toEqual([6, 8]);
    await app.close();
  });

  it("does not call realtime stock APIs while importing confirmed orders", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869", 9);
    await database.close();

    let callCount = 0;
    const stockClient: StockLookupClient = {
      async queryStock() {
        throw new Error("single stock query should not be used");
      },
      async queryStocks(specNos) {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("WDT stock query failed: status=100 message=超过最大并发限制,请稍后重试");
        }
        return {
          status: 0,
          data: {
            total_count: specNos.length,
            detail_list: [
              { spec_no: "3282770392869", warehouse_no: "MAIN-A", warehouse_name: "OLE主仓", available_send_stock: 9 },
            ],
          },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-库存重试.xlsx",
        contentBase64: confirmedOrderWorkbookBase64(),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);
    expect(callCount).toBe(0);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(linesResponse.statusCode).toBe(200);
    for (const line of linesResponse.json()) {
      expect(line.stockErrorDetail).toBe("");
      expect(line.mainAvailableBefore).toBe(9);
    }
    await app.close();
  });

  it("distinguishes snapshot-uncovered SKUs from verified zero stock", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSuccessfulStockSnapshot(database, {
      verifiedSpecNos: ["ZERO-STOCK-SPEC"],
    });
    await database.db.insert(wdtGoodsSpecs).values({
      id: "wdt-goods-spec-zero-stock",
      goodsNo: "ZERO-STOCK-GOODS",
      goodsName: "零库存已核验商品",
      specNo: "ZERO-STOCK-SPEC",
      specName: "单支",
      specCode: "",
      barcode: "ZERO-STOCK-BARCODE",
      barcodesJson: JSON.stringify(["ZERO-STOCK-BARCODE"]),
      deleted: 0,
      modified: "2026-07-03T00:00:00.000Z",
      rawJson: "{}",
      syncedAt: "2026-07-03T00:00:00.000Z",
    });
    await database.close();

    const stockClient: StockLookupClient = {
      async queryStock() {
        return {
          status: 100,
          message: "超过每分钟最大调用频率限制，请稍后重试",
          data: { total_count: 0, detail_list: [] },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-库存失败.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({
          rows: [
            { noticeNo: "NOTICE-UNCOVERED", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "2" },
            { noticeNo: "NOTICE-ZERO", goodsCode: "ZERO-STOCK-SPEC", barcode: "ZERO-STOCK-BARCODE", goodsName: "零库存已核验商品", shipQty: "2" },
          ],
        }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(linesResponse.statusCode).toBe(200);
    expect(linesResponse.json()).toHaveLength(2);
    const uncoveredLine = linesResponse.json().find((line: { orderNoticeNo: string }) => line.orderNoticeNo === "NOTICE-UNCOVERED");
    expect(uncoveredLine).toMatchObject({ status: "库存未验证", decision: "pending", suggestedShipQty: 0, approvedShipQty: 0 });
    expect(uncoveredLine.stockErrorDetail).toBe("LOCAL_STOCK_SNAPSHOT_MISSING");
    const zeroStockLine = linesResponse.json().find((line: { orderNoticeNo: string }) => line.orderNoticeNo === "NOTICE-ZERO");
    expect(zeroStockLine).toMatchObject({ status: "库存不足", decision: "pending", suggestedShipQty: 0, approvedShipQty: 0 });
    expect(zeroStockLine.stockErrorDetail).toBe("");

    const manualLine = uncoveredLine;
    const manualDecision = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines/${manualLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 2,
        fulfillmentWarehouseNo: "001",
        fulfillmentWarehouseName: "主仓",
        reason: "人工核对库存后决定",
      },
      headers: { cookie },
    });
    expect(manualDecision.statusCode).toBe(200);

    const warning = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false },
      headers: { cookie },
    });
    expect(warning.statusCode).toBe(409);
    expect(warning.json()).toMatchObject({ requiresConfirmation: true, code: "UNVERIFIED_STOCK", affectedCount: 1 });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: true },
      headers: { cookie },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ requiresConfirmation: false, batch: { status: "reviewed" } });
    await app.close();
  });

  it("treats a matched SKU as unverified when the snapshot does not cover every enabled warehouse", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSuccessfulStockSnapshot(database, {
      verifiedSpecNos: ["3282770392869"],
      warehouseTypes: ["main"],
      rows: [{ specNo: "3282770392869", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 9 }],
    });
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      headers: { cookie },
      payload: { fileName: "确定单-快照范围不足.xlsx", contentBase64: confirmedOrderWorkbookBase64() },
    });
    expect(imported.statusCode).toBe(201);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(response.json()[0]).toMatchObject({ status: "库存未验证", suggestedShipQty: 0, approvedShipQty: 0 });
    expect(response.json()[0].stockErrorDetail).toContain("LOCAL_STOCK_SNAPSHOT_WAREHOUSE_SCOPE_MISMATCH");
    expect(response.json()[0].stockErrorDetail).toContain("near_expiry");
    await app.close();
  });

  it("corrects store fields on the current batch without changing maintained addresses", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869");
    await database.db.insert(storeAddresses).values({
      id: "store-address-correct-store-fields",
      storeNo: "S001",
      storeName: "Ole确定单门店",
      normalizedStoreName: "ole确定单门店",
      receiver: "正确收件人",
      phone: "18800006666",
      address: "正确地址",
      isVip: 0,
      note: "",
      sourceSheet: "手工维护",
      sourceRow: 0,
      importedAt: "",
      rawJson: "{}",
      updatedByUserId: null,
      updatedByUsername: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, fixedWarehouseStockClient());
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-门店错字.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({ storeNo: "S-错", storeName: "Ole确定单门店错字" }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);

    const beforeReadiness = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/make-order-readiness`,
      headers: { cookie },
    });
    expect(beforeReadiness.statusCode).toBe(200);
    expect(beforeReadiness.json()).toMatchObject({
      canExport: false,
      missingAddressCount: 1,
      missingStores: [expect.objectContaining({ storeNo: "S-错", storeName: "Ole确定单门店错字", shippableLineCount: 2 })],
    });

    const corrected = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${imported.json().batch.id}/store-fields`,
      payload: {
        currentStoreNo: "S-错",
        currentStoreName: "Ole确定单门店错字",
        nextStoreNo: "S001",
        nextStoreName: "Ole确定单门店",
      },
      headers: { cookie },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      updatedLineCount: 2,
      makeOrderReadiness: { canExport: true, missingAddressCount: 0 },
    });

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(linesResponse.statusCode).toBe(200);
    expect(linesResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storeNo: "S001", storeName: "Ole确定单门店" }),
      ]),
    );

    const verifyDatabase = createDatabaseContext(databaseUrl);
    await verifyDatabase.ready;
    const addressRows = await verifyDatabase.db.select().from(storeAddresses);
    await verifyDatabase.close();
    expect(addressRows).toHaveLength(1);
    expect(addressRows[0]).toMatchObject({ storeNo: "S001", storeName: "Ole确定单门店", receiver: "正确收件人" });

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false },
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    const downloadResponse = await app.inject({
      method: "GET",
      url: exportResponse.json().downloadUrl,
      headers: { cookie },
    });
    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      收件人: "正确收件人",
      手机: "18800006666",
      地址: "正确地址",
    });
    await app.close();
  });

  it("applies saved mappings only to affected confirmed-order SKU pools", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869", 6);
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, fixedWarehouseStockClient());
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-待映射.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({ rows: [
          { noticeNo: "TARGET-1", goodsCode: "5372246", barcode: "2153659180017", goodsName: "待映射确定单商品", shipQty: "2" },
          { noticeNo: "TARGET-2", goodsCode: "5372246", barcode: "2153659180017", goodsName: "待映射确定单商品", shipQty: "3" },
          { noticeNo: "EXISTING-POOL", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "4" },
          { noticeNo: "UNRELATED", goodsCode: "UNRELATED", barcode: "UNRELATED", goodsName: "完全无关商品", shipQty: "1" },
        ] }),
      },
      headers: { cookie },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      unmatchedRowCount: 3,
      batch: { sourceType: "confirmed_order", status: "review_generated" },
    });

    const rejectedRealReview = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/run-real-review`,
      payload: { allowStaleCache: false },
      headers: { cookie },
    });
    expect(rejectedRealReview.statusCode).toBe(400);
    expect(rejectedRealReview.json().message).toContain("确定单批次不支持普通订单初审");

    const mapping = await app.inject({
      method: "POST",
      url: "/api/v1/product-mappings",
      payload: {
        externalBarcode: "2153659180017",
        externalGoodsCode: "5372246",
        externalGoodsName: "待映射确定单商品",
        wdtSpecNo: "3282770392869",
        sourceBatchId: imported.json().batch.id,
        note: "确定单补映射",
      },
      headers: { cookie },
    });
    expect(mapping.statusCode).toBe(201);

    const beforeApply = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    const existingPoolLine = beforeApply.json().find((line: { orderNoticeNo: string }) => line.orderNoticeNo === "EXISTING-POOL");
    const unrelatedBefore = beforeApply.json().find((line: { orderNoticeNo: string }) => line.orderNoticeNo === "UNRELATED");
    const manualDecision = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines/${existingPoolLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 4,
        fulfillmentWarehouseNo: "001",
        fulfillmentWarehouseName: "主仓",
        reason: "保留人工数量",
      },
      headers: { cookie },
    });
    expect(manualDecision.statusCode).toBe(200);

    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/apply-product-mapping`,
      payload: { mappingId: mapping.json().id },
      headers: { cookie },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      mode: "targeted",
      affectedExternalRowCount: 2,
      affectedSkuPoolCount: 1,
      affectedReviewLineCount: 3,
      batch: { sourceType: "confirmed_order", status: "review_generated" },
    });
    expect(applied.json().reviewLines.map((line: { orderNoticeNo: string }) => line.orderNoticeNo)).not.toContain("UNRELATED");

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${imported.json().batch.id}/review-lines`,
      headers: { cookie },
    });
    expect(linesResponse.statusCode).toBe(200);
    expect(linesResponse.json()).toHaveLength(4);
    const byNotice = new Map(linesResponse.json().map((line: { orderNoticeNo: string }) => [line.orderNoticeNo, line]));
    expect(byNotice.get("TARGET-1")).toMatchObject({
      matchStatus: "matched",
      decision: "ship",
      approvedShipQty: 2,
      wdtSpecNo: "3282770392869",
    });
    expect(byNotice.get("TARGET-2")).toMatchObject({ matchStatus: "matched", suggestedShipQty: 2, approvedShipQty: 2 });
    expect(byNotice.get("EXISTING-POOL")).toMatchObject({
      suggestedShipQty: 2,
      approvedShipQty: 4,
      reason: "保留人工数量",
    });
    expect(byNotice.get("UNRELATED")).toEqual(unrelatedBefore);

    await app.close();
  });

  it("falls back to a full preserve rebuild when a batch snapshot was pruned", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869", 5, "001", "主仓", "2026-07-03T00:01:00.000Z");
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, failingRealtimeStockClient());
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-快照回退.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({ goodsCode: "5372246", barcode: "2153659180017", goodsName: "待映射确定单商品" }),
      },
      headers: { cookie },
    });
    const mapping = await app.inject({
      method: "POST",
      url: "/api/v1/product-mappings",
      payload: {
        externalBarcode: "2153659180017",
        externalGoodsCode: "5372246",
        externalGoodsName: "待映射确定单商品",
        wdtSpecNo: "3282770392869",
        sourceBatchId: imported.json().batch.id,
        note: "快照回退映射",
      },
      headers: { cookie },
    });

    const pruned = createDatabaseContext(databaseUrl);
    await pruned.ready;
    const oldRunId = imported.json().batch.stockSnapshotRunId;
    await pruned.db.delete(wdtStockSnapshotRows).where(eq(wdtStockSnapshotRows.syncRunId, oldRunId));
    await pruned.db.delete(wdtStockSnapshotSpecs).where(eq(wdtStockSnapshotSpecs.syncRunId, oldRunId));
    await pruned.db.delete(wdtStockSnapshotWarehouseCoverage).where(eq(wdtStockSnapshotWarehouseCoverage.syncRunId, oldRunId));
    await pruned.db.delete(wdtSyncRuns).where(eq(wdtSyncRuns.id, oldRunId));
    const latest = await seedSingleWarehouseSnapshot(pruned, "3282770392869", 3, "001", "主仓", "2026-07-03T02:01:00.000Z");
    await pruned.close();

    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/apply-product-mapping`,
      payload: { mappingId: mapping.json().id },
      headers: { cookie },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      mode: "full_rebuild_fallback",
      affectedExternalRowCount: 2,
      stockSnapshotRunId: latest.runId,
      batch: { status: "review_generated", stockSnapshotRunId: latest.runId },
    });
    expect(applied.json().reviewLines).toHaveLength(2);
    expect(applied.json().reviewLines.every((line: { matchStatus: string }) => line.matchStatus === "matched")).toBe(true);
    await app.close();
  });

  it("reallocates both old and new SKU pools when an existing mapping target changes", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    const now = "2026-07-03T00:00:00.000Z";
    await database.db.insert(wdtGoodsSpecs).values({
      id: "wdt-goods-spec-mapping-target-b",
      goodsNo: "SPEC-B",
      goodsName: "映射目标B",
      specNo: "SPEC-B",
      specName: "B规格",
      specCode: "SPEC-B",
      barcode: "BARCODE-B",
      barcodesJson: JSON.stringify(["BARCODE-B", "SPEC-B"]),
      deleted: 0,
      modified: now,
      rawJson: "{}",
      syncedAt: now,
    });
    await seedSuccessfulStockSnapshot(database, {
      verifiedSpecNos: ["3282770392869", "SPEC-B"],
      rows: [
        { specNo: "3282770392869", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 4 },
        { specNo: "SPEC-B", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 4 },
      ],
    });
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, failingRealtimeStockClient());
    const cookie = await loginCookie(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/confirmed-orders/import",
      payload: {
        fileName: "确定单-映射换池.xlsx",
        contentBase64: confirmedOrderWorkbookBase64({ rows: [
          { noticeNo: "TARGET", goodsCode: "EXTERNAL-TARGET", barcode: "EXTERNAL-TARGET", goodsName: "待映射商品", shipQty: "2" },
          { noticeNo: "POOL-A", goodsCode: "3282770392869", barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", shipQty: "4" },
          { noticeNo: "POOL-B", goodsCode: "SPEC-B", barcode: "BARCODE-B", goodsName: "映射目标B", shipQty: "4" },
        ] }),
      },
      headers: { cookie },
    });
    const firstMapping = await app.inject({
      method: "POST",
      url: "/api/v1/product-mappings",
      payload: { externalBarcode: "EXTERNAL-TARGET", externalGoodsCode: "EXTERNAL-TARGET", externalGoodsName: "待映射商品", wdtSpecNo: "3282770392869", sourceBatchId: imported.json().batch.id },
      headers: { cookie },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/apply-product-mapping`,
      payload: { mappingId: firstMapping.json().id },
      headers: { cookie },
    });

    const changedMapping = await app.inject({
      method: "POST",
      url: "/api/v1/product-mappings",
      payload: { externalBarcode: "EXTERNAL-TARGET", externalGoodsCode: "EXTERNAL-TARGET", externalGoodsName: "待映射商品", wdtSpecNo: "SPEC-B", sourceBatchId: imported.json().batch.id },
      headers: { cookie },
    });
    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${imported.json().batch.id}/actions/apply-product-mapping`,
      payload: { mappingId: changedMapping.json().id },
      headers: { cookie },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ affectedExternalRowCount: 1, affectedSkuPoolCount: 2, affectedReviewLineCount: 3 });
    const byNotice = new Map(applied.json().reviewLines.map((line: { orderNoticeNo: string }) => [line.orderNoticeNo, line]));
    expect(byNotice.get("TARGET")).toMatchObject({ wdtSpecNo: "SPEC-B", suggestedShipQty: 2, approvedShipQty: 2 });
    expect(byNotice.get("POOL-A")).toMatchObject({ wdtSpecNo: "3282770392869", suggestedShipQty: 4 });
    expect(byNotice.get("POOL-B")).toMatchObject({ wdtSpecNo: "SPEC-B", suggestedShipQty: 2, approvedShipQty: 4 });
    await app.close();
  });

  it("reports make-order readiness from stored addresses", async () => {
    const app = buildTestServer();
    const { batch, lines, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json");
    const shippableLineCount = lines.filter((line: { decision: string; approvedShipQty: number }) => line.decision === "ship" && line.approvedShipQty > 0).length;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/make-order-readiness`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      batchId: batch.id,
      canExport: true,
      shippableLineCount,
      missingAddressCount: 0,
      missingStores: [],
    });
    await app.close();
  });

  it("blocks review submission and make-order export when a shippable legacy row has no warehouse", async () => {
    const databaseUrl = testDatabaseUrl();
    const firstApp = buildTestServer(databaseUrl);
    const { batch, lines } = await createReviewedBatch(firstApp, "examples/mock_flow_mixed.json");
    const shipLine = lines.find((line: { decision: string; approvedShipQty: number }) => line.decision === "ship" && line.approvedShipQty > 0);
    expect(shipLine).toBeTruthy();
    await firstApp.close();

    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db
      .update(reviewDecisions)
      .set({ fulfillmentWarehouseNo: "", fulfillmentWarehouseName: "" })
      .where(eq(reviewDecisions.reviewLineId, shipLine.id));
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const readiness = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/make-order-readiness`,
      headers: { cookie },
    });
    expect(readiness.json()).toMatchObject({ canExport: false, missingWarehouseCount: 1 });
    expect(readiness.json().missingWarehouseLines).toEqual([
      expect.objectContaining({ reviewLineId: shipLine.id, orderNoticeNo: shipLine.orderNoticeNo }),
    ]);

    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/submit-review`,
      headers: { cookie },
    });
    expect(submit.statusCode).toBe(400);
    expect(submit.json().message).toContain("未选择仓库");

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    expect(exportResponse.json()).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("未选择仓库") });
    await app.close();
  });

  it("lists only shippable stores when make-order addresses are missing", async () => {
    const app = buildTestServer();
    const { batch, lines, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json", undefined, { seedAddresses: false });
    const shipLines = lines.filter((line: { decision: string; approvedShipQty: number }) => line.decision === "ship" && line.approvedShipQty > 0);
    const pendingLine = lines.find((line: { decision: string }) => line.decision === "pending");
    expect(shipLines.length).toBeGreaterThan(0);
    expect(pendingLine).toBeTruthy();

    await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${pendingLine.id}/decision`,
      payload: { decision: "ship", approvedShipQty: 0, reason: "" },
      headers: { cookie },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/make-order-readiness`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().canExport).toBe(false);
    expect(response.json().shippableLineCount).toBe(shipLines.length);
    expect(response.json().missingStores.length).toBeGreaterThan(0);
    expect(response.json().missingStores.every((store: { shippableLineCount: number }) => store.shippableLineCount > 0)).toBe(true);
    await app.close();
  });

  it("does not create a ready make-order export when addresses are missing", async () => {
    const app = buildTestServer();
    const { batch, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json", undefined, { seedAddresses: false });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ type: "wdt_import", status: "failed" });
    expect(response.json().downloadUrl).toBeUndefined();
    expect(response.json().errorMessage).toContain("缺少发货地址");
    await app.close();
  });

  it("treats stored addresses without receiver or phone as incomplete", async () => {
    const databaseUrl = testDatabaseUrl();
    const app = buildTestServer(databaseUrl);
    const { batch, lines, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json", undefined, { seedAddresses: false });
    const shipLine = lines.find((line: { decision: string; approvedShipQty: number }) => line.decision === "ship" && line.approvedShipQty > 0);
    expect(shipLine).toBeTruthy();

    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    const now = new Date().toISOString();
    await database.db.insert(storeAddresses).values({
      id: "store-address-incomplete",
      storeNo: shipLine.storeNo,
      storeName: shipLine.storeName,
      normalizedStoreName: shipLine.storeName.toLowerCase().replaceAll(" ", ""),
      receiver: "",
      phone: "",
      address: "只有地址没有收件人",
      note: "",
      sourceSheet: "历史脏数据",
      sourceRow: 1,
      importedAt: now,
      rawJson: "{}",
      updatedByUserId: null,
      updatedByUsername: null,
      createdAt: now,
      updatedAt: now,
    });
    await database.close();

    const readiness = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/make-order-readiness`,
      headers: { cookie },
    });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().canExport).toBe(false);
    expect(readiness.json().missingStores.some((store: { storeNo: string }) => store.storeNo === shipLine.storeNo)).toBe(true);
    await app.close();
  });

  it("maintains store addresses and uses them for make-order exports", async () => {
    const app = buildTestServer();
    const { batch, lines, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json");
    const shipLine = lines.find((line: { decision: string }) => line.decision === "ship");
    expect(shipLine).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses",
      payload: {
        storeNo: shipLine.storeNo,
        storeName: shipLine.storeName,
        receiver: "系统收货人",
        phone: "18800001111",
        address: "系统维护地址一号",
        note: "首次维护",
      },
      headers: { cookie },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      storeNo: shipLine.storeNo,
      storeName: shipLine.storeName,
      receiver: "系统收货人",
      updatedByUsername: "admin",
    });

    const updated = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses",
      payload: {
        storeNo: shipLine.storeNo,
        storeName: shipLine.storeName,
        receiver: "系统收货人更新",
        phone: "18800002222",
        address: "系统维护地址二号",
        note: "覆盖旧地址",
      },
      headers: { cookie },
    });
    expect(updated.statusCode).toBe(201);
    expect(updated.json().id).toBe(created.json().id);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/store-addresses?query=${encodeURIComponent(shipLine.storeNo)}`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ address: "系统维护地址二号", phone: "18800002222" });

    await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${shipLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 3,
        fulfillmentWarehouseNo: shipLine.suggestedWarehouseNo,
        fulfillmentWarehouseName: shipLine.suggestedWarehouseName,
        reason: "",
      },
      headers: { cookie },
    });
    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    expect(exportResponse.json().status).toBe("ready");
    const downloadResponse = await app.inject({
      method: "GET",
      url: exportResponse.json().downloadUrl,
      headers: { cookie },
    });
    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    const exportedLine = rows.find(
      (row) =>
        row["商家编码"] === shipLine.wdtSpecNo
        && row["货品数量"] === 3,
    );
    expect(exportedLine).toMatchObject({
      收件人: "系统收货人更新",
      手机: "18800002222",
      地址: "系统维护地址二号",
    });
    await app.close();
  });

  it("imports store addresses from multi-sheet workbooks and preserves raw source fields", async () => {
    const app = buildTestServer();
    const cookie = await loginCookie(app);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["经理收货地址说明"],
        ["门店编码/群组", "门店名称", "门店地址", "经理", "联系方式", "片区"],
        ["A001", "经理门店", "深圳市南山区经理地址", "张经理", "18800000001", "南区"],
      ]),
      "2025.6.3经理新表（主要）",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["序号", "区域", "", "地址", "收货人", "电话"],
        [1, "东区", "兼职门店", "广州市天河区兼职地址", "李兼职", "18800000002"],
      ]),
      "OLE门店兼职收货人（仓库发货主要用的）",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["门店编号", "门店名称", "地址", "非食经理", "联系电话"],
        ["C003", "旧表门店", "佛山市禅城区旧表地址", "王经理", "18800000003"],
      ]),
      "2024.8.28前经理收货人",
    );
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "WpsReserved_CellImgList");
    const contentBase64 = (XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer).toString("base64");

    const existing = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses",
      payload: {
        storeNo: "A001",
        storeName: "经理门店",
        receiver: "旧经理",
        phone: "18800000999",
        address: "旧地址",
      },
      headers: { cookie },
    });
    expect(existing.statusCode).toBe(201);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import-preview",
      payload: {
        fileName: "地址匹配表格.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      fileName: "地址匹配表格.xlsx",
      sheetCount: 3,
      parsedRowCount: 3,
      affectedStoreCount: 3,
      createCount: 2,
      updateCount: 1,
      unchangedCount: 0,
    });
    expect(preview.json().items.find((item: { storeNo: string }) => item.storeNo === "A001")).toMatchObject({
      action: "update",
      existing: { receiver: "旧经理", phone: "18800000999", address: "旧地址" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import",
      payload: {
        fileName: "地址匹配表格.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      fileName: "地址匹配表格.xlsx",
      sheetCount: 3,
      parsedRowCount: 3,
      importedAddressCount: 3,
      skippedRowCount: 0,
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/store-addresses?query=${encodeURIComponent("经理门店")}`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({
      storeNo: "A001",
      storeName: "经理门店",
      receiver: "张经理",
      phone: "18800000001",
      address: "深圳市南山区经理地址",
      sourceSheet: "2025.6.3经理新表（主要）",
      sourceRow: 3,
      updatedByUsername: "admin",
    });
    expect(JSON.parse(list.json()[0].rawJson).records[0].rawFields).toMatchObject({
      "门店编码/群组": "A001",
      片区: "南区",
    });

    const partTimeList = await app.inject({
      method: "GET",
      url: `/api/v1/store-addresses?query=${encodeURIComponent("兼职门店")}`,
      headers: { cookie },
    });
    expect(partTimeList.statusCode).toBe(200);
    expect(partTimeList.json()[0]).toMatchObject({
      storeName: "兼职门店",
      receiver: "李兼职",
      phone: "18800000002",
      address: "广州市天河区兼职地址",
      sourceSheet: "OLE门店兼职收货人（仓库发货主要用的）",
      sourceRow: 2,
    });
    expect(JSON.parse(partTimeList.json()[0].rawJson).records[0].rawFields).toMatchObject({
      列3: "兼职门店",
      区域: "东区",
    });

    await app.close();
  });

  it("imports the same final store address shown in the preview when a workbook has duplicate stores", async () => {
    const app = buildTestServer();
    const cookie = await loginCookie(app);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["门店编号", "门店名称", "地址", "收货人", "电话"],
        ["D001", "重复门店", "第一次地址", "第一次收货人", "18800000001"],
        ["D001", "重复门店", "最终地址", "最终收货人", "18800000002"],
      ]),
      "经理表",
    );
    const contentBase64 = (XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer).toString("base64");

    const existing = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses",
      payload: {
        storeNo: "D001",
        storeName: "重复门店",
        receiver: "旧收货人",
        phone: "18800000999",
        address: "旧地址",
      },
      headers: { cookie },
    });
    expect(existing.statusCode).toBe(201);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import-preview",
      payload: {
        fileName: "重复地址.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      parsedRowCount: 2,
      affectedStoreCount: 1,
      updateCount: 1,
      items: [
        {
          action: "update",
          storeNo: "D001",
          receiver: "最终收货人",
          phone: "18800000002",
          address: "最终地址",
        },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import",
      payload: {
        fileName: "重复地址.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      parsedRowCount: 2,
      importedAddressCount: 1,
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/store-addresses?query=${encodeURIComponent("重复门店")}`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({
      storeNo: "D001",
      storeName: "重复门店",
      receiver: "最终收货人",
      phone: "18800000002",
      address: "最终地址",
      sourceRow: 3,
    });
    expect(JSON.parse(list.json()[0].rawJson).records).toHaveLength(2);

    await app.close();
  });

  it("prefers warehouse part-time receiver sheet over manager sheets and makes repeated imports idempotent", async () => {
    const databaseUrl = testDatabaseUrl();
    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    const now = new Date().toISOString();
    await database.db.insert(storeAddresses).values({
      id: "store-address-guiyang-dirty",
      storeNo: "",
      storeName: "Ole贵阳万象城",
      normalizedStoreName: "ole贵阳万象城",
      receiver: "",
      phone: "",
      address: "贵阳市南明区遵义社区体育路一号",
      note: "",
      sourceSheet: "2024.8.28后经理收货人电话",
      sourceRow: 61,
      importedAt: now,
      rawJson: "{}",
      updatedByUserId: null,
      updatedByUsername: null,
      createdAt: now,
      updatedAt: now,
    });
    await database.close();

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["区域", "", "门店编码/群组", "门店名称", "门店地址", "经理", "联系方式"],
        ["西区采购区", "OLE", "207752", "Ole贵阳万象城", "贵阳市南明区遵义社区体育路一号", "唐林燕", "13043551369"],
        ["西区采购区", "OLE", "207140", "重庆国金中心店", "重庆市江北城北大街38号重庆国金中心第一层L101及L102B号商铺", "潘婷婷", "18584810194"],
      ]),
      "2025.6.3经理新表（主要）",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["序号", "区域", "", "地址", "收货人", "电话"],
        [85, "西区", "Ole贵阳万象城店", "贵州省贵阳市南明区遵义路328号贵阳万象城LG101、LG102号商铺", "王如芳", "18286145293"],
        [65, "西区", "Ole重庆国金中心店", "重庆市江北城北大街38号重庆国金中心第一层L101及L102B号商铺（拒放快递柜   丢件快递责任自负）", "张玲", "15223265398"],
      ]),
      "OLE门店兼职收货人（仓库发货主要用的）",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["区域", "区域", "业态", "门店编码/群组", "门店名称", "门店地址", "经理", "联系方式"],
        ["", "西区采购区", "OLE", "", "Ole贵阳万象城", "贵阳市南明区遵义社区体育路一号", "", ""],
        ["", "西区采购区", "OLE", "207140", "重庆国金中心店", "重庆市江北城北大街38号重庆国金中心第一层L101及L102B号商铺", "潘婷婷", "18584810194"],
      ]),
      "2024.8.28后经理收货人电话",
    );
    const contentBase64 = (XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer).toString("base64");

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import-preview",
      payload: {
        fileName: "地址匹配表格.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      parsedRowCount: 6,
      affectedStoreCount: 2,
      createCount: 1,
      updateCount: 1,
      unchangedCount: 0,
    });
    expect(preview.json().items.find((item: { storeNo: string }) => item.storeNo === "207752")).toMatchObject({
      action: "update",
      storeNo: "207752",
      storeName: "Ole贵阳万象城店",
      receiver: "王如芳",
      phone: "18286145293",
      address: "贵州省贵阳市南明区遵义路328号贵阳万象城LG101、LG102号商铺",
      sourceSheet: "OLE门店兼职收货人（仓库发货主要用的）",
      sourceRow: 2,
      existing: {
        storeNo: "",
        storeName: "Ole贵阳万象城",
        receiver: "",
        phone: "",
        address: "贵阳市南明区遵义社区体育路一号",
      },
    });
    expect(preview.json().items.find((item: { storeNo: string }) => item.storeNo === "207140")).toMatchObject({
      action: "create",
      storeNo: "207140",
      storeName: "Ole重庆国金中心店",
      receiver: "张玲",
      phone: "15223265398",
      address: "重庆市江北城北大街38号重庆国金中心第一层L101及L102B号商铺（拒放快递柜   丢件快递责任自负）",
      sourceSheet: "OLE门店兼职收货人（仓库发货主要用的）",
      sourceRow: 3,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import",
      payload: {
        fileName: "地址匹配表格.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      parsedRowCount: 6,
      importedAddressCount: 2,
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/store-addresses?query=${encodeURIComponent("207752")}`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({
      storeNo: "207752",
      storeName: "Ole贵阳万象城店",
      receiver: "王如芳",
      phone: "18286145293",
      address: "贵州省贵阳市南明区遵义路328号贵阳万象城LG101、LG102号商铺",
      sourceSheet: "OLE门店兼职收货人（仓库发货主要用的）",
      sourceRow: 2,
    });
    expect(JSON.parse(list.json()[0].rawJson).records).toHaveLength(3);

    const chongqingList = await app.inject({
      method: "GET",
      url: `/api/v1/store-addresses?query=${encodeURIComponent("207140")}`,
      headers: { cookie },
    });
    expect(chongqingList.statusCode).toBe(200);
    expect(chongqingList.json()).toHaveLength(1);
    expect(chongqingList.json()[0]).toMatchObject({
      storeNo: "207140",
      storeName: "Ole重庆国金中心店",
      receiver: "张玲",
      phone: "15223265398",
      address: "重庆市江北城北大街38号重庆国金中心第一层L101及L102B号商铺（拒放快递柜   丢件快递责任自负）",
      sourceSheet: "OLE门店兼职收货人（仓库发货主要用的）",
      sourceRow: 3,
    });
    expect(JSON.parse(chongqingList.json()[0].rawJson).records).toHaveLength(3);

    const secondPreview = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import-preview",
      payload: {
        fileName: "地址匹配表格.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });
    expect(secondPreview.statusCode).toBe(200);
    expect(secondPreview.json()).toMatchObject({
      affectedStoreCount: 2,
      createCount: 0,
      updateCount: 0,
      unchangedCount: 2,
    });

    await app.close();
  });

  it("rejects store address writes from reviewer accounts", async () => {
    const app = buildTestServer();
    const reviewerCookie = await loginCookie(app, "reviewer", "reviewer123");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses",
      payload: {
        storeNo: "STORE",
        storeName: "测试门店",
        receiver: "收货人",
        phone: "18800000000",
        address: "测试地址",
      },
      headers: { cookie: reviewerCookie },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects store address imports from reviewer accounts", async () => {
    const app = buildTestServer();
    const reviewerCookie = await loginCookie(app, "reviewer", "reviewer123");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["门店名称", "地址"], ["测试门店", "测试地址"]]),
      "地址表",
    );
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import-preview",
      payload: {
        fileName: "地址匹配表格.xlsx",
        contentBase64: (XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer).toString("base64"),
      },
      headers: { cookie: reviewerCookie },
    });
    expect(preview.statusCode).toBe(403);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses/import",
      payload: {
        fileName: "地址匹配表格.xlsx",
        contentBase64: (XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer).toString("base64"),
      },
      headers: { cookie: reviewerCookie },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("previews external sample and bundle workbooks against the local WDT goods cache", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedExternalProductGoodsCache(database);
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const contentBase64 = externalProductsWorkbookBase64();

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/external-products/import-preview",
      payload: {
        fileName: "小样套盒统计.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      fileName: "小样套盒统计.xlsx",
      sheetCount: 2,
      parsedProductCount: 3,
      parsedComponentCount: 5,
      createCount: 3,
      updateCount: 0,
      unchangedCount: 0,
      needsReviewCount: 2,
    });
    expect(preview.json().items.find((item: { externalGoodsName: string }) => item.externalGoodsName === "小样命中")).toMatchObject({
      type: "sample",
      status: "confirmed",
      resolvedComponentCount: 1,
      components: [
        {
          componentBarcode: "690000000001",
          matchStatus: "unique_wdt_hit",
          wdtSpecNo: "SPEC-SAMPLE-1",
        },
      ],
    });
    expect(preview.json().items.find((item: { externalGoodsName: string }) => item.externalGoodsName === "小样未命中")).toMatchObject({
      type: "sample",
      status: "needs_review",
      needsReviewComponentCount: 1,
      components: [
        {
          componentBarcode: "690000000099",
          matchStatus: "no_wdt_hit",
        },
      ],
    });
    const bundle = preview.json().items.find((item: { externalGoodsName: string }) => item.externalGoodsName === "命中套盒");
    expect(bundle).toMatchObject({
      type: "bundle",
      externalBarcode: "BUNDLE001",
      status: "needs_review",
      componentCount: 3,
      resolvedComponentCount: 1,
      needsReviewComponentCount: 2,
    });
    expect(bundle.components.map((component: { role: string; matchStatus: string; wdtSpecNo: string }) => component)).toMatchObject([
      { role: "primary", matchStatus: "unique_wdt_hit", wdtSpecNo: "SPEC-BUNDLE-PRIMARY" },
      { role: "replacement", matchStatus: "needs_review", wdtSpecNo: "" },
      { role: "extra", matchStatus: "needs_review", wdtSpecNo: "" },
    ]);
    await app.close();
  });

  it("imports external products with components and makes repeated previews idempotent", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedExternalProductGoodsCache(database);
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const contentBase64 = externalProductsWorkbookBase64();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/external-products/import",
      payload: {
        fileName: "小样套盒统计.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      parsedProductCount: 3,
      parsedComponentCount: 5,
      importedProductCount: 3,
      importedComponentCount: 5,
      needsReviewCount: 2,
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/external-products?query=${encodeURIComponent("命中套盒")}`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({
      type: "bundle",
      externalBarcode: "BUNDLE001",
      externalGoodsName: "命中套盒",
      status: "needs_review",
      sourceFileName: "小样套盒统计.xlsx",
      updatedByUsername: "admin",
    });
    expect(list.json()[0].components).toHaveLength(3);
    expect(list.json()[0].components[0]).toMatchObject({
      role: "primary",
      componentBarcode: "690000000002",
      wdtSpecNo: "SPEC-BUNDLE-PRIMARY",
      matchStatus: "unique_wdt_hit",
    });
    expect(list.json()[0].components[1]).toMatchObject({
      role: "replacement",
      componentBarcode: "690000000003",
      matchStatus: "needs_review",
      quantityMultiplier: 2,
    });

    const afterDatabase = createDatabaseContext(databaseUrl);
    await afterDatabase.ready;
    expect(await afterDatabase.db.select().from(externalProducts)).toHaveLength(3);
    expect(await afterDatabase.db.select().from(externalProductComponents)).toHaveLength(5);
    const logs = await afterDatabase.db.select().from(auditLogs).where(eq(auditLogs.action, "external_product.import"));
    expect(logs).toHaveLength(1);
    await afterDatabase.close();

    const secondPreview = await app.inject({
      method: "POST",
      url: "/api/v1/external-products/import-preview",
      payload: {
        fileName: "小样套盒统计.xlsx",
        contentBase64,
      },
      headers: { cookie },
    });
    expect(secondPreview.statusCode).toBe(200);
    expect(secondPreview.json()).toMatchObject({
      createCount: 0,
      updateCount: 0,
      unchangedCount: 3,
    });
    await app.close();
  });

  it("rejects external product imports from reviewer accounts", async () => {
    const app = buildTestServer();
    const reviewerCookie = await loginCookie(app, "reviewer", "reviewer123");
    const payload = {
      fileName: "小样套盒统计.xlsx",
      contentBase64: externalProductsWorkbookBase64(),
    };

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/external-products/import-preview",
      payload,
      headers: { cookie: reviewerCookie },
    });
    expect(preview.statusCode).toBe(403);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/external-products/import",
      payload,
      headers: { cookie: reviewerCookie },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("exports WDT make-order Excel with the client import template", async () => {
    const app = buildTestServer();
    const { batch, lines, cookie } = await createReviewedBatch(app, "examples/mock_flow_mixed.json");
    const shipLine = lines.find((line: { decision: string }) => line.decision === "ship");
    const pendingLine = lines.find((line: { decision: string }) => line.decision === "pending");
    expect(shipLine).toBeTruthy();
    expect(pendingLine).toBeTruthy();

    await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${shipLine.id}/decision`,
      payload: {
        decision: "ship",
        approvedShipQty: 3,
        fulfillmentWarehouseNo: shipLine.suggestedWarehouseNo,
        fulfillmentWarehouseName: shipLine.suggestedWarehouseName,
        reason: "门店优先处理",
      },
      headers: { cookie },
    });
    const zeroQuantityDecision = await app.inject({
      method: "PATCH",
      url: `/api/v1/batches/${batch.id}/review-lines/${pendingLine.id}/decision`,
      payload: { decision: "ship", approvedShipQty: 0, reason: "库存不足，最终不发" },
      headers: { cookie },
    });
    expect(zeroQuantityDecision.statusCode).toBe(200);
    expect(zeroQuantityDecision.json()).toMatchObject({ decision: "ship", approvedShipQty: 0 });

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    expect(exportResponse.json()).toMatchObject({ type: "wdt_import", status: "ready" });
    expect(exportResponse.json().fileName).toMatch(/\.xlsx$/);

    const downloadResponse = await app.inject({
      method: "GET",
      url: exportResponse.json().downloadUrl,
      headers: { cookie },
    });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.headers["content-type"]).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["Sheet1", "不做单表"]);
    expect(workbook.Sheets["Sheet1"]["!autofilter"]).toEqual({ ref: workbook.Sheets["Sheet1"]["!ref"] });
    expect(workbook.Sheets["不做单表"]["!autofilter"]).toEqual({ ref: workbook.Sheets["不做单表"]["!ref"] });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    const header = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets["Sheet1"], { header: 1 })[0];
    expect(header).toEqual([
      "店铺名称",
      "原始单号",
      "订单编号",
      "收货信息",
      "收件人",
      "省",
      "市",
      "区",
      "手机",
      "固话",
      "邮编",
      "网名",
      "地址",
      "发货条件",
      "应收合计",
      "邮费",
      "优惠金额",
      "COD买家费用",
      "已收金额",
      "收款账户",
      "仓库名称",
      "物流公司",
      "下单时间",
      "付款时间",
      "买家备注",
      "客服备注",
      "打印备注",
      "发票类型",
      "发票抬头",
      "发票内容",
      "业务员",
      "商家编码",
      "货品数量",
      "货品价格",
      "货品总价",
      "货品优惠",
      "原始子单号",
      "赠品方式",
      "货品备注",
      "订单类别",
      "平台货品名称",
      "平台规格名称",
      "证件号码",
      "计划发货时间",
      "订单标签",
      "标记名称",
      "平台",
      "付款账户",
      "分销商名称",
    ]);
    const doNotRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["不做单表"], { defval: "" });
    const doNotHeader = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets["不做单表"], { header: 1 })[0];
    expect(doNotHeader).toEqual(header);
    expect(rows).toHaveLength(lines.filter((line: { decision: string; approvedShipQty: number }) => line.decision === "ship" && line.approvedShipQty > 0).length);
    expect(doNotRows).toHaveLength(lines.filter((line: { approvedShipQty: number }) => line.approvedShipQty === 0).length);
    expect(doNotRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ 货品数量: 0 }),
    ]));

    const exportedLine = rows.find(
      (row) =>
        row["商家编码"] === shipLine.wdtSpecNo
        && row["货品数量"] === 3,
    );
    expect(String(exportedLine?.["原始单号"] ?? "")).toMatch(/^JY\d{6}[A-Z0-9]{8}$/);
    expect(exportedLine?.["原始单号"]).not.toBe(shipLine.orderNoticeNo);
    expect(String(exportedLine?.["客服备注"] ?? "")).toContain(shipLine.orderNoticeNo);
    expect(exportedLine).toMatchObject({
      店铺名称: "KA运营B组",
      网名: "M7Z2OLE超市",
      发货条件: "挂账",
      邮费: 0,
      优惠金额: 0,
      仓库名称: "主仓",
      物流公司: "加密-京东",
      发票类型: "电子普通发票",
      发票抬头: "润家商业(深圳)有限公司",
      业务员: "admin",
      商家编码: shipLine.wdtSpecNo,
      货品数量: 3,
    });
    expect(exportedLine?.["收件人"]).not.toBe("");
    expect(exportedLine?.["手机"]).not.toBe("");
    expect(exportedLine?.["地址"]).not.toBe("");
    expect(
      rows.some(
        (row) =>
          row["商家编码"] === pendingLine.wdtSpecNo
          && row["货品数量"] === pendingLine.approvedShipQty,
      ),
    ).toBe(false);
    expect(doNotRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        商家编码: pendingLine.wdtMakeOrderCode || pendingLine.wdtSpecNo || pendingLine.externalGoodsCode || pendingLine.externalBarcode,
        货品数量: 0,
      }),
    ]));
    await app.close();
  });

  it("runs WDT goods sync and searches cached specs", async () => {
    const databaseUrl = testDatabaseUrl();
    const app = buildTestServer(databaseUrl, {
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
    }, {
      async queryStock(specNo) {
        return {
          status: 0,
          data: {
            total_count: 3,
            detail_list: [
              { spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 8 },
              { spec_no: specNo, warehouse_no: "LINQI", warehouse_name: "临期仓", available_send_stock: 2 },
              { spec_no: specNo, warehouse_no: "CIPIN", warehouse_name: "次品仓", available_send_stock: 99 },
            ],
          },
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

    const snapshotDatabase = createDatabaseContext(databaseUrl);
    await snapshotDatabase.ready;
    await seedSuccessfulStockSnapshot(snapshotDatabase, {
      verifiedSpecNos: ["3282770392869"],
      rows: [
        { specNo: "3282770392869", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 8 },
        { specNo: "3282770392869", warehouseNo: "LINQI", warehouseName: "临期仓", availableSendStock: 2 },
        { specNo: "3282770392869", warehouseNo: "CIPIN", warehouseName: "次品仓", availableSendStock: 99 },
      ],
    });
    await snapshotDatabase.close();

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
      stockTotalAvailable: 10,
      stockRows: expect.arrayContaining([
        expect.objectContaining({ warehouseNo: "001", warehouseName: "主仓", availableSendStock: 8, included: true }),
        expect.objectContaining({ warehouseNo: "LINQI", warehouseName: "临期仓", availableSendStock: 2, included: true }),
      ]),
    });
    await app.close();
  });

  it("confirms and updates product mappings", async () => {
    const databaseUrl = testDatabaseUrl();
    const app = buildTestServer(databaseUrl, {
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

    const nameOnly = await app.inject({
      method: "POST",
      url: "/api/v1/product-mappings",
      payload: {
        externalBarcode: "",
        externalGoodsCode: "",
        externalGoodsName: "名称只用于人工候选",
        wdtSpecNo: "3282770392869",
        note: "name-only mapping should not be persisted",
      },
      headers: { cookie },
    });
    expect(nameOnly.statusCode).toBe(400);
    expect(nameOnly.json().message).toContain("External barcode or product code is required");

    const list = await app.inject({ method: "GET", url: "/api/v1/product-mappings?query=2153722460015", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    const candidatesAfterConfirm = await app.inject({
      method: "GET",
      url: "/api/v1/product-match-candidates?query=2153722460015",
      headers: { cookie },
    });
    expect(candidatesAfterConfirm.statusCode).toBe(200);
    expect(candidatesAfterConfirm.json()).toHaveLength(0);

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/v1/product-mappings/${created.json().id}/status`,
      payload: { status: "disabled", note: "wrong mapping" },
      headers: { cookie },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ status: "disabled", note: "wrong mapping" });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/product-mappings/${created.json().id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ mappingId: created.json().id, deleted: true });

    const listAfterDelete = await app.inject({ method: "GET", url: "/api/v1/product-mappings?query=2153722460015", headers: { cookie } });
    expect(listAfterDelete.statusCode).toBe(200);
    expect(listAfterDelete.json()).toHaveLength(0);
    await app.close();
  });

  it("lists product match candidates with stock from the active local snapshot", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db.insert(productMatchCandidates).values([
      {
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
      },
      {
        id: `candidate-${randomUUID()}`,
        batchId: "diagnosis-order",
        reviewLineId: "line-2",
        externalBarcode: "2153722460015",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        externalGoodsCode: "5372246",
        wdtSpecNo: "3282770392869",
        wdtGoodsNo: "3282770392869",
        wdtGoodsName: "雅漾专研保湿修护面膜",
        wdtSpecName: "25ml*5",
        wdtBarcode: "3282770392869",
        score: 80,
        basis: "contains_name",
        source: "goods",
        createdAt: "2026-07-03T00:01:00.000Z",
      },
      {
        id: `candidate-${randomUUID()}`,
        batchId: "diagnosis-order",
        reviewLineId: "line-3",
        externalBarcode: "2153722460015",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        externalGoodsCode: "5372246",
        wdtSpecNo: "OTHER-SPEC",
        wdtGoodsNo: "OTHER-GOODS",
        wdtGoodsName: "雅漾专研保湿修护面膜",
        wdtSpecName: "25ml",
        wdtBarcode: "OTHER-BARCODE",
        score: 70,
        basis: "contains_name",
        source: "goods",
        createdAt: "2026-07-03T00:02:00.000Z",
      },
      {
        id: `candidate-${randomUUID()}`,
        batchId: "diagnosis-order",
        reviewLineId: "line-4",
        externalBarcode: "2153722460015",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        externalGoodsCode: "5372246",
        wdtSpecNo: "LOW-STOCK-SPEC",
        wdtGoodsNo: "LOW-STOCK-GOODS",
        wdtGoodsName: "雅漾专研保湿修护面膜",
        wdtSpecName: "低库存规格",
        wdtBarcode: "LOW-STOCK-BARCODE",
        score: 82,
        basis: "contains_name",
        source: "goods",
        createdAt: "2026-07-03T00:03:00.000Z",
      },
    ]);
    await seedSuccessfulStockSnapshot(database, {
      verifiedSpecNos: ["3282770392869", "OTHER-SPEC", "LOW-STOCK-SPEC"],
      rows: [
        { specNo: "3282770392869", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 12 },
        { specNo: "3282770392869", warehouseNo: "LINQI", warehouseName: "临期仓", availableSendStock: 3 },
        { specNo: "3282770392869", warehouseNo: "CIPIN", warehouseName: "次品仓", availableSendStock: 99 },
        { specNo: "LOW-STOCK-SPEC", warehouseNo: "001", warehouseName: "主仓", availableSendStock: -8 },
      ],
    });
    await database.close();
    const stockClient = failingRealtimeStockClient();
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/product-match-candidates?query=2153722460015",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(3);
    expect(response.json()[0]).toMatchObject({ wdtSpecNo: "3282770392869", score: 82, stockTotalAvailable: 15 });
    expect(response.json()[1]).toMatchObject({ wdtSpecNo: "LOW-STOCK-SPEC", score: 82, stockTotalAvailable: 0 });
    expect(response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalBarcode: "2153722460015",
          wdtSpecNo: "3282770392869",
          score: 82,
          basis: "contains_name",
          stockTotalAvailable: 15,
          stockRows: expect.arrayContaining([
            expect.objectContaining({ warehouseNo: "001", warehouseName: "主仓", availableSendStock: 12, included: true }),
            expect.objectContaining({ warehouseNo: "LINQI", warehouseName: "临期仓", availableSendStock: 3, included: true }),
          ]),
        }),
        expect.objectContaining({
          externalBarcode: "2153722460015",
          wdtSpecNo: "OTHER-SPEC",
          score: 70,
          basis: "contains_name",
        }),
        expect.objectContaining({
          externalBarcode: "2153722460015",
          wdtSpecNo: "LOW-STOCK-SPEC",
          score: 82,
          stockTotalAvailable: 0,
          stockRows: [expect.objectContaining({ warehouseNo: "001", availableSendStock: -8, included: true })],
        }),
      ]),
    );
    await app.close();
  });

  it("supplements stored product match candidates with live same-name alternatives", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db.insert(wdtGoodsSpecs).values([
      {
        id: "wdt-goods-spec-live-5ml",
        goodsNo: "020001538",
        goodsName: "【中小样】肌肤之钥金致乳霜",
        specNo: "020001538",
        specName: "5ml",
        barcode: "020001538",
        barcodesJson: JSON.stringify(["020001538"]),
        syncedAt: "2026-07-03T00:00:00.000Z",
      },
      {
        id: "wdt-goods-spec-live-2ml",
        goodsNo: "020001539",
        goodsName: "【中小样】肌肤之钥金致乳霜",
        specNo: "020001539",
        specName: "2ml",
        barcode: "020001539",
        barcodesJson: JSON.stringify(["020001539"]),
        syncedAt: "2026-07-03T00:00:00.000Z",
      },
    ]);
    await database.db.insert(reviewLines).values({
      id: "review-line-live-candidates",
      batchId: "batch-live-candidates",
      sortOrder: 1,
      orderNoticeNo: "ORDER-LIVE",
      excelRow: 2,
      storeNo: "STORE-LIVE",
      storeName: "测试门店",
      uploadTime: "2026-07-03T00:00:00.000Z",
      externalBarcode: "2153659120013",
      externalGoodsCode: "5365912",
      externalGoodsName: "肌肤之钥金致乳霜5ml",
      matchStatus: "ambiguous",
      orderQty: 1,
      suggestedShipQty: 0,
      status: "未匹配",
    });
    await database.close();
    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/product-match-candidates?query=2153659120013",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().map((candidate: { wdtSpecNo: string }) => candidate.wdtSpecNo)).toEqual(["020001538", "020001539"]);
    await app.close();
  });

  it("runs real review from cached goods specs and a local stock snapshot", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSuccessfulStockSnapshot(database, {
      verifiedSpecNos: ["3282770392869"],
      rows: [
        { specNo: "3282770392869", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 15 },
        { specNo: "3282770392869", warehouseNo: "LINQI", warehouseName: "临期仓", availableSendStock: 5 },
      ],
    });
    await database.close();

    const stockClient = failingRealtimeStockClient();
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
    expect(review.json()).toMatchObject({
      batch: {
        status: "review_generated",
        orderLineCount: 40,
        stockSnapshotRunId: expect.stringMatching(/^wdt-sync-/),
        stockSnapshotAt: "2026-07-03T00:01:00.000Z",
      },
      stockQueriedCount: 10,
    });

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

  it("suggests one warehouse per line without combining warehouse stock", async () => {
    const scenarios = [
      { name: "satisfying-near", main: 1, near: 3, expectedQty: 2, expectedWarehouseNo: "LINQI" },
      { name: "tie-main", main: 1, near: 1, expectedQty: 1, expectedWarehouseNo: "001" },
      { name: "largest-near", main: 0, near: 1, expectedQty: 1, expectedWarehouseNo: "LINQI" },
      { name: "negative-main", main: -8, near: 0, expectedQty: 0, expectedWarehouseNo: "" },
      { name: "negative-main-positive-near", main: -8, near: 10, expectedQty: 2, expectedWarehouseNo: "LINQI" },
    ];

    for (const scenario of scenarios) {
      const databaseUrl = testDatabaseUrl();
      const database = createDatabaseContext(databaseUrl);
      await database.ready;
      await seedSuccessfulGoodsCache(database);
      await seedSingleComponentSuite(database);
      await seedSuccessfulStockSnapshot(database, {
        verifiedSpecNos: ["021700004"],
        rows: [
          { specNo: "021700004", warehouseNo: "001", warehouseName: "主仓", availableSendStock: scenario.main },
          { specNo: "021700004", warehouseNo: "LINQI", warehouseName: "临期仓", availableSendStock: scenario.near },
        ],
      });
      await database.close();
      const suiteOrderFile = createSuiteOrderFile(resolve(projectRoot, `outputs/fixtures/suite-order-${scenario.name}.xlsx`));
      const stockClient: StockLookupClient = {
        async queryStock(specNo) {
          return {
            status: 0,
            data: {
              total_count: 2,
              detail_list: [
                { spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: scenario.main },
                { spec_no: specNo, warehouse_no: "LINQI", warehouse_name: "临期仓", available_send_stock: scenario.near },
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
        payload: { filePath: suiteOrderFile, mode: "production_api" },
        headers: { cookie },
      });
      await app.inject({
        method: "POST",
        url: `/api/v1/batches/${created.json().id}/actions/run-real-review`,
        payload: {},
        headers: { cookie },
      });
      const linesResponse = await app.inject({
        method: "GET",
        url: `/api/v1/batches/${created.json().id}/review-lines`,
        headers: { cookie },
      });
      expect(linesResponse.json()[0]).toMatchObject({
        mainAvailableBefore: Math.max(0, scenario.main),
        nearExpiryAvailableBefore: Math.max(0, scenario.near),
        suggestedShipQty: scenario.expectedQty,
        approvedShipQty: scenario.expectedQty,
        suggestedWarehouseNo: scenario.expectedWarehouseNo,
        fulfillmentWarehouseNo: scenario.expectedWarehouseNo,
        status: scenario.expectedQty === 0 ? "库存不足" : scenario.expectedQty >= 2 ? "库存充足" : "部分满足",
      });
      await app.close();
    }
  });

  it("matches single-component WDT suites and exports the suite code for make-order", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleComponentSuite(database);
    await seedSingleWarehouseSnapshot(database, "021700004", 10);
    await database.close();

    const suiteOrderFile = createSuiteOrderFile(resolve(projectRoot, "outputs/fixtures/suite-order.xlsx"));
    const stockClient: StockLookupClient = {
      async queryStock(specNo) {
        expect(specNo).toBe("021700004");
        return {
          status: 0,
          data: {
            total_count: 1,
            detail_list: [{ spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 10 }],
          },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: suiteOrderFile, mode: "production_api" },
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
    expect(review.json()).toMatchObject({ stockQueriedCount: 1 });

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${batch.id}/review-lines`,
      headers: { cookie },
    });
    const [line] = linesResponse.json();
    expect(line).toMatchObject({
      matchStatus: "matched",
      wdtSpecNo: "021700004",
      wdtMakeOrderCode: "2150317560013",
      decision: "ship",
      approvedShipQty: 2,
    });
    await seedStoreAddresses(app, cookie, [line]);
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/actions/submit-review`,
      payload: { confirmUnverifiedStock: false },
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);

    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batch.id}/exports`,
      payload: { type: "wdt_import" },
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(201);
    const downloadResponse = await app.inject({
      method: "GET",
      url: exportResponse.json().downloadUrl,
      headers: { cookie },
    });
    const workbook = XLSX.read(downloadResponse.rawPayload, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["Sheet1"], { defval: "" });
    expect(rows[0]).toMatchObject({
      商家编码: "2150317560013",
      货品数量: 2,
    });
    await app.close();
  });

  it("matches multi-component suites and reapplies the saved product priority only after explicit recalculation", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedMultiComponentSuiteAndSharedGoods(database);
    await seedVipStoreAddress(database, "VIP-SUITE", "VIP组合装门店");
    await seedVipStoreAddress(database, "VIP-GOODS", "VIP普通商品门店");
    await seedSuccessfulStockSnapshot(database, {
      runId: "wdt-sync-shared-components",
      verifiedSpecNos: ["SHARED-A", "SUITE-B"],
      rows: [
        { specNo: "SHARED-A", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 5 },
        { specNo: "SHARED-A", warehouseNo: "CIPIN", warehouseName: "次品仓", availableSendStock: 7 },
        { specNo: "SUITE-B", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 10 },
        { specNo: "SUITE-B", warehouseNo: "CIPIN", warehouseName: "次品仓", availableSendStock: 8 },
      ],
    });
    await database.close();

    const app = buildTestServer(databaseUrl, undefined, failingRealtimeStockClient());
    const cookie = await loginCookie(app);
    const orderFilePath = createSharedComponentPriorityOrderFile();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFilePath, mode: "production_api" },
      headers: { cookie },
    });
    const batchId = created.json().id;
    const firstReview = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batchId}/actions/run-real-review`,
      payload: {},
      headers: { cookie },
    });
    expect(firstReview.statusCode).toBe(200);
    expect(firstReview.json().batch).toMatchObject({
      allocationPriority: "suite_first",
      stockSnapshotRunId: "wdt-sync-shared-components",
    });

    const firstLinesResponse = await app.inject({ method: "GET", url: `/api/v1/batches/${batchId}/review-lines`, headers: { cookie } });
    const firstLines = firstLinesResponse.json() as ReviewLineDto[];
    const suiteFirst = reviewLinesByStore(firstLines);
    expect(suiteFirst.get("VIP-SUITE")).toMatchObject({ productType: "suite", suggestedShipQty: 2, suggestedWarehouseNo: "001" });
    expect(suiteFirst.get("VIP-GOODS")).toMatchObject({ productType: "goods", suggestedShipQty: 2, suggestedWarehouseNo: "001" });
    expect(suiteFirst.get("REG-SUITE")).toMatchObject({ productType: "suite", suggestedShipQty: 1, suggestedWarehouseNo: "001" });
    expect(suiteFirst.get("REG-GOODS")).toMatchObject({ productType: "goods", suggestedShipQty: 0, suggestedWarehouseNo: "" });
    expect(suiteFirst.get("VIP-SUITE")?.componentStocks).toEqual([
      expect.objectContaining({
        specNo: "SHARED-A",
        quantityPerItem: 1,
        mainAvailableStock: 5,
        defectAvailableStock: 7,
        warehouses: expect.arrayContaining([
          expect.objectContaining({ warehouseNo: "001", availableStock: 5 }),
          expect.objectContaining({ warehouseNo: "CIPIN", availableStock: 7 }),
        ]),
      }),
      expect.objectContaining({
        specNo: "SUITE-B",
        quantityPerItem: 1,
        mainAvailableStock: 10,
        defectAvailableStock: 8,
      }),
    ]);

    const changedSettings = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/warehouse-usage",
      payload: {
        includeMainWarehouse: true,
        includeNearExpiryWarehouse: true,
        includeDefectWarehouse: false,
        includeOtherWarehouses: false,
        sharedComponentPriority: "goods_first",
      },
      headers: { cookie },
    });
    expect(changedSettings.statusCode).toBe(200);
    expect(changedSettings.json()).toMatchObject({ sharedComponentPriority: "goods_first" });

    const unchangedLines = await app.inject({ method: "GET", url: `/api/v1/batches/${batchId}/review-lines`, headers: { cookie } });
    expect(unchangedLines.json().map((line: { suggestedShipQty: number }) => line.suggestedShipQty))
      .toEqual(firstLines.map((line: { suggestedShipQty: number }) => line.suggestedShipQty));

    const recalculated = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${batchId}/actions/run-real-review`,
      payload: {},
      headers: { cookie },
    });
    expect(recalculated.statusCode).toBe(200);
    expect(recalculated.json().batch).toMatchObject({ allocationPriority: "goods_first" });
    const recalculatedLines = await app.inject({ method: "GET", url: `/api/v1/batches/${batchId}/review-lines`, headers: { cookie } });
    const goodsFirst = reviewLinesByStore(recalculatedLines.json() as ReviewLineDto[]);
    expect(goodsFirst.get("VIP-GOODS")).toMatchObject({ suggestedShipQty: 2 });
    expect(goodsFirst.get("VIP-SUITE")).toMatchObject({ suggestedShipQty: 2 });
    expect(goodsFirst.get("REG-GOODS")).toMatchObject({ suggestedShipQty: 1 });
    expect(goodsFirst.get("REG-SUITE")).toMatchObject({ suggestedShipQty: 0 });

    const changedSource = createDatabaseContext(databaseUrl);
    await changedSource.ready;
    await changedSource.db.update(wdtSuiteComponents).set({ quantity: 9 }).where(eq(wdtSuiteComponents.id, "wdt-suite-component-multi-b"));
    await changedSource.db.update(wdtStockSnapshotRows).set({ availableSendStock: 99 }).where(eq(wdtStockSnapshotRows.id, "wdt-sync-shared-components-row-0"));
    await changedSource.close();

    const persistedLines = await app.inject({ method: "GET", url: `/api/v1/batches/${batchId}/review-lines`, headers: { cookie } });
    const persistedSuite = reviewLinesByStore(persistedLines.json() as ReviewLineDto[]).get("VIP-SUITE");
    expect(persistedSuite?.componentStocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ specNo: "SHARED-A", quantityPerItem: 1, mainAvailableStock: 5 }),
      expect.objectContaining({ specNo: "SUITE-B", quantityPerItem: 1, mainAvailableStock: 10 }),
    ]));
    await app.close();
  });

  it("returns WDT suites from manual goods search and stores suite make-order codes in mappings", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSingleComponentSuite(database);
    await seedSingleWarehouseSnapshot(database, "021700004", 8);
    await database.close();

    const stockClient: StockLookupClient = {
      async queryStock(specNo) {
        expect(specNo).toBe("021700004");
        return {
          status: 0,
          data: {
            total_count: 1,
            detail_list: [{ spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 8 }],
          },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);

    const search = await app.inject({
      method: "GET",
      url: "/api/v1/wdt/goods-specs/search?query=2150317560013",
      headers: { cookie },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()[0]).toMatchObject({
      source: "suite",
      goodsNo: "2150317560013",
      specNo: "021700004",
      makeOrderCode: "2150317560013",
      stockTotalAvailable: 8,
    });

    const mapping = await app.inject({
      method: "POST",
      url: "/api/v1/product-mappings",
      payload: {
        externalBarcode: "EXTERNAL-SUITE",
        externalGoodsName: "外部组合装",
        wdtSpecNo: "021700004",
        wdtMakeOrderCode: "2150317560013",
        note: "组合装人工映射",
      },
      headers: { cookie },
    });
    expect(mapping.statusCode).toBe(201);
    expect(mapping.json()).toMatchObject({
      externalBarcode: "EXTERNAL-SUITE",
      wdtSpecNo: "021700004",
      wdtMakeOrderCode: "2150317560013",
    });
    await app.close();
  });

  it("uses WDT available send stock instead of physical stock numbers", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSingleWarehouseSnapshot(database, "3282770392869", 1, "MAIN-A", "OLE主仓");
    await database.close();

    const stockClient: StockLookupClient = {
      async queryStock(specNo) {
        return {
          status: 0,
          data: {
            total_count: 1,
            detail_list: [
              { spec_no: specNo, warehouse_no: "MAIN-A", warehouse_name: "OLE主仓", stock_num: 999, available_stock: "1" },
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
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${created.json().id}/actions/run-real-review`,
      payload: {},
      headers: { cookie },
    });
    expect(review.statusCode).toBe(200);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${created.json().id}/review-lines`,
      headers: { cookie },
    });
    const firstMatched = linesResponse.json().find((line: { wdtSpecNo: string }) => line.wdtSpecNo === "3282770392869");
    expect(firstMatched).toMatchObject({
      matchStatus: "matched",
      mainAvailableBefore: 1,
      suggestedShipQty: 1,
      status: "部分满足",
      decision: "ship",
      approvedShipQty: 1,
    });
    expect(firstMatched.warehouseBreakdown ?? "").not.toContain("999");
    await app.close();
  });

  it("allocates scarce stock fairly among VIP stores before regular stores", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedVipAllocationGoodsCache(database);
    await seedVipStoreAddress(database, "VIP-1", "VIP一店");
    await seedVipStoreAddress(database, "VIP-2", "VIP二店");
    await seedSingleWarehouseSnapshot(database, "VIP-SPEC", 6);
    await database.close();

    const stockClient: StockLookupClient = {
      async queryStock(specNo) {
        return {
          status: 0,
          data: {
            total_count: 1,
            detail_list: [{ spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 6 }],
          },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const orderFilePath = createVipAllocationOrderFile("vip-short");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFilePath, mode: "production_api" },
      headers: { cookie },
    });
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${created.json().id}/actions/run-real-review`,
      payload: {},
      headers: { cookie },
    });
    expect(review.statusCode).toBe(200);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${created.json().id}/review-lines`,
      headers: { cookie },
    });
    const byStore = reviewLinesByStore(linesResponse.json());
    expect(byStore.get("VIP-1")).toMatchObject({ suggestedShipQty: 3, status: "部分满足", decision: "ship", approvedShipQty: 3 });
    expect(byStore.get("VIP-2")).toMatchObject({ suggestedShipQty: 3, status: "部分满足", decision: "ship", approvedShipQty: 3 });
    expect(byStore.get("REG-1")).toMatchObject({ suggestedShipQty: 0, status: "库存不足" });
    expect(byStore.get("REG-2")).toMatchObject({ suggestedShipQty: 0, status: "库存不足" });
    await app.close();
  });

  it("shares remaining stock fairly among regular stores after VIP stores are filled", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedVipAllocationGoodsCache(database);
    await seedVipStoreAddress(database, "VIP-1", "VIP一店");
    await seedVipStoreAddress(database, "VIP-2", "VIP二店");
    await seedSingleWarehouseSnapshot(database, "VIP-SPEC", 10);
    await database.close();

    const stockClient: StockLookupClient = {
      async queryStock(specNo) {
        return {
          status: 0,
          data: {
            total_count: 1,
            detail_list: [{ spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 10 }],
          },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);
    const orderFilePath = createVipAllocationOrderFile("regular-short");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/batches",
      payload: { filePath: orderFilePath, mode: "production_api" },
      headers: { cookie },
    });
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/batches/${created.json().id}/actions/run-real-review`,
      payload: {},
      headers: { cookie },
    });
    expect(review.statusCode).toBe(200);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${created.json().id}/review-lines`,
      headers: { cookie },
    });
    const byStore = reviewLinesByStore(linesResponse.json());
    expect(byStore.get("VIP-1")).toMatchObject({ suggestedShipQty: 4, status: "库存充足" });
    expect(byStore.get("VIP-2")).toMatchObject({ suggestedShipQty: 4, status: "库存充足" });
    expect(byStore.get("REG-1")).toMatchObject({ suggestedShipQty: 1, status: "部分满足", decision: "ship", approvedShipQty: 1 });
    expect(byStore.get("REG-2")).toMatchObject({ suggestedShipQty: 1, status: "部分满足", decision: "ship", approvedShipQty: 1 });
    await app.close();
  });

  it("applies warehouse usage settings to real review suggestions", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulGoodsCache(database);
    await seedSuccessfulStockSnapshot(database, {
      verifiedSpecNos: ["3282770392869"],
      rows: [
        { specNo: "3282770392869", warehouseNo: "001", warehouseName: "main", availableSendStock: 1 },
        { specNo: "3282770392869", warehouseNo: "LINQI", warehouseName: "near-expiry", availableSendStock: 40 },
        { specNo: "3282770392869", warehouseNo: "002", warehouseName: "other", availableSendStock: 40 },
      ],
    });
    await database.close();

    const stockClient: StockLookupClient = {
      async queryStock(specNo) {
        return {
          status: 0,
          data: {
            total_count: 3,
            detail_list: [
              { spec_no: specNo, warehouse_no: "001", warehouse_name: "main", available_send_stock: 1 },
              { spec_no: specNo, warehouse_no: "LINQI", warehouse_name: "near-expiry", available_send_stock: 40 },
              { spec_no: specNo, warehouse_no: "002", warehouse_name: "other", available_send_stock: 40 },
            ],
          },
        };
      },
    };
    const app = buildTestServer(databaseUrl, undefined, stockClient);
    const cookie = await loginCookie(app);

    const settings = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/warehouse-usage",
      payload: {
        includeMainWarehouse: true,
        includeNearExpiryWarehouse: false,
        includeDefectWarehouse: false,
        includeOtherWarehouses: true,
      },
      headers: { cookie },
    });
    expect(settings.statusCode).toBe(200);

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
    expect(review.statusCode).toBe(200);

    const linesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/batches/${created.json().id}/review-lines`,
      headers: { cookie },
    });
    const firstMatched = linesResponse.json().find((line: { wdtSpecNo: string }) => line.wdtSpecNo === "3282770392869");
    expect(firstMatched).toMatchObject({
      matchStatus: "matched",
      mainAvailableBefore: 1,
      nearExpiryAvailableBefore: 40,
      suggestedShipQty: 4,
    });
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

  it("returns the latest combined sync state, history, and active snapshot metadata", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulStockSnapshot(database, {
      runId: "wdt-sync-success-history",
      finishedAt: "2026-07-03T00:02:00.000Z",
      verifiedSpecNos: ["SPEC-HISTORY"],
      rows: [{ specNo: "SPEC-HISTORY", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 7 }],
    });
    await database.db.insert(wdtSyncRuns).values({
      id: "wdt-sync-failed-latest",
      trigger: "hourly",
      status: "failed",
      stage: "complete",
      goodsSyncRunId: "",
      totalSpecCount: 40,
      processedSpecCount: 0,
      totalBatchCount: 1,
      completedBatchCount: 0,
      stockRowCount: 0,
      startedAt: "2026-07-03T01:00:00.000Z",
      finishedAt: "2026-07-03T01:00:05.000Z",
      lastProgressAt: "2026-07-03T01:00:05.000Z",
      errorCode: "WDT_STOCK_ERROR",
      errorMessage: "旺店通库存同步失败",
      errorDetail: "status=100 raw response",
    });
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const latest = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      id: "wdt-sync-failed-latest",
      trigger: "hourly",
      status: "failed",
      errorCode: "WDT_STOCK_ERROR",
      errorDetail: "status=100 raw response",
      activeSnapshotRunId: "wdt-sync-success-history",
      activeSnapshotAt: "2026-07-03T00:02:00.000Z",
      activeSnapshotTrigger: "manual",
    });

    const history = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs", headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json().map((run: { id: string }) => run.id)).toEqual(["wdt-sync-failed-latest", "wdt-sync-success-history"]);
    expect(history.json()[0]).toMatchObject({
      activeSnapshotRunId: "wdt-sync-success-history",
      activeSnapshotAt: "2026-07-03T00:02:00.000Z",
      activeSnapshotTrigger: "manual",
    });
    await app.close();
  });

  it("starts a combined goods and stock sync in the background and reuses its active task", async () => {
    const databaseUrl = testDatabaseUrl();
    let releaseGoods!: () => void;
    const goodsGate = new Promise<void>((resolve) => { releaseGoods = resolve; });
    let goodsCalls = 0;
    let suiteCalls = 0;
    let stockCalls = 0;
    const app = buildTestServer(databaseUrl, {
      async queryGoodsWindow() {
        goodsCalls += 1;
        await goodsGate;
        return {
          totalCount: 1,
          goods: [{ goods_no: "SYNC-GOODS", goods_name: "同步商品", spec_list: [{ spec_no: "SYNC-SPEC", barcode: "SYNC-SPEC" }] }],
        };
      },
    }, {
      async queryStock(specNo) {
        stockCalls += 1;
        return { status: 0, data: { total_count: 1, detail_list: [{ spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 5 }] } };
      },
      async queryStocks(specNos) {
        stockCalls += 1;
        const detailList = specNos.flatMap((specNo) => [
          { spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 5 },
          { spec_no: specNo, warehouse_no: "LINQI", warehouse_name: "临期仓", available_send_stock: 2 },
          { spec_no: specNo, warehouse_no: "CIPIN", warehouse_name: "次品仓", available_send_stock: 99 },
          { spec_no: specNo, warehouse_no: "OTHER-1", warehouse_name: "外部仓", available_send_stock: 88 },
        ]);
        return { status: 0, data: { total_count: detailList.length, detail_list: detailList } };
      },
    }, {
      wdtSuiteClient: {
        async querySuitesWindow() {
          suiteCalls += 1;
          return {
            totalCount: 1,
            suites: [{
              suite_no: "SYNC-SUITE",
              suite_name: "同步组合装",
              barcode: "SYNC-SUITE-BARCODE",
              detail_list: [{ rec_id: "1", spec_no: "SUITE-COMPONENT", goods_name: "组合装组件", num: 1 }],
            }],
          };
        },
      },
    });
    const cookie = await loginCookie(app);
    const first = await app.inject({ method: "POST", url: "/api/v1/wdt/sync-runs", headers: { cookie } });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ alreadyRunning: false, run: { trigger: "manual", status: "queued" } });
    const second = await app.inject({ method: "POST", url: "/api/v1/wdt/sync-runs", headers: { cookie } });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ alreadyRunning: true, run: { id: first.json().run.id } });
    await expect.poll(() => goodsCalls).toBe(1);

    releaseGoods();
    await expect.poll(async () => (await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } })).json().status).toBe("success");
    expect(suiteCalls).toBeGreaterThan(0);
    expect(stockCalls).toBe(1);
    const completed = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } });
    expect(completed.json()).toMatchObject({
      status: "success",
      activeSnapshotRunId: first.json().run.id,
      activeSnapshotTrigger: "manual",
      totalSpecCount: 2,
      processedSpecCount: 2,
      activeSnapshotWarehouseTypes: ["main", "near_expiry"],
      activeSnapshotMissingWarehouseTypes: [],
    });
    const checked = createDatabaseContext(databaseUrl);
    await checked.ready;
    const persistedRows = await checked.db.select().from(wdtStockSnapshotRows).where(eq(wdtStockSnapshotRows.syncRunId, first.json().run.id));
    expect(persistedRows.map((row) => row.warehouseNo).sort()).toEqual(["001", "001", "LINQI", "LINQI"]);
    const persistedSuites = await checked.db.select().from(wdtSuites);
    const persistedComponents = await checked.db.select().from(wdtSuiteComponents);
    expect(persistedSuites).toEqual([expect.objectContaining({ suiteNo: "SYNC-SUITE", barcode: "SYNC-SUITE-BARCODE" })]);
    expect(persistedComponents).toEqual([expect.objectContaining({ suiteNo: "SYNC-SUITE", specNo: "SUITE-COMPONENT" })]);
    const coverage = await checked.db.select().from(wdtStockSnapshotWarehouseCoverage).where(eq(wdtStockSnapshotWarehouseCoverage.syncRunId, first.json().run.id));
    expect(coverage.map((row) => row.warehouseType)).toEqual(["main", "near_expiry"]);
    expect(coverage.every((row) => row.apiWarehouseNo === "")).toBe(true);
    await checked.close();
    const goodsCallsAfterSync = goodsCalls;
    const settingsUpdate = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/warehouse-usage",
      headers: { cookie },
      payload: {
        includeMainWarehouse: true,
        includeNearExpiryWarehouse: true,
        includeDefectWarehouse: true,
        includeOtherWarehouses: false,
      },
    });
    expect(settingsUpdate.statusCode).toBe(200);
    const scopeMismatch = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } });
    expect(scopeMismatch.json()).toMatchObject({ activeSnapshotMissingWarehouseTypes: ["defect"] });
    expect(goodsCalls).toBe(goodsCallsAfterSync);
    await app.close();
  });

  it("recovers interrupted sync runs and removes their incomplete snapshot rows on startup", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db.insert(wdtSyncRuns).values({
      id: "wdt-sync-interrupted",
      trigger: "hourly",
      status: "running",
      stage: "stock",
      goodsSyncRunId: "goods-interrupted",
      totalSpecCount: 1,
      processedSpecCount: 1,
      totalBatchCount: 1,
      completedBatchCount: 1,
      stockRowCount: 1,
      startedAt: "2026-07-11T00:00:00.000Z",
      finishedAt: "",
      lastProgressAt: "2026-07-11T00:01:00.000Z",
      errorCode: "",
      errorMessage: "",
      errorDetail: "",
    });
    await database.db.insert(wdtStockSnapshotSpecs).values({ syncRunId: "wdt-sync-interrupted", specNo: "SPEC-PARTIAL", syncedAt: "2026-07-11T00:01:00.000Z" });
    await database.db.insert(wdtStockSnapshotRows).values({
      id: "stock-partial",
      syncRunId: "wdt-sync-interrupted",
      specNo: "SPEC-PARTIAL",
      warehouseNo: "001",
      warehouseName: "主仓",
      availableSendStock: 5,
      rawJson: "{}",
      syncedAt: "2026-07-11T00:01:00.000Z",
    });
    await database.close();

    const app = buildTestServer(databaseUrl);
    const cookie = await loginCookie(app);
    const latest = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } });
    expect(latest.json()).toMatchObject({ id: "wdt-sync-interrupted", status: "failed", errorCode: "INTERRUPTED" });
    await app.close();

    const checked = createDatabaseContext(databaseUrl);
    await checked.ready;
    expect(await checked.db.select().from(wdtStockSnapshotSpecs).where(eq(wdtStockSnapshotSpecs.syncRunId, "wdt-sync-interrupted"))).toHaveLength(0);
    expect(await checked.db.select().from(wdtStockSnapshotRows).where(eq(wdtStockSnapshotRows.syncRunId, "wdt-sync-interrupted"))).toHaveLength(0);
    await checked.close();
  });

  it("queues a startup compensation sync only when the active snapshot is missing or stale", async () => {
    const missingDatabaseUrl = testDatabaseUrl();
    let missingGoodsCalls = 0;
    const goodsClient: WdtGoodsWindowClient = {
      async queryGoodsWindow() {
        missingGoodsCalls += 1;
        return { totalCount: 0, goods: [] };
      },
    };
    const missingApp = buildTestServer(missingDatabaseUrl, goodsClient, fixedWarehouseStockClient(), { autoSyncEnabled: true });
    const missingCookie = await loginCookie(missingApp);
    await expect.poll(async () => (await missingApp.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie: missingCookie } })).json().status).toBe("success");
    const startupRun = await missingApp.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie: missingCookie } });
    expect(startupRun.json()).toMatchObject({ trigger: "startup", status: "success" });
    expect(missingGoodsCalls).toBeGreaterThan(0);
    await missingApp.close();

    const freshDatabaseUrl = testDatabaseUrl();
    const freshDatabase = createDatabaseContext(freshDatabaseUrl);
    await freshDatabase.ready;
    await seedSuccessfulStockSnapshot(freshDatabase, {
      finishedAt: new Date().toISOString(),
      verifiedSpecNos: [],
    });
    await freshDatabase.close();
    let freshGoodsCalls = 0;
    const freshApp = buildTestServer(freshDatabaseUrl, {
      async queryGoodsWindow() {
        freshGoodsCalls += 1;
        return { totalCount: 0, goods: [] };
      },
    }, fixedWarehouseStockClient(), { autoSyncEnabled: true });
    const freshCookie = await loginCookie(freshApp);
    const freshLatest = await freshApp.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie: freshCookie } });
    expect(freshLatest.json()).toMatchObject({ status: "success", trigger: "manual" });
    expect(freshGoodsCalls).toBe(0);
    await freshApp.close();
  });

  it("returns 404 when no combined sync run has been recorded", async () => {
    const app = buildTestServer();
    const cookie = await loginCookie(app);
    const latest = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } });
    expect(latest.statusCode).toBe(404);
    expect(latest.json().message).toContain("not found");
    await app.close();
  });

  it("quick sync refreshes only changed specs and copies untouched stock from the active snapshot", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db.insert(wdtGoodsSpecs).values([
      {
        id: "wdt-goods-spec-QUICK-A",
        goodsNo: "GOODS-A",
        goodsName: "旧商品A",
        specNo: "QUICK-A",
        specName: "规格A",
        specCode: "",
        barcode: "BAR-A",
        barcodesJson: "[]",
        deleted: 0,
        modified: "2026-07-15 09:00:00",
        rawJson: "{}",
        syncedAt: "2026-07-15T01:00:00.000Z",
      },
      {
        id: "wdt-goods-spec-UNCHANGED-B",
        goodsNo: "GOODS-B",
        goodsName: "未变化商品B",
        specNo: "UNCHANGED-B",
        specName: "规格B",
        specCode: "",
        barcode: "BAR-B",
        barcodesJson: "[]",
        deleted: 0,
        modified: "2026-07-14 09:00:00",
        rawJson: "{}",
        syncedAt: "2026-07-15T01:00:00.000Z",
      },
    ]);
    const baseline = await seedSuccessfulStockSnapshot(database, {
      runId: "wdt-sync-quick-baseline",
      finishedAt: "2026-07-15T01:00:00.000Z",
      verifiedSpecNos: ["QUICK-A", "UNCHANGED-B"],
      rows: [
        { specNo: "QUICK-A", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 2 },
        { specNo: "UNCHANGED-B", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 7 },
      ],
      warehouseTypes: ["main", "near_expiry"],
    });
    await database.close();

    const requestedStockSpecs: string[][] = [];
    const app = buildTestServer(databaseUrl, {
      async queryGoodsWindow(input) {
        expect(input.hideDeleted).toBe(false);
        return {
          totalCount: 1,
          goods: [{
            goods_no: "GOODS-A",
            goods_name: "新商品A",
            modified: "2026-07-16 08:00:00",
            spec_list: [{ spec_no: "QUICK-A", barcode: "BAR-A", spec_name: "规格A" }],
          }],
        };
      },
    }, {
      async queryStock(specNo) {
        return { status: 0, data: { total_count: 1, detail_list: [{ spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 9 }] } };
      },
      async queryStocks(specNos) {
        requestedStockSpecs.push([...specNos]);
        return { status: 0, data: { total_count: specNos.length, detail_list: specNos.map((specNo) => ({ spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 9 })) } };
      },
    });
    const cookie = await loginCookie(app);
    const started = await app.inject({ method: "POST", url: "/api/v1/wdt/quick-sync-runs", headers: { cookie } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ alreadyRunning: false, run: { trigger: "quick_manual", status: "queued" } });
    await expect.poll(async () => (await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } })).json().status).toBe("success");
    const completed = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } });
    expect(completed.json()).toMatchObject({
      trigger: "quick_manual",
      status: "success",
      totalSpecCount: 1,
      processedSpecCount: 1,
      activeSnapshotTrigger: "quick_manual",
    });
    expect(requestedStockSpecs).toEqual([["QUICK-A"]]);

    const checked = createDatabaseContext(databaseUrl);
    await checked.ready;
    const quickRunId = completed.json().id;
    const rows = await checked.db.select().from(wdtStockSnapshotRows).where(eq(wdtStockSnapshotRows.syncRunId, quickRunId));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ specNo: "QUICK-A", availableSendStock: 9 }),
      expect.objectContaining({ specNo: "UNCHANGED-B", availableSendStock: 7 }),
    ]));
    expect(rows).toHaveLength(2);
    expect(await checked.db.select().from(wdtStockSnapshotRows).where(eq(wdtStockSnapshotRows.syncRunId, baseline.runId))).toHaveLength(2);
    expect(await checked.db.select().from(wdtGoodsSpecs).where(eq(wdtGoodsSpecs.specNo, "QUICK-A"))).toEqual([
      expect.objectContaining({ goodsName: "新商品A" }),
    ]);
    await checked.close();
    await app.close();
  });

  it("quick sync refuses a warehouse coverage mismatch and keeps the old snapshot active", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await seedSuccessfulStockSnapshot(database, {
      runId: "wdt-sync-coverage-baseline",
      verifiedSpecNos: [],
      warehouseTypes: ["main"],
    });
    await database.close();
    let stockCalls = 0;
    const app = buildTestServer(databaseUrl, {
      async queryGoodsWindow() {
        return { totalCount: 0, goods: [] };
      },
    }, {
      async queryStock() {
        stockCalls += 1;
        return { status: 0, data: { total_count: 0, detail_list: [] } };
      },
    });
    const cookie = await loginCookie(app);
    await app.inject({ method: "POST", url: "/api/v1/wdt/quick-sync-runs", headers: { cookie } });
    await expect.poll(async () => (await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } })).json().status).toBe("failed");
    const latest = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } });
    expect(latest.json()).toMatchObject({
      trigger: "quick_manual",
      status: "failed",
      activeSnapshotRunId: "wdt-sync-coverage-baseline",
      errorMessage: "快速同步未生效，请使用完整同步",
    });
    expect(stockCalls).toBe(0);
    await app.close();
  });

  it("quick sync rejects an incomplete changed-goods response before querying stock", async () => {
    const databaseUrl = testDatabaseUrl();
    const database = createDatabaseContext(databaseUrl);
    await database.ready;
    await database.db.insert(wdtGoodsSpecs).values([
      { id: "wdt-goods-spec-A", goodsNo: "GOODS-PAIR", goodsName: "组合货品", specNo: "PAIR-A", specName: "A", specCode: "", barcode: "A", barcodesJson: "[]", deleted: 0, modified: "", rawJson: "{}", syncedAt: "2026-07-15T01:00:00.000Z" },
      { id: "wdt-goods-spec-B", goodsNo: "GOODS-PAIR", goodsName: "组合货品", specNo: "PAIR-B", specName: "B", specCode: "", barcode: "B", barcodesJson: "[]", deleted: 0, modified: "", rawJson: "{}", syncedAt: "2026-07-15T01:00:00.000Z" },
    ]);
    await seedSuccessfulStockSnapshot(database, {
      runId: "wdt-sync-pair-baseline",
      verifiedSpecNos: ["PAIR-A", "PAIR-B"],
      rows: [
        { specNo: "PAIR-A", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 1 },
        { specNo: "PAIR-B", warehouseNo: "001", warehouseName: "主仓", availableSendStock: 2 },
      ],
      warehouseTypes: ["main", "near_expiry"],
    });
    await database.close();
    let stockCalls = 0;
    const app = buildTestServer(databaseUrl, {
      async queryGoodsWindow() {
        return { totalCount: 1, goods: [{ goods_no: "GOODS-PAIR", spec_list: [{ spec_no: "PAIR-A" }] }] };
      },
    }, {
      async queryStock() {
        stockCalls += 1;
        return { status: 0, data: { total_count: 0, detail_list: [] } };
      },
    });
    const cookie = await loginCookie(app);
    await app.inject({ method: "POST", url: "/api/v1/wdt/quick-sync-runs", headers: { cookie } });
    await expect.poll(async () => (await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } })).json().status).toBe("failed");
    const latest = await app.inject({ method: "GET", url: "/api/v1/wdt/sync-runs/latest", headers: { cookie } });
    expect(latest.json()).toMatchObject({ activeSnapshotRunId: "wdt-sync-pair-baseline", status: "failed" });
    expect(latest.json().errorDetail).toContain("PAIR-B");
    expect(stockCalls).toBe(0);
    await app.close();
  });
});

function clearRuntimeEnvForTests() {
  process.env.NODE_ENV = "test";
  delete process.env.JY_TRADE_UPLOAD_DIR;
  delete process.env.JY_TRADE_EXPORTS_DIR;
  delete process.env.JY_TRADE_BOOTSTRAP_USERNAME;
  delete process.env.JY_TRADE_BOOTSTRAP_PASSWORD;
  delete process.env.WDT_ENV;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("WDT_PROD_") || key.startsWith("WDT_TEST_")) {
      delete process.env[key];
    }
  }
}

function buildTestServer(
  databaseUrl = testDatabaseUrl(),
  wdtGoodsClient?: WdtGoodsWindowClient,
  stockClient?: StockLookupClient,
  options: Partial<StoreOptions> = {},
) {
  return buildApiServer({
    wdtSuiteClient: {
      async querySuitesWindow() {
        return { totalCount: 0, suites: [] };
      },
    },
    ...options,
    databaseUrl,
    projectRoot,
    logger: false,
    wdtGoodsClient,
    stockClient,
  });
}

function testDatabaseUrl() {
  return `file:../../outputs/api-test-${randomUUID()}.db`;
}

function createSuiteOrderFile(filePath: string) {
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        订货通知单号: "SUITE-NOTICE-001",
        订货审批单号: "SUITE-APPROVAL-001",
        阅读状态: "已读",
        送货方式: "配送",
        状态: "待处理",
        送货地: "测试仓",
        大类: "测试品类",
        门店: "STORE-SUITE",
        门店名称: "组合装测试门店",
        订货日期: "2026-07-09",
        截止日期: "2026-07-10",
        上传时间: "2026-07-09 10:00:00",
        业务员: "测试业务员",
        制单人: "测试制单人",
        制单时间: "2026-07-09 09:00:00",
        审核人: "测试审核人",
        商品编码: "2150317560013",
        商品名称: "lelabo护发素(33檀香系列)50ml",
        商品条码: "2150317560013",
        规格: "50ml",
        运输规格: "测试运输规格",
        订货箱数: "1",
        订货数: "2",
        未含税进价: "10.00",
        含税合同进价: "11.30",
        含税进价: "11.30",
        折扣率: "1",
        "保质期(天)": "365",
        实收数量: "",
        赠品率: "0",
        TD: "",
        DA: "",
        PD: "",
        SPD: "",
        REBATE: "",
      },
    ]),
    "订货通知单",
  );
  writeFileSync(filePath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
  return filePath;
}

async function createReviewedBatch(
  app: ReturnType<typeof buildApiServer>,
  mockDataFile = "examples/mock_flow_data.json",
  sourceOrderFile?: string,
  options: { seedAddresses?: boolean } = {},
) {
  const cookie = await loginCookie(app);
  const seedAddresses = options.seedAddresses ?? true;
  const resolvedOrderFile = sourceOrderFile ?? (mockDataFile.includes("mixed") ? mixedOrderFile : orderFile);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/batches",
    payload: { filePath: resolvedOrderFile, mode: "mock" },
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
  if (seedAddresses) {
    await seedStoreAddresses(app, cookie, lines);
  }
  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/batches/${batch.id}/actions/submit-review`,
    payload: { confirmUnverifiedStock: false },
    headers: { cookie },
  });
  expect(submitted.statusCode).toBe(200);
  return { batch: submitted.json().batch, lines, firstLine: lines[0], cookie };
}

async function seedStoreAddresses(app: ReturnType<typeof buildApiServer>, cookie: string, lines: Array<{ storeNo: string; storeName: string }>) {
  const seen = new Set<string>();
  for (const line of lines) {
    const key = `${line.storeNo}\u0000${line.storeName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await app.inject({
      method: "POST",
      url: "/api/v1/store-addresses",
      payload: {
        storeNo: line.storeNo,
        storeName: line.storeName,
        receiver: `测试收货人-${line.storeNo}`,
        phone: "18800000000",
        address: `测试地址-${line.storeName}`,
        note: "测试地址",
      },
      headers: { cookie },
    });
  }
}

async function loginCookie(app: ReturnType<typeof buildApiServer>, username = "admin", password = "yjmy") {
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  return String(login.headers["set-cookie"]);
}

function fixedWarehouseStockClient(availableSendStock = 100): StockLookupClient {
  return {
    async queryStock(specNo) {
      return {
        status: 0,
        data: {
          total_count: 1,
          detail_list: [{
            spec_no: specNo,
            warehouse_no: "001",
            warehouse_name: "主仓",
            available_send_stock: availableSendStock,
          }],
        },
      };
    },
  };
}

function failingRealtimeStockClient(): StockLookupClient {
  return {
    async queryStock() {
      throw new Error("business workflows must not call the realtime WDT stock API");
    },
    async queryStocks() {
      throw new Error("business workflows must not call the realtime WDT stock API");
    },
  };
}

type StockSnapshotRowSeed = {
  specNo: string;
  warehouseNo: string;
  warehouseName: string;
  availableSendStock: number;
};

async function seedSuccessfulStockSnapshot(
  database: ReturnType<typeof createDatabaseContext>,
  options: {
    runId?: string;
    finishedAt?: string;
    verifiedSpecNos: string[];
    rows?: StockSnapshotRowSeed[];
    warehouseTypes?: Array<"main" | "near_expiry" | "defect" | "other">;
  },
) {
  const runId = options.runId ?? `wdt-sync-${randomUUID()}`;
  const finishedAt = options.finishedAt ?? "2026-07-03T00:01:00.000Z";
  await database.db.insert(wdtSyncRuns).values({
    id: runId,
    trigger: "manual",
    status: "success",
    stage: "complete",
    goodsSyncRunId: "wdt-goods-sync-success",
    totalSpecCount: options.verifiedSpecNos.length,
    processedSpecCount: options.verifiedSpecNos.length,
    totalBatchCount: options.verifiedSpecNos.length ? 1 : 0,
    completedBatchCount: options.verifiedSpecNos.length ? 1 : 0,
    stockRowCount: options.rows?.length ?? 0,
    startedAt: "2026-07-03T00:00:00.000Z",
    finishedAt,
    lastProgressAt: finishedAt,
    errorCode: "",
    errorMessage: "",
    errorDetail: "",
  });
  if (options.verifiedSpecNos.length) {
    await database.db.insert(wdtStockSnapshotSpecs).values(options.verifiedSpecNos.map((specNo) => ({
      syncRunId: runId,
      specNo,
      syncedAt: finishedAt,
    })));
  }
  if (options.rows?.length) {
    await database.db.insert(wdtStockSnapshotRows).values(options.rows.map((row, index) => ({
      id: `${runId}-row-${index + 1}`,
      syncRunId: runId,
      ...row,
      rawJson: JSON.stringify(row),
      syncedAt: finishedAt,
    })));
  }
  const warehouseTypes = options.warehouseTypes ?? ["main", "near_expiry", "defect", "other"];
  if (warehouseTypes.length) {
    await database.db.insert(wdtStockSnapshotWarehouseCoverage).values(warehouseTypes.map((warehouseType) => ({
      syncRunId: runId,
      warehouseType,
      apiWarehouseNo: "",
      syncedAt: finishedAt,
    })));
  }
  return { runId, finishedAt };
}

async function seedSingleWarehouseSnapshot(
  database: ReturnType<typeof createDatabaseContext>,
  specNo: string,
  availableSendStock = 100,
  warehouseNo = "001",
  warehouseName = "主仓",
  finishedAt?: string,
) {
  return seedSuccessfulStockSnapshot(database, {
    finishedAt,
    verifiedSpecNos: [specNo],
    rows: [{ specNo, warehouseNo, warehouseName, availableSendStock }],
  });
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

async function seedSingleComponentSuite(database: ReturnType<typeof createDatabaseContext>) {
  const now = "2026-07-09T00:00:00.000Z";
  await database.db.insert(wdtSuites).values({
    id: "wdt-suite-2150317560013",
    suiteNo: "2150317560013",
    suiteName: "lelabo护发素(33檀香系列)50ml",
    barcode: "2150317560013",
    deleted: 0,
    modified: now,
    rawJson: "{}",
    syncedAt: now,
  });
  await database.db.insert(wdtSuiteComponents).values({
    id: "wdt-suite-component-2150317560013-1",
    suiteNo: "2150317560013",
    sortOrder: 1,
    specNo: "021700004",
    goodsNo: "021700004",
    goodsName: "【中小样】le labo护发素(33檀香系列)",
    specName: "50ml",
    specCode: "",
    barcode: "021700004",
    quantity: 1,
    ratio: 1,
    deleted: 0,
    rawJson: "{}",
    syncedAt: now,
  });
}

async function seedMultiComponentSuiteAndSharedGoods(database: ReturnType<typeof createDatabaseContext>) {
  const now = "2026-07-16T00:00:00.000Z";
  await database.db.insert(wdtGoodsSpecs).values({
    id: "wdt-goods-spec-shared-a",
    goodsNo: "GOODS-SHARED-A",
    goodsName: "共享组件普通商品",
    specNo: "SHARED-A",
    specName: "单件",
    specCode: "",
    barcode: "GOODS-SHARED-A-BARCODE",
    barcodesJson: JSON.stringify(["GOODS-SHARED-A-BARCODE"]),
    deleted: 0,
    modified: now,
    rawJson: "{}",
    syncedAt: now,
  });
  await database.db.insert(wdtSuites).values({
    id: "wdt-suite-multi",
    suiteNo: "SUITE-MULTI",
    suiteName: "多组件组合装",
    barcode: "SUITE-MULTI-BARCODE",
    deleted: 0,
    modified: now,
    rawJson: "{}",
    syncedAt: now,
  });
  await database.db.insert(wdtSuiteComponents).values([
    {
      id: "wdt-suite-component-multi-a",
      suiteNo: "SUITE-MULTI",
      sortOrder: 1,
      specNo: "SHARED-A",
      goodsNo: "GOODS-SHARED-A",
      goodsName: "共享组件普通商品",
      specName: "单件",
      specCode: "",
      barcode: "GOODS-SHARED-A-BARCODE",
      quantity: 1,
      ratio: 1,
      deleted: 0,
      rawJson: "{}",
      syncedAt: now,
    },
    {
      id: "wdt-suite-component-multi-b",
      suiteNo: "SUITE-MULTI",
      sortOrder: 2,
      specNo: "SUITE-B",
      goodsNo: "GOODS-SUITE-B",
      goodsName: "组合装独占组件",
      specName: "单件",
      specCode: "",
      barcode: "SUITE-B-BARCODE",
      quantity: 1,
      ratio: 1,
      deleted: 0,
      rawJson: "{}",
      syncedAt: now,
    },
  ]);
}

async function seedVipAllocationGoodsCache(database: ReturnType<typeof createDatabaseContext>) {
  const now = "2026-07-03T00:00:00.000Z";
  await database.db.insert(wdtGoodsSyncRuns).values({
    id: "wdt-goods-sync-vip-allocation",
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
    id: "wdt-goods-spec-vip-allocation",
    goodsNo: "VIP-GOODS",
    goodsName: "VIP分货测试商品",
    specNo: "VIP-SPEC",
    specName: "单支",
    specCode: "VIP-CODE",
    barcode: "VIP-BARCODE",
    barcodesJson: JSON.stringify(["VIP-BARCODE"]),
    deleted: 0,
    modified: now,
    rawJson: "{}",
    syncedAt: now,
  });
}

async function seedVipStoreAddress(database: ReturnType<typeof createDatabaseContext>, storeNo: string, storeName: string) {
  const now = "2026-07-03T00:00:00.000Z";
  await database.db.insert(storeAddresses).values({
    id: `store-address-${storeNo}`,
    storeNo,
    storeName,
    normalizedStoreName: storeName,
    receiver: `收货人-${storeNo}`,
    phone: "18800000000",
    address: `测试地址-${storeName}`,
    isVip: 1,
    note: "VIP分货测试",
    sourceSheet: "手工维护",
    sourceRow: 0,
    importedAt: "",
    rawJson: "{}",
    createdAt: now,
    updatedAt: now,
  });
}

function createVipAllocationOrderFile(name: string) {
  const outputPath = resolve(projectRoot, "outputs/fixtures", `vip-allocation-${name}.xlsx`);
  mkdirSync(resolve(projectRoot, "outputs/fixtures"), { recursive: true });
  const rows = [
    [
      "订货通知单号",
      "订货审批单号",
      "门店",
      "门店名称",
      "订货日期",
      "截止日期",
      "商品编码",
      "商品名称",
      "商品条码",
      "规格",
      "运输规格",
      "订货箱数",
      "订货数",
    ],
    ["VIP-ORDER-1", "VIP-APPROVAL-1", "VIP-1", "VIP一店", "2026-07-03", "2026-07-10", "VIP-GOODS", "VIP分货测试商品", "VIP-BARCODE", "单支", "1", "4", "4"],
    ["VIP-ORDER-2", "VIP-APPROVAL-2", "VIP-2", "VIP二店", "2026-07-03", "2026-07-10", "VIP-GOODS", "VIP分货测试商品", "VIP-BARCODE", "单支", "1", "4", "4"],
    ["REG-ORDER-1", "REG-APPROVAL-1", "REG-1", "普通一店", "2026-07-03", "2026-07-10", "VIP-GOODS", "VIP分货测试商品", "VIP-BARCODE", "单支", "1", "4", "4"],
    ["REG-ORDER-2", "REG-APPROVAL-2", "REG-2", "普通二店", "2026-07-03", "2026-07-10", "VIP-GOODS", "VIP分货测试商品", "VIP-BARCODE", "单支", "1", "4", "4"],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "订货单");
  XLSX.writeFile(workbook, outputPath);
  return outputPath;
}

function createSharedComponentPriorityOrderFile() {
  const outputPath = resolve(projectRoot, "outputs/fixtures/shared-component-priority.xlsx");
  mkdirSync(resolve(projectRoot, "outputs/fixtures"), { recursive: true });
  const header = [
    "订货通知单号",
    "订货审批单号",
    "门店",
    "门店名称",
    "订货日期",
    "截止日期",
    "商品编码",
    "商品名称",
    "商品条码",
    "规格",
    "运输规格",
    "订货箱数",
    "订货数",
  ];
  const rows = [
    header,
    ["ORDER-VIP-SUITE", "APPROVAL-1", "VIP-SUITE", "VIP组合装门店", "2026-07-16", "2026-07-20", "SUITE-MULTI", "多组件组合装", "SUITE-MULTI-BARCODE", "套", "1", "2", "2"],
    ["ORDER-VIP-GOODS", "APPROVAL-2", "VIP-GOODS", "VIP普通商品门店", "2026-07-16", "2026-07-20", "GOODS-SHARED-A", "共享组件普通商品", "GOODS-SHARED-A-BARCODE", "件", "1", "2", "2"],
    ["ORDER-REG-SUITE", "APPROVAL-3", "REG-SUITE", "普通组合装门店", "2026-07-16", "2026-07-20", "SUITE-MULTI", "多组件组合装", "SUITE-MULTI-BARCODE", "套", "1", "2", "2"],
    ["ORDER-REG-GOODS", "APPROVAL-4", "REG-GOODS", "普通商品门店", "2026-07-16", "2026-07-20", "GOODS-SHARED-A", "共享组件普通商品", "GOODS-SHARED-A-BARCODE", "件", "1", "2", "2"],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "订货单");
  XLSX.writeFile(workbook, outputPath);
  return outputPath;
}

function reviewLinesByStore(lines: ReviewLineDto[]) {
  return new Map(lines.map((line) => [line.storeNo, line]));
}

async function seedExternalProductGoodsCache(database: ReturnType<typeof createDatabaseContext>) {
  const now = "2026-07-03T00:00:00.000Z";
  await database.db.insert(wdtGoodsSpecs).values([
    {
      id: "wdt-goods-spec-sample-1",
      goodsNo: "GOODS-SAMPLE-1",
      goodsName: "小样命中 WDT 商品",
      specNo: "SPEC-SAMPLE-1",
      specName: "1ml",
      specCode: "CODE-SAMPLE-1",
      barcode: "690000000001",
      barcodesJson: JSON.stringify(["690000000001"]),
      deleted: 0,
      modified: now,
      rawJson: "{}",
      syncedAt: now,
    },
    {
      id: "wdt-goods-spec-bundle-primary",
      goodsNo: "GOODS-BUNDLE-PRIMARY",
      goodsName: "套盒主商品 WDT 商品",
      specNo: "SPEC-BUNDLE-PRIMARY",
      specName: "正装",
      specCode: "CODE-BUNDLE-PRIMARY",
      barcode: "690000000002",
      barcodesJson: JSON.stringify(["690000000002"]),
      deleted: 0,
      modified: now,
      rawJson: "{}",
      syncedAt: now,
    },
    {
      id: "wdt-goods-spec-bundle-replacement",
      goodsNo: "GOODS-BUNDLE-REPLACEMENT",
      goodsName: "套盒替换商品 WDT 商品",
      specNo: "SPEC-BUNDLE-REPLACEMENT",
      specName: "替换装",
      specCode: "CODE-BUNDLE-REPLACEMENT",
      barcode: "690000000003",
      barcodesJson: JSON.stringify(["690000000003"]),
      deleted: 0,
      modified: now,
      rawJson: "{}",
      syncedAt: now,
    },
  ]);
}

function externalProductsWorkbookBase64() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["商品编码", "商品条码", "商品全称", "标签价格", "系统供货价"],
      ["SAMPLE-001", "690000000001", "小样命中", 19.9, 8.8],
      ["SAMPLE-002", "690000000099", "小样未命中", 29.9, 9.9],
    ]),
    "小样价格",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["品名", "规格", "套盒条码", "组件编码1", "组件备注1", "合同价", "组件编码2", "组件备注2", "组件名称2", "组件价格2", "组件编码3", "组件备注3"],
      ["命中套盒", "", "BUNDLE001", "690000000002", "1个", "99", "690000000003", "替换2个", "替换品", "10", "690000000004", "赠品1个"],
    ]),
    "套盒",
  );
  return (XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer).toString("base64");
}

function confirmedOrderWorkbookBase64(
  options: {
    goodsCode?: string;
    barcode?: string;
    goodsName?: string;
    storeNo?: string;
    storeName?: string;
    rows?: Array<{
      approvalNo?: string;
      noticeNo: string;
      goodsCode: string;
      barcode: string;
      goodsName: string;
      storeNo?: string;
      storeName?: string;
      spec?: string;
      orderQty?: string;
      shipQty: string;
      mainWarehouseQty?: string;
      nearExpiryWarehouseQty?: string;
      contractPrice?: string;
    }>;
    extraFirstSheet?: boolean;
  } = {},
) {
  const goodsCode = options.goodsCode ?? "3282770392869";
  const barcode = options.barcode ?? "2153722460015";
  const goodsName = options.goodsName ?? "雅漾专研保湿修护面膜";
  const storeNo = options.storeNo ?? "S001";
  const storeName = options.storeName ?? "Ole确定单门店";
  const rows = options.rows ?? [
    { approvalNo: "APPROVAL-1", noticeNo: "NOTICE-1", goodsCode, barcode, goodsName, spec: "25ml*5", orderQty: "2", shipQty: "2", contractPrice: "12.5" },
    { approvalNo: "APPROVAL-2", noticeNo: "NOTICE-2", goodsCode, barcode, goodsName, spec: "25ml*5", orderQty: "3", shipQty: "3", contractPrice: "12.5" },
  ];
  const workbook = XLSX.utils.book_new();
  if (options.extraFirstSheet) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["说明"], ["这个 sheet 不应被导入"]]), "原始单");
  }
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["审批单号", "通知单号", "收货地编码", "收货地名称", "业务员", "截止日期", "商品编码", "商品条码", "商品名称", "规格", "订货数量", "实际发货数量", "合同进价", "主仓", "临期仓"],
      ...rows.map((row, index) => [
        row.approvalNo ?? `APPROVAL-${index + 1}`,
        row.noticeNo,
        row.storeNo ?? storeNo,
        row.storeName ?? storeName,
        "原业务员",
        "2026-07-12",
        row.goodsCode,
        row.barcode,
        row.goodsName,
        row.spec ?? "",
        row.orderQty ?? row.shipQty,
        row.shipQty,
        row.contractPrice ?? "12.5",
        row.mainWarehouseQty ?? row.shipQty,
        row.nearExpiryWarehouseQty ?? "",
      ]),
    ]),
    "确定单",
  );
  return (XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer).toString("base64");
}

function fakeStockClient(): StockLookupClient {
  return {
    async queryStock() {
      return { status: 0, data: { total_count: 0, detail_list: [] } };
    },
  };
}
