import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import {
  CreateExportRequestSchema,
  CreateBatchRequestSchema,
  ConfirmProductMappingRequestSchema,
  CreateWdtGoodsSyncRunRequestSchema,
  LoginRequestSchema,
  RebuildConfirmedOrderRequestSchema,
  SubmitReviewRequestSchema,
  UpdateProductMappingStatusRequestSchema,
  ReviewDecisionDtoSchema,
  UpdateReviewLinePriorityRequestSchema,
  ImportStoreAddressesRequestSchema,
  ImportConfirmedOrderRequestSchema,
  ImportExternalProductsRequestSchema,
  RunMockReviewRequestSchema,
  RunRealReviewRequestSchema,
  UpdateBatchStoreFieldsRequestSchema,
  UpsertStoreAddressRequestSchema,
  UpdateWarehouseUsageSettingsRequestSchema,
  UpdateWdtSyncSettingsRequestSchema,
  UploadOrderFileRequestSchema,
  type AuthUserDto,
  type BatchSummary,
  type ExportDto,
  type ExternalProductDto,
  type ImportExternalProductsPreviewResponse,
  type ImportExternalProductsResponse,
  type ImportConfirmedOrderResponse,
  type MakeOrderReadinessDto,
  type ImportStoreAddressesPreviewResponse,
  type ImportStoreAddressesResponse,
  type ProductMatchCandidateDto,
  type ProductMappingDto,
  type StoreAddressDto,
  type UpdateBatchStoreFieldsResponse,
  type UserRole,
  type WarehouseUsageSettingsDto,
  type WdtSyncSettingsDto,
  type WdtGoodsSpecSearchResultDto,
  type WdtGoodsSyncRunDto,
  type WdtSyncRunDto,
  type StartWdtSyncResponseDto,
} from "@jy-trade/shared";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { createSqliteStore, StoreValidationError, type StoreOptions } from "./store.js";
import { ensureRuntimeDir, resolveProjectRoot, resolveRuntimeDir } from "./runtimePaths.js";

interface BuildApiServerOptions extends StoreOptions {
  logger?: boolean;
}

const excelUploadBodyLimitBytes = 50 * 1024 * 1024;

export function buildApiServer(options: BuildApiServerOptions = {}) {
  const app = Fastify({ bodyLimit: excelUploadBodyLimitBytes, logger: options.logger ?? true });
  const store = createSqliteStore(options);
  const projectRoot = options.projectRoot ?? resolveProjectRoot();

  void app.register(cors, { origin: true });
  app.addHook("onClose", async () => store.close());
  app.addHook("onReady", async () => store.startAutoSyncScheduler());
  app.addHook("onRequest", async (request) => {
    const sessionId = readSessionId(request.headers.cookie);
    if (sessionId) {
      const me = await store.getMe(sessionId);
      if (me.user) {
        (request as { currentUser?: AuthUserDto }).currentUser = me.user;
      }
    }
    if (isProtectedPath(request.url) && !getCurrentUser(request)) {
      throw new UnauthorizedError();
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnauthorizedError) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
    if (error instanceof ForbiddenError) {
      return reply.code(403).send({ message: "当前账号没有执行此操作的权限" });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: "Invalid request", issues: error.issues });
    }
    if (error instanceof StoreValidationError) {
      return reply.code(400).send({ message: error.message });
    }
    return reply.send(error);
  });

  app.get("/api/v1/health", async () => ({
    ok: true,
    service: "jy-trade-api",
  }));

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body ?? {});
    const login = await store.login(body);
    if (!login) return reply.code(401).send({ message: "Invalid username or password" });
    const session = await store.createSession(login.user.id, 7, login.user);
    if (!session) return reply.code(500).send({ message: "Failed to create session" });
    reply.header("Set-Cookie", buildSessionCookie(session.sessionId, session.expiresAt));
    return reply.send(login);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const sessionId = readSessionId(request.headers.cookie);
    await store.logout(sessionId, getCurrentUser(request));
    reply.header("Set-Cookie", clearSessionCookie());
    return reply.send({ ok: true });
  });

  app.get("/api/v1/me", async (request) => store.getMe(readSessionId(request.headers.cookie)));

  app.post("/api/v1/batches", async (request, reply) => {
    requireRole(request, ["admin", "operator"]);
    const body = CreateBatchRequestSchema.parse(request.body ?? {});
    const batch = await store.createBatch(body, getCurrentUser(request));
    return reply.code(201).send(batch);
  });

  app.post("/api/v1/order-files", async (request, reply) => {
    requireRole(request, ["admin", "operator"]);
    const body = UploadOrderFileRequestSchema.parse(request.body ?? {});
    const originalName = body.fileName.split(/[\\/]/).at(-1) ?? body.fileName;
    const extension = extname(originalName).toLowerCase();
    if (![".xls", ".xlsx"].includes(extension)) {
      return reply.code(400).send({ message: "只支持上传 Excel 订货单文件" });
    }

    const uploadDir = ensureRuntimeDir(resolveRuntimeDir(process.env.JY_TRADE_UPLOAD_DIR, join(projectRoot, "inputs", "uploads"), projectRoot));
    const storedName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}${extension}`;
    const filePath = join(uploadDir, storedName);
    await writeFile(filePath, Buffer.from(body.contentBase64, "base64"));
    return reply.code(201).send({
      filePath,
      fileName: originalName,
    });
  });

  app.get("/api/v1/batches", async (): Promise<BatchSummary[]> => store.listBatches());

  app.get("/api/v1/batches/:batchId", async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const batch = await store.getBatch(batchId);
    if (!batch) return reply.code(404).send({ message: "Batch not found" });
    return batch;
  });

  app.delete("/api/v1/batches/:batchId", async (request, reply) => {
    requireRole(request, ["admin"]);
    const { batchId } = request.params as { batchId: string };
    const result = await store.deleteBatch(batchId, getCurrentUser(request));
    if (!result) return reply.code(404).send({ message: "Batch not found" });
    return result;
  });

  app.post("/api/v1/batches/:batchId/actions/run-mock-review", async (request, reply) => {
    requireRole(request, ["admin", "operator"]);
    const { batchId } = request.params as { batchId: string };
    const body = RunMockReviewRequestSchema.parse(request.body ?? {});
    const result = await store.runMockReview(batchId, body.mockDataFile, getCurrentUser(request));
    if (!result) return reply.code(404).send({ message: "Batch not found" });
    return result;
  });

  app.post("/api/v1/batches/:batchId/actions/run-real-review", async (request, reply) => {
    requireRole(request, ["admin", "operator"]);
    const { batchId } = request.params as { batchId: string };
    const body = RunRealReviewRequestSchema.parse(request.body ?? {});
    const result = await store.runRealReview(batchId, body, getCurrentUser(request));
    if (!result) return reply.code(404).send({ message: "Batch not found" });
    return result;
  });

  app.post("/api/v1/confirmed-orders/import", async (request, reply): Promise<ImportConfirmedOrderResponse> => {
    requireRole(request, ["admin", "operator"]);
    const body = ImportConfirmedOrderRequestSchema.parse(request.body ?? {});
    const result = await store.importConfirmedOrder(body, getCurrentUser(request));
    return reply.code(201).send(result);
  });

  app.post("/api/v1/batches/:batchId/actions/rebuild-confirmed-order", async (request, reply): Promise<ImportConfirmedOrderResponse | unknown> => {
    requireRole(request, ["admin", "operator"]);
    const { batchId } = request.params as { batchId: string };
    const body = RebuildConfirmedOrderRequestSchema.parse(request.body ?? {});
    const result = await store.rebuildConfirmedOrder(batchId, body, getCurrentUser(request));
    if (!result) return reply.code(404).send({ message: "Batch not found" });
    return result;
  });

  app.post("/api/v1/batches/:batchId/actions/bulk-approve", async (request, reply) => {
    requireRole(request, ["admin", "reviewer"]);
    const { batchId } = request.params as { batchId: string };
    const result = await store.bulkApprove(batchId, getCurrentUser(request));
    if (!result) return reply.code(404).send({ message: "Batch not found" });
    return result;
  });

  app.post("/api/v1/batches/:batchId/actions/submit-review", async (request, reply) => {
    requireRole(request, ["admin", "reviewer"]);
    const { batchId } = request.params as { batchId: string };
    const body = SubmitReviewRequestSchema.parse(request.body ?? {});
    const result = await store.submitReview(batchId, body, getCurrentUser(request));
    if (!result) return reply.code(404).send({ message: "Batch not found" });
    if (result.requiresConfirmation) return reply.code(409).send(result);
    return result;
  });

  app.get("/api/v1/batches/:batchId/review-lines", async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const lines = await store.getReviewLines(batchId);
    if (!lines) return reply.code(404).send({ message: "Batch not found" });
    return lines;
  });

  app.get("/api/v1/batches/:batchId/make-order-readiness", async (request, reply): Promise<MakeOrderReadinessDto | unknown> => {
    const { batchId } = request.params as { batchId: string };
    const readiness = await store.getMakeOrderReadiness(batchId);
    if (!readiness) return reply.code(404).send({ message: "Batch not found" });
    return readiness;
  });

  app.patch("/api/v1/batches/:batchId/store-fields", async (request, reply): Promise<UpdateBatchStoreFieldsResponse | unknown> => {
    requireRole(request, ["admin", "operator"]);
    const { batchId } = request.params as { batchId: string };
    const body = UpdateBatchStoreFieldsRequestSchema.parse(request.body ?? {});
    const result = await store.updateBatchStoreFields(batchId, body, getCurrentUser(request));
    if (!result) return reply.code(404).send({ message: "Batch not found" });
    return result;
  });

  app.get("/api/v1/settings/warehouse-usage", async (): Promise<WarehouseUsageSettingsDto> => store.getWarehouseUsageSettings());

  app.patch("/api/v1/settings/warehouse-usage", async (request): Promise<WarehouseUsageSettingsDto> => {
    requireRole(request, ["admin"]);
    const body = UpdateWarehouseUsageSettingsRequestSchema.parse(request.body ?? {});
    return store.updateWarehouseUsageSettings(body, getCurrentUser(request));
  });

  app.get("/api/v1/settings/wdt-sync", async (): Promise<WdtSyncSettingsDto> => store.getWdtSyncSettings());

  app.patch("/api/v1/settings/wdt-sync", async (request): Promise<WdtSyncSettingsDto> => {
    requireRole(request, ["admin"]);
    const body = UpdateWdtSyncSettingsRequestSchema.parse(request.body ?? {});
    return store.updateWdtSyncSettings(body, getCurrentUser(request));
  });

  app.patch("/api/v1/batches/:batchId/review-lines/:lineId/decision", async (request, reply) => {
    requireRole(request, ["admin", "reviewer"]);
    const { batchId, lineId } = request.params as { batchId: string; lineId: string };
    const body = ReviewDecisionDtoSchema.parse(request.body ?? {});
    const line = await store.updateReviewDecision(batchId, lineId, body, getCurrentUser(request));
    if (!line) return reply.code(404).send({ message: "Review line not found" });
    return line;
  });

  app.patch("/api/v1/batches/:batchId/review-lines/:lineId/priority", async (request, reply) => {
    requireRole(request, ["admin", "reviewer"]);
    const { batchId, lineId } = request.params as { batchId: string; lineId: string };
    const body = UpdateReviewLinePriorityRequestSchema.parse(request.body ?? {});
    const line = await store.updateReviewLinePriority(batchId, lineId, body, getCurrentUser(request));
    if (!line) return reply.code(404).send({ message: "Review line not found" });
    return line;
  });

  app.get("/api/v1/batches/:batchId/exports", async (request): Promise<ExportDto[]> => {
    const { batchId } = request.params as { batchId: string };
    return store.listExports(batchId);
  });

  app.post("/api/v1/batches/:batchId/exports", async (request, reply): Promise<ExportDto | unknown> => {
    requireRole(request, ["admin", "operator"]);
    const { batchId } = request.params as { batchId: string };
    const body = CreateExportRequestSchema.parse(request.body ?? {});
    const exportJob = await store.createExport(batchId, body, getCurrentUser(request));
    if (!exportJob) return reply.code(404).send({ message: "Batch not found" });
    return reply.code(201).send(exportJob);
  });

  app.get("/api/v1/exports/:exportId/download", async (request, reply) => {
    const { exportId } = request.params as { exportId: string };
    const exportFile = await store.getExportFile(exportId);
    if (!exportFile) return reply.code(404).send({ message: "Export not found" });
    if (exportFile.exportJob.status !== "ready") {
      return reply.code(409).send({ message: "Export is not ready" });
    }
    const bytes = await readFile(exportFile.filePath);
    reply
      .header("Content-Type", exportFile.fileName.endsWith(".xls") ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", contentDisposition(exportFile.fileName));
    return reply.send(bytes);
  });

  app.post("/api/v1/wdt/goods-sync-runs", async (request, reply): Promise<WdtGoodsSyncRunDto | unknown> => {
    requireRole(request, ["admin", "operator"]);
    const body = CreateWdtGoodsSyncRunRequestSchema.parse(request.body ?? {});
    const run = await store.runWdtGoodsSync(body, getCurrentUser(request));
    return reply.code(201).send(run);
  });

  app.post("/api/v1/wdt/sync-runs", async (request, reply): Promise<StartWdtSyncResponseDto | unknown> => {
    requireRole(request, ["admin", "operator"]);
    const result = await store.startWdtSync("manual", getCurrentUser(request));
    return reply.code(202).send(result);
  });

  app.get("/api/v1/wdt/sync-runs", async (): Promise<WdtSyncRunDto[]> => store.listWdtSyncRuns());

  app.get("/api/v1/wdt/sync-runs/latest", async (request, reply): Promise<WdtSyncRunDto | unknown> => {
    const run = await store.getLatestWdtSyncRun();
    if (!run) return reply.code(404).send({ message: "WDT sync run not found" });
    return run;
  });

  app.get("/api/v1/wdt/goods-sync-runs", async (): Promise<WdtGoodsSyncRunDto[]> => store.listWdtGoodsSyncRuns());

  app.get("/api/v1/wdt/goods-sync-runs/latest", async (request, reply): Promise<WdtGoodsSyncRunDto | unknown> => {
    const run = await store.getLatestWdtGoodsSyncRun();
    if (!run) return reply.code(404).send({ message: "WDT goods sync run not found" });
    return run;
  });

  app.get("/api/v1/wdt/goods-specs/search", async (request): Promise<WdtGoodsSpecSearchResultDto[]> => {
    const { query } = request.query as { query?: string };
    return store.searchWdtGoodsSpecs(query ?? "");
  });

  app.post("/api/v1/product-mappings", async (request, reply): Promise<ProductMappingDto | unknown> => {
    requireRole(request, ["admin", "operator"]);
    const body = ConfirmProductMappingRequestSchema.parse(request.body ?? {});
    const mapping = await store.confirmProductMapping(body, getCurrentUser(request));
    return reply.code(201).send(mapping);
  });

  app.get("/api/v1/product-mappings", async (request): Promise<ProductMappingDto[]> => {
    const { query } = request.query as { query?: string };
    return store.listProductMappings(query ?? "");
  });

  app.get("/api/v1/product-match-candidates", async (request): Promise<ProductMatchCandidateDto[]> => {
    const { query } = request.query as { query?: string };
    return store.listProductMatchCandidates(query ?? "");
  });

  app.get("/api/v1/external-products", async (request): Promise<ExternalProductDto[]> => {
    const { query } = request.query as { query?: string };
    return store.listExternalProducts(query ?? "");
  });

  app.post("/api/v1/external-products/import-preview", async (request, reply): Promise<ImportExternalProductsPreviewResponse> => {
    requireRole(request, ["admin", "operator"]);
    const body = ImportExternalProductsRequestSchema.parse(request.body ?? {});
    const result = await store.previewExternalProductImport(body);
    return reply.code(200).send(result);
  });

  app.post("/api/v1/external-products/import", async (request, reply): Promise<ImportExternalProductsResponse> => {
    requireRole(request, ["admin", "operator"]);
    const body = ImportExternalProductsRequestSchema.parse(request.body ?? {});
    const result = await store.importExternalProducts(body, getCurrentUser(request));
    return reply.code(201).send(result);
  });

  app.get("/api/v1/store-addresses", async (request): Promise<StoreAddressDto[]> => {
    const { query } = request.query as { query?: string };
    return store.listStoreAddresses(query ?? "");
  });

  app.post("/api/v1/store-addresses", async (request, reply): Promise<StoreAddressDto> => {
    requireRole(request, ["admin", "operator"]);
    const body = UpsertStoreAddressRequestSchema.parse(request.body ?? {});
    const address = await store.upsertStoreAddress(body, getCurrentUser(request));
    return reply.code(201).send(address);
  });

  app.post("/api/v1/store-addresses/import-preview", async (request, reply): Promise<ImportStoreAddressesPreviewResponse> => {
    requireRole(request, ["admin", "operator"]);
    const body = ImportStoreAddressesRequestSchema.parse(request.body ?? {});
    const result = await store.previewStoreAddressImport(body);
    return reply.code(200).send(result);
  });

  app.post("/api/v1/store-addresses/import", async (request, reply): Promise<ImportStoreAddressesResponse> => {
    requireRole(request, ["admin", "operator"]);
    const body = ImportStoreAddressesRequestSchema.parse(request.body ?? {});
    const result = await store.importStoreAddresses(body, getCurrentUser(request));
    return reply.code(201).send(result);
  });

  app.patch("/api/v1/product-mappings/:mappingId/status", async (request, reply): Promise<ProductMappingDto | unknown> => {
    requireRole(request, ["admin", "operator"]);
    const { mappingId } = request.params as { mappingId: string };
    const body = UpdateProductMappingStatusRequestSchema.parse(request.body ?? {});
    const mapping = await store.updateProductMappingStatus(mappingId, body, getCurrentUser(request));
    if (!mapping) return reply.code(404).send({ message: "Product mapping not found" });
    return mapping;
  });

  app.delete("/api/v1/product-mappings/:mappingId", async (request, reply) => {
    requireRole(request, ["admin", "operator"]);
    const { mappingId } = request.params as { mappingId: string };
    const result = await store.deleteProductMapping(mappingId, getCurrentUser(request));
    if (!result) return reply.code(404).send({ message: "Product mapping not found" });
    return result;
  });

  return app;
}

function getCurrentUser(request: unknown) {
  return (request as { currentUser?: AuthUserDto }).currentUser;
}

function requireRole(request: unknown, allowedRoles: UserRole[]) {
  const user = getCurrentUser(request);
  if (!user || !allowedRoles.includes(user.role)) {
    throw new ForbiddenError();
  }
}

function readSessionId(cookieHeader: string | undefined) {
  const match = cookieHeader?.match(/(?:^|;\s*)jy_trade_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function buildSessionCookie(sessionId: string, expiresAt: string) {
  return `jy_trade_session=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
}

function clearSessionCookie() {
  return "jy_trade_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
}

function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function isProtectedPath(url: string) {
  return url.startsWith("/api/v1/") && !["/api/v1/health", "/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/me"].some((path) => url.startsWith(path));
}

class UnauthorizedError extends Error {}

class ForbiddenError extends Error {}
