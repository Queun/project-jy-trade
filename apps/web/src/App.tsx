import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, ChevronDown, ChevronUp, ClipboardList, Download, FileSpreadsheet, HelpCircle, LogOut, MapPin, PackageCheck, PackageSearch, RefreshCcw, Save, Send, Settings, Trash2, Upload, Warehouse, X } from "lucide-react";
import type {
  AuthUserDto,
  ApplyProductMappingResponse,
  BatchSummary,
  ExportDto,
  ImportConfirmedOrderResponse,
  MakeOrderReadinessDto,
  ProductMappingDto,
  ReviewDecision,
  ReviewLineDto,
  SubmitReviewResultDto,
  SubmitReviewWarningDto,
  UpdateBatchStoreFieldsResponse,
  WarehouseUsageSettingsDto,
  WdtAutoSyncIntervalHours,
  WdtSyncSettingsDto,
  WdtGoodsSyncRunDto,
  WdtSyncRunDto,
  StartWdtSyncResponseDto,
} from "@jy-trade/shared";
import { isConfirmedProductMappingMatch } from "@jy-trade/shared";

import { ProductMappingDialog, type ProductMappingFocusProduct } from "./components/ProductMappingPanel.js";
import { ExternalProductPanel } from "./components/ExternalProductPanel.js";
import { ReviewTable, type ReviewDraft } from "./components/ReviewTable.js";
import { StoreAddressPanel } from "./components/StoreAddressPanel.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";

const defaultOrderFile = "outputs\\fixtures\\sample-order.xlsx";
const defaultMockFile = "examples/mock_flow_data.json";
const helpDismissedStorageKey = "jy-trade-help-dismissed-v1";

type WorkTab = "import" | "review" | "export" | "addresses" | "external-products";
type ConfirmedOrderRebuildStrategy = "preserve" | "replace";

interface ConfirmedOrderRebuildPrompt {
  batch: BatchSummary;
}

type FilterKey =
  | "all"
  | "ready"
  | "partial"
  | "blocked"
  | "unverified"
  | "unmatched"
  | "validation_error"
  | "pending"
  | "ship"
  | "do_not_ship"
  | "priority"
  | "manual_mapping"
  | "over_suggested";

const orderFilters: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "ready", label: "可发货" },
  { key: "partial", label: "部分满足" },
  { key: "blocked", label: "缺货" },
  { key: "unmatched", label: "商品异常" },
  { key: "pending", label: "待审核" },
  { key: "ship", label: "已发货" },
  { key: "do_not_ship", label: "不发货" },
  { key: "priority", label: "优先处理" },
  { key: "manual_mapping", label: "长期映射" },
  { key: "over_suggested", label: "超建议数" },
];

const confirmedOrderFilters: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "unmatched", label: "待映射商品" },
  { key: "validation_error", label: "校验异常" },
  { key: "ready", label: "全部发货" },
  { key: "partial", label: "部分发货" },
  { key: "blocked", label: "货品不足" },
  { key: "unverified", label: "库存未验证" },
  { key: "pending", label: "待处理" },
  { key: "ship", label: "已做单" },
  { key: "do_not_ship", label: "不做单" },
  { key: "priority", label: "优先处理" },
  { key: "manual_mapping", label: "长期映射" },
];

const workflowTabs: Array<{ key: WorkTab; label: string; icon: typeof FileSpreadsheet }> = [
  { key: "import", label: "导入订单", icon: FileSpreadsheet },
  { key: "review", label: "审核发货", icon: ClipboardList },
  { key: "export", label: "做单", icon: PackageCheck },
];

const maintenanceTabs: Array<{ key: WorkTab; label: string; icon: typeof FileSpreadsheet }> = [
  { key: "addresses", label: "地址维护", icon: MapPin },
  { key: "external-products", label: "商品维护", icon: PackageSearch },
];

export function App() {
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginName, setLoginName] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("yjmy");
  const [loginError, setLoginError] = useState("");
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [activeBatch, setActiveBatch] = useState<BatchSummary | null>(null);
  const [activeTab, setActiveTab] = useState<WorkTab>("import");
  const [reviewLines, setReviewLines] = useState<ReviewLineDto[]>([]);
  const [exports, setExports] = useState<ExportDto[]>([]);
  const [makeOrderReadiness, setMakeOrderReadiness] = useState<MakeOrderReadinessDto | null>(null);
  const [orderFile, setOrderFile] = useState(defaultOrderFile);
  const [mockFile, setMockFile] = useState(defaultMockFile);
  const [message, setMessage] = useState("请选择订单文件并开始初审");
  const [successNotice, setSuccessNotice] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [draftById, setDraftById] = useState<Record<string, ReviewDraft>>({});
  const [errorsById, setErrorsById] = useState<Record<string, string>>({});
  const [goodsSyncRun, setGoodsSyncRun] = useState<WdtGoodsSyncRunDto | null>(null);
  const [combinedSyncRun, setCombinedSyncRun] = useState<WdtSyncRunDto | null>(null);
  const [goodsSyncError, setGoodsSyncError] = useState("正在读取商品同步状态");
  const [goodsSyncMessage, setGoodsSyncMessage] = useState("");
  const [goodsSyncing, setGoodsSyncing] = useState(false);
  const [warehouseSettings, setWarehouseSettings] = useState<WarehouseUsageSettingsDto | null>(null);
  const [warehouseSettingsDraft, setWarehouseSettingsDraft] = useState<WarehouseUsageSettingsDto | null>(null);
  const [warehouseSettingsMessage, setWarehouseSettingsMessage] = useState("");
  const [wdtSyncSettings, setWdtSyncSettings] = useState<WdtSyncSettingsDto | null>(null);
  const [wdtSyncSettingsMessage, setWdtSyncSettingsMessage] = useState("");
  const [selectedOrderFileName, setSelectedOrderFileName] = useState("");
  const [pendingOrderUpload, setPendingOrderUpload] = useState<File | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [mappingFocusQuery, setMappingFocusQuery] = useState("");
  const [mappingFocusProduct, setMappingFocusProduct] = useState<ProductMappingFocusProduct | null>(null);
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [recheckingConfirmedOrder, setRecheckingConfirmedOrder] = useState(false);
  const [confirmedOrderRebuildPrompt, setConfirmedOrderRebuildPrompt] = useState<ConfirmedOrderRebuildPrompt | null>(null);
  const applyingProductMappingBatchIds = useRef(new Set<string>());
  const [unverifiedStockWarning, setUnverifiedStockWarning] = useState<SubmitReviewWarningDto | null>(null);
  const [savingDecisionIds, setSavingDecisionIds] = useState<Set<string>>(() => new Set());
  const [submittingReview, setSubmittingReview] = useState(false);
  const [addressFocus] = useState<{
    store: MakeOrderReadinessDto["missingStores"][number];
    requestId: number;
  } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(() => localStorage.getItem(helpDismissedStorageKey) !== "true");

  async function refreshBatches() {
    const response = await fetch("/api/v1/batches");
    setBatches(await response.json());
  }

  async function deleteBatch(batch: BatchSummary) {
    if (!window.confirm(`确定删除批次“${batch.fileName}”吗？相关审核明细和导出文件会一并删除。`)) return;
    const response = await fetch(`/api/v1/batches/${batch.id}`, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.json();
      setMessage(error.message ?? "批次删除失败");
      return;
    }
    if (activeBatch?.id === batch.id) {
      setActiveBatch(null);
      setReviewLines([]);
      setDraftById({});
      setErrorsById({});
      setExports([]);
      setMakeOrderReadiness(null);
    }
    await refreshBatches();
    setMessage("批次已删除");
    setSuccessNotice("批次已删除");
  }

  async function refreshGoodsSyncStatus() {
    const combinedResponse = await fetch("/api/v1/wdt/sync-runs/latest");
    if (combinedResponse.ok) {
      setCombinedSyncRun((await combinedResponse.json()) as WdtSyncRunDto);
      setGoodsSyncError("");
    } else if (combinedResponse.status === 404) {
      setCombinedSyncRun(null);
      setGoodsSyncError("尚无成功库存快照");
    } else {
      setCombinedSyncRun(null);
      setGoodsSyncError("商品与库存同步状态读取失败");
    }
    const response = await fetch("/api/v1/wdt/goods-sync-runs/latest");
    if (response.status === 404) {
      setGoodsSyncRun(null);
      return null;
    }
    if (!response.ok) {
      setGoodsSyncRun(null);
      return null;
    }
    const run = (await response.json()) as WdtGoodsSyncRunDto;
    setGoodsSyncRun(run);
    return run;
  }

  async function refreshWarehouseSettings() {
    const response = await fetch("/api/v1/settings/warehouse-usage");
    if (!response.ok) {
      setWarehouseSettingsMessage("仓库范围读取失败");
      return null;
    }
    const settings = (await response.json()) as WarehouseUsageSettingsDto;
    setWarehouseSettings(settings);
    setWarehouseSettingsDraft(settings);
    setWarehouseSettingsMessage("");
    return settings;
  }

  async function refreshWdtSyncSettings() {
    const response = await fetch("/api/v1/settings/wdt-sync");
    if (!response.ok) {
      setWdtSyncSettingsMessage("自动同步设置读取失败");
      return null;
    }
    const settings = (await response.json()) as WdtSyncSettingsDto;
    setWdtSyncSettings(settings);
    setWdtSyncSettingsMessage("");
    return settings;
  }

  async function runGoodsSync() {
    setGoodsSyncing(true);
    setGoodsSyncMessage("正在启动商品与库存后台同步...");
    const response = await fetch("/api/v1/wdt/sync-runs", {
      method: "POST",
    });
    if (!response.ok) {
      const error = await response.json();
      setGoodsSyncMessage(error.message ?? "商品与库存同步启动失败");
      setGoodsSyncing(false);
      return;
    }
    const result = (await response.json()) as StartWdtSyncResponseDto;
    setCombinedSyncRun(result.run);
    setGoodsSyncError("");
    setGoodsSyncMessage(result.alreadyRunning ? "已有同步任务正在运行" : "同步任务已进入后台队列");
    setGoodsSyncing(result.run.status === "queued" || result.run.status === "running");
  }

  async function checkMe() {
    const response = await fetch("/api/v1/me");
    const body = await response.json();
    setUser(body.user ?? null);
    setAuthLoading(false);
    if (body.user) {
      await refreshBatches();
      await refreshGoodsSyncStatus();
      await refreshWarehouseSettings();
      await refreshWdtSyncSettings();
    }
  }

  async function login() {
    setLoginError("");
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: loginName, password: loginPassword }),
    });
    if (!response.ok) {
      setLoginError("账号或密码错误");
      return;
    }
    const body = await response.json();
    setUser(body.user);
    await refreshBatches();
    await refreshGoodsSyncStatus();
    await refreshWarehouseSettings();
    await refreshWdtSyncSettings();
  }

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    setUser(null);
    setActiveBatch(null);
    setReviewLines([]);
    setExports([]);
    setMakeOrderReadiness(null);
    setGoodsSyncRun(null);
    setCombinedSyncRun(null);
    setGoodsSyncError("正在读取商品与库存同步状态");
    setGoodsSyncMessage("");
    setGoodsSyncing(false);
    setWarehouseSettings(null);
    setWarehouseSettingsDraft(null);
    setWarehouseSettingsMessage("");
  }

  async function loadBatch(batch: BatchSummary, nextTab?: WorkTab) {
    setActiveBatch(batch);
    setMakeOrderReadiness(null);
    if (nextTab) setActiveTab(nextTab);
    const lines = await fetchReviewLines(batch.id);
    if (!lines) return;
    setReviewLines(sortReviewLines(lines));
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await refreshExports(batch.id);
    await refreshMakeOrderReadiness(batch.id);
  }

  async function refreshExports(batchId: string) {
    const response = await fetch(`/api/v1/batches/${batchId}/exports`);
    if (!response.ok) {
      setExports([]);
      return;
    }
    setExports((await response.json()) as ExportDto[]);
  }

  async function refreshMakeOrderReadiness(batchId: string) {
    const response = await fetch(`/api/v1/batches/${batchId}/make-order-readiness`);
    if (!response.ok) {
      setMakeOrderReadiness(null);
      return;
    }
    setMakeOrderReadiness((await response.json()) as MakeOrderReadinessDto);
  }

  async function correctBatchStoreFields(
    store: MakeOrderReadinessDto["missingStores"][number],
    next: { storeNo: string; storeName: string },
  ) {
    if (!activeBatch) {
      setMessage("请先选择一个批次");
      return;
    }
    setMessage("正在修正本批门店字段...");
    const response = await fetch(`/api/v1/batches/${activeBatch.id}/store-fields`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentStoreNo: store.storeNo,
        currentStoreName: store.storeName,
        nextStoreNo: next.storeNo,
        nextStoreName: next.storeName,
      }),
    });
    if (!response.ok) {
      const error = await response.json();
      setMessage(error.message ?? "本批门店字段修正失败");
      return;
    }
    const result = (await response.json()) as UpdateBatchStoreFieldsResponse;
    setActiveBatch(result.batch);
    const lines = await fetchReviewLines(result.batch.id);
    if (!lines) return;
    setReviewLines(sortReviewLines(lines));
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    setMakeOrderReadiness(result.makeOrderReadiness);
    await refreshExports(result.batch.id);
    await refreshBatches();
    setMessage("已修正本批门店字段");
    setSuccessNotice(result.makeOrderReadiness.canExport ? "门店字段已修正，可以继续生成做单" : "门店字段已修正，请继续处理剩余缺地址项");
  }

  async function fetchReviewLines(batchId: string) {
    const response = await fetch(`/api/v1/batches/${batchId}/review-lines`);
    const body = await response.json();
    if (!response.ok || !Array.isArray(body)) {
      setReviewLines([]);
      setDraftById({});
      setErrorsById({});
      setMessage(body?.message ?? "审核明细读取失败");
      return null;
    }
    return body as ReviewLineDto[];
  }

  async function runMockBatch() {
    setMessage("正在创建批次...");
    const createdResponse = await fetch("/api/v1/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: orderFile, mode: "mock" }),
    });
    const created = (await createdResponse.json()) as BatchSummary;
    setMessage("正在生成初审结果...");
    const reviewResponse = await fetch(`/api/v1/batches/${created.id}/actions/run-mock-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mockDataFile: mockFile }),
    });
    const review = await reviewResponse.json();
    setActiveBatch(review.batch);
    setActiveTab("review");
    const lines = await fetchReviewLines(created.id);
    if (!lines) return;
    setReviewLines(sortReviewLines(lines));
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await refreshExports(created.id);
    await refreshMakeOrderReadiness(created.id);
    setMessage("初审已完成，请进入审核发货");
    setSuccessNotice("订单导入成功，已生成初审结果");
    await refreshBatches();
  }

  async function runRealBatch() {
    const latestSync = goodsSyncRun?.status ? goodsSyncRun : await refreshGoodsSyncStatus();
    if (!latestSync || latestSync.status !== "success") {
      setMessage(realReviewBlockedMessage(latestSync, goodsSyncError));
      return;
    }
    const orderFileInfo = await resolveOrderFile();
    if (!orderFileInfo) return;
    setMessage("正在创建真实订单批次...");
    const createdResponse = await fetch("/api/v1/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: orderFileInfo.filePath, fileName: orderFileInfo.fileName, mode: "production_api" }),
    });
    if (!createdResponse.ok) {
      setMessage("导入未完成，请检查订单文件");
      return;
    }

    const created = (await createdResponse.json()) as BatchSummary;
    setMessage("正在读取商品档案并查询库存...");
    const reviewResponse = await fetch(`/api/v1/batches/${created.id}/actions/run-real-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowStaleCache: false }),
    });
    if (!reviewResponse.ok) {
      const error = await reviewResponse.json();
      setActiveBatch(created);
      setActiveTab("review");
      setReviewLines([]);
      setDraftById({});
      setErrorsById({});
      await refreshExports(created.id);
      await refreshMakeOrderReadiness(created.id);
      await refreshBatches();
      setMessage(error.message ?? "真实初审失败");
      return;
    }

    const review = await reviewResponse.json();
    setActiveBatch(review.batch);
    setActiveTab("review");
    const lines = await fetchReviewLines(created.id);
    if (!lines) return;
    setReviewLines(sortReviewLines(lines));
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await refreshExports(created.id);
    await refreshMakeOrderReadiness(created.id);
    setMessage(`真实初审已完成，已查询库存 ${review.stockQueriedCount ?? 0} 个规格`);
    setSuccessNotice("订单导入成功，已生成初审结果");
    await refreshBatches();
  }

  async function importConfirmedOrder() {
    if (!pendingOrderUpload) {
      setMessage("请先选择确定单文件");
      return;
    }
    setMessage("正在导入确定单...");
    const response = await fetch("/api/v1/confirmed-orders/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: pendingOrderUpload.name,
        contentBase64: await fileToBase64(pendingOrderUpload),
      }),
    });
    if (!response.ok) {
      const error = await response.json();
      setMessage(error.message ?? "确定单导入失败");
      return;
    }
    const result = (await response.json()) as ImportConfirmedOrderResponse;
    setPendingOrderUpload(null);
    setSelectedOrderFileName("");
    setActiveBatch(result.batch);
    setActiveTab("review");
    const lines = await fetchReviewLines(result.batch.id);
    if (!lines) return;
    setReviewLines(sortReviewLines(lines));
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await refreshExports(result.batch.id);
    await refreshMakeOrderReadiness(result.batch.id);
    await refreshBatches();
    setMessage(`确定单已导入：${result.parsedRowCount} 行，已匹配 ${result.matchedRowCount} 行，待补字段 ${result.unmatchedRowCount} 行`);
    setSuccessNotice("确定单导入成功，请确认系统建议并提交审核");
  }

  async function recheckConfirmedOrderBatch(
    batch: BatchSummary | null,
    strategy: ConfirmedOrderRebuildStrategy,
    options: { userTriggered?: boolean } = {},
  ): Promise<ImportConfirmedOrderResponse | null> {
    if (!batch) {
      setMessage("请先选择一个确定单批次");
      return null;
    }
    if (batch.sourceType !== "confirmed_order") {
      setMessage("当前批次不是确定单，不能使用确定单重新校验");
      return null;
    }

    setRecheckingConfirmedOrder(true);
    setMessage(options.userTriggered ? "正在重新校验确定单..." : "正在重新校验当前确定单...");
    try {
      const rebuildResponse = await fetch(`/api/v1/batches/${batch.id}/actions/rebuild-confirmed-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy }),
      });
      if (!rebuildResponse.ok) {
        const error = await rebuildResponse.json();
        setMessage(error.message ?? "确定单重新校验失败");
        return null;
      }
      const rebuild = (await rebuildResponse.json()) as ImportConfirmedOrderResponse;
      setActiveBatch(rebuild.batch);
      const lines = await fetchReviewLines(rebuild.batch.id);
      if (!lines) return null;
      setReviewLines(sortReviewLines(lines));
      setDraftById(buildDrafts(lines));
      setErrorsById({});
      const summary = `确定单已重新校验：${rebuild.parsedRowCount} 行，已匹配 ${rebuild.matchedRowCount} 行，待补字段 ${rebuild.unmatchedRowCount} 行`;
      setMessage(summary);
      setSuccessNotice(
        strategy === "preserve"
          ? "系统建议已刷新，当前审核结果已保留；请重新提交审核"
          : "已按最新库存重新分配；请检查结果并重新提交审核",
      );
      void Promise.allSettled([
        refreshExports(rebuild.batch.id),
        refreshMakeOrderReadiness(rebuild.batch.id),
        refreshBatches(),
      ]);
      return rebuild;
    } finally {
      setRecheckingConfirmedOrder(false);
    }
  }

  async function rerunActiveBatchAfterMapping(mapping: ProductMappingDto) {
    if (!activeBatch) {
      setMessage("长期商品映射已保存，正式订单重新初审后生效");
      return;
    }
    if (activeBatch.sourceType === "confirmed_order") {
      const mappingLabel = mapping.externalBarcode || mapping.externalGoodsCode || mapping.externalGoodsName;
      const batch = activeBatch;
      setMappingDialogOpen(false);
      if (applyingProductMappingBatchIds.current.has(batch.id)) {
        setMessage("长期商品映射已保存，当前确定单正在应用另一条映射");
        return;
      }
      applyingProductMappingBatchIds.current.add(batch.id);
      setMessage(`长期商品映射已保存，正在应用到当前确定单：${mappingLabel}`);
      try {
        const response = await fetch(`/api/v1/batches/${batch.id}/actions/apply-product-mapping`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mappingId: mapping.id }),
        });
        if (!response.ok) {
          const error = await response.json();
          setMessage(error.message ?? "映射已保存，但应用到当前确定单失败");
          setSuccessNotice("映射已保存，可手工重新校验确定单恢复当前审核");
          return;
        }
        const result = (await response.json()) as ApplyProductMappingResponse;
        setActiveBatch(result.batch);
        if (result.mode === "full_rebuild_fallback") {
          setReviewLines(sortReviewLines(result.reviewLines));
          setDraftById(buildDrafts(result.reviewLines));
          setErrorsById({});
          setMessage("原库存快照已清理，已按最新库存完整校验当前确定单");
        } else {
          const updatedById = new Map(result.reviewLines.map((line) => [line.id, line]));
          setReviewLines((current) => sortReviewLines(current.map((line) => updatedById.get(line.id) ?? line)));
          setDraftById((current) => ({ ...current, ...buildDrafts(result.reviewLines) }));
          setErrorsById((current) => Object.fromEntries(Object.entries(current).filter(([lineId]) => !updatedById.has(lineId))));
          setMessage(`映射已应用：影响 ${result.affectedExternalRowCount} 行、${result.affectedSkuPoolCount} 个库存池`);
        }
        await Promise.all([
          refreshExports(batch.id),
          refreshMakeOrderReadiness(batch.id),
          refreshBatches(),
        ]);
        setSuccessNotice("映射已应用到当前批次，请重新提交审核");
      } catch {
        setMessage("映射已保存，但应用到当前确定单失败");
        setSuccessNotice("映射已保存，可手工重新校验确定单恢复当前审核");
      } finally {
        applyingProductMappingBatchIds.current.delete(batch.id);
      }
      return;
    }
    if (activeBatch.mode !== "production_api") {
      setMessage("长期商品映射已保存，正式订单重新初审后生效");
      return;
    }
    setMessage("长期商品映射已保存，正在刷新当前批次初审...");
    const reviewResponse = await fetch(`/api/v1/batches/${activeBatch.id}/actions/run-real-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowStaleCache: false }),
    });
    if (!reviewResponse.ok) {
      const error = await reviewResponse.json();
      setMessage(error.message ?? "映射已保存，但当前批次刷新初审失败");
      return;
    }

    const review = await reviewResponse.json();
    setActiveBatch(review.batch);
    const lines = await fetchReviewLines(activeBatch.id);
    if (!lines) return;
    setReviewLines(sortReviewLines(lines));
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await Promise.all([refreshExports(activeBatch.id), refreshMakeOrderReadiness(activeBatch.id), refreshBatches()]);
    setMessage(`长期商品映射已保存，当前批次已刷新：${mapping.externalBarcode || mapping.externalGoodsCode || mapping.externalGoodsName}`);
    setSuccessNotice("映射已应用到当前批次");
  }

  async function resolveOrderFile() {
    if (!pendingOrderUpload) {
      if (!selectedOrderFileName && !developerMode) {
        setMessage("请先选择订货单文件");
        return null;
      }
      return {
        filePath: orderFile,
        fileName: selectedOrderFileName || orderFile.split(/[\\/]/).at(-1) || orderFile,
      };
    }

    setMessage("正在上传订货单...");
    const response = await fetch("/api/v1/order-files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: pendingOrderUpload.name,
        contentBase64: await fileToBase64(pendingOrderUpload),
      }),
    });
    if (!response.ok) {
      const error = await response.json();
      setMessage(error.message ?? "订货单上传失败");
      return null;
    }
    const uploaded = (await response.json()) as { filePath: string; fileName: string };
    setOrderFile(uploaded.filePath);
    setSelectedOrderFileName(uploaded.fileName);
    setPendingOrderUpload(null);
    return uploaded;
  }

  async function saveDecision(line: ReviewLineDto, patch?: Partial<ReviewDraft>, options: { silent?: boolean } = {}) {
    const draft = { ...draftById[line.id], ...patch };
    const approvedShipQty = Number(draft.approvedShipQty);
    const localError = validateDraft(line, draft, approvedShipQty);
    if (localError) {
      setErrorsById((current) => ({ ...current, [line.id]: localError }));
      return;
    }

    setSavingDecisionIds((current) => new Set(current).add(line.id));
    try {
      const response = await fetch(`/api/v1/batches/${line.batchId}/review-lines/${line.id}/decision`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: draft.decision,
          approvedShipQty,
          fulfillmentWarehouseNo: draft.fulfillmentWarehouseNo,
          fulfillmentWarehouseName: draft.fulfillmentWarehouseName,
          reason: draft.reason.trim(),
        }),
      });
      if (!response.ok) {
        const error = await response.json();
        setErrorsById((current) => ({ ...current, [line.id]: error.message ?? "保存失败" }));
        return;
      }
      const updated = (await response.json()) as ReviewLineDto;
      setReviewLines((current) => sortReviewLines(current.map((item) => (item.id === updated.id ? updated : item))));
      setDraftById((current) => ({ ...current, [updated.id]: toDraft(updated) }));
      setErrorsById((current) => {
        const next = { ...current };
        delete next[updated.id];
        return next;
      });
      if (!options.silent) setMessage("审核决定已保存");
      await refreshMakeOrderReadiness(line.batchId);
    } finally {
      setSavingDecisionIds((current) => {
        const next = new Set(current);
        next.delete(line.id);
        return next;
      });
    }
  }

  async function quickDecision(line: ReviewLineDto, decision: ReviewDecision) {
    const nextDraft: ReviewDraft =
      decision === "ship"
        ? {
            decision,
            approvedShipQty: String(line.suggestedShipQty),
            fulfillmentWarehouseNo: draftById[line.id]?.fulfillmentWarehouseNo || line.suggestedWarehouseNo,
            fulfillmentWarehouseName: draftById[line.id]?.fulfillmentWarehouseName || line.suggestedWarehouseName,
            reason: draftById[line.id]?.reason ?? "",
          }
        : {
            decision,
            approvedShipQty: "0",
            fulfillmentWarehouseNo: "",
            fulfillmentWarehouseName: "",
            reason: draftById[line.id]?.reason ?? "",
          };
    setDraftById((current) => ({ ...current, [line.id]: nextDraft }));
    await saveDecision(line, nextDraft);
  }

  async function togglePriority(line: ReviewLineDto, priority: boolean) {
    const reason = (draftById[line.id]?.reason ?? line.reason ?? line.priorityReason ?? "").trim();

    const response = await fetch(`/api/v1/batches/${line.batchId}/review-lines/${line.id}/priority`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority, reason }),
    });
    if (!response.ok) {
      const error = await response.json();
      setErrorsById((current) => ({ ...current, [line.id]: error.message ?? "优先处理更新失败" }));
      return;
    }
    const updated = (await response.json()) as ReviewLineDto;
    setReviewLines((current) => sortReviewLines(current.map((item) => (item.id === updated.id ? updated : item))));
    setErrorsById((current) => {
      const next = { ...current };
      delete next[updated.id];
      return next;
    });
    setMessage(priority ? "已标记为优先处理" : "已取消优先处理");
  }

  async function saveWarehouseSettings() {
    if (!warehouseSettingsDraft) return;
    const response = await fetch("/api/v1/settings/warehouse-usage", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        includeMainWarehouse: warehouseSettingsDraft.includeMainWarehouse,
        includeNearExpiryWarehouse: warehouseSettingsDraft.includeNearExpiryWarehouse,
        includeDefectWarehouse: warehouseSettingsDraft.includeDefectWarehouse,
        includeOtherWarehouses: warehouseSettingsDraft.includeOtherWarehouses,
      }),
    });
    if (!response.ok) {
      const error = await response.json();
      setWarehouseSettingsMessage(error.message ?? "仓库范围保存失败");
      return;
    }
    const settings = (await response.json()) as WarehouseUsageSettingsDto;
    setWarehouseSettings(settings);
    setWarehouseSettingsDraft(settings);
    setWarehouseSettingsMessage("已保存，重新运行初审后生效");
    await refreshGoodsSyncStatus();
  }

  async function saveWdtSyncInterval(intervalHours: WdtAutoSyncIntervalHours) {
    const response = await fetch("/api/v1/settings/wdt-sync", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intervalHours }),
    });
    if (!response.ok) {
      const error = await response.json();
      setWdtSyncSettingsMessage(error.message ?? "自动同步周期保存失败");
      return;
    }
    const settings = (await response.json()) as WdtSyncSettingsDto;
    setWdtSyncSettings(settings);
    setWdtSyncSettingsMessage(`已改为每 ${settings.intervalHours} 小时自动同步`);
  }

  async function bulkApprove() {
    if (!activeBatch) return;
    const response = await fetch(`/api/v1/batches/${activeBatch.id}/actions/bulk-approve`, { method: "POST" });
    if (!response.ok) {
      setMessage("批量通过失败");
      return;
    }
    const result = await response.json();
    setActiveBatch(result.batch);
    await loadBatch(result.batch, "review");
    await refreshBatches();
    setMessage(`已批量通过 ${result.updatedCount} 行`);
  }

  async function submitReview(confirmUnverifiedStock = false) {
    if (!activeBatch) return;
    if (recheckingConfirmedOrder) {
      setMessage("当前批次仍在重新校验，请稍候再提交审核");
      return;
    }
    if (savingDecisionIds.size > 0) {
      setMessage("还有审核结果正在保存，请稍候再提交");
      return;
    }
    const unsavedCount = reviewLines.filter((line) => reviewDraftIsDirty(line, draftById[line.id])).length;
    if (unsavedCount > 0) {
      setMessage(`还有 ${unsavedCount} 条审核修改尚未保存，请先保存后再提交`);
      return;
    }
    if (Object.keys(errorsById).length > 0) {
      setMessage("仍有审核结果保存失败，请处理行内错误后再提交");
      return;
    }

    setSubmittingReview(true);
    try {
      const response = await fetch(`/api/v1/batches/${activeBatch.id}/actions/submit-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmUnverifiedStock }),
      });
      const result = (await response.json()) as SubmitReviewResultDto | { message?: string };
      if (response.status === 409 && "requiresConfirmation" in result && result.requiresConfirmation) {
        setUnverifiedStockWarning(result);
        setMessage(result.message);
        return;
      }
      if (!response.ok || !("batch" in result)) {
        setMessage("message" in result ? result.message ?? "提交审核失败" : "提交审核失败");
        return;
      }
      setUnverifiedStockWarning(null);
      setActiveBatch(result.batch);
      await refreshMakeOrderReadiness(result.batch.id);
      await refreshBatches();
      setMessage(`审核已提交：待审核 ${result.pendingCount}，发货 ${result.shipCount}，不发 ${result.doNotShipCount}`);
      setSuccessNotice("审核完成，当前批次可以进入做单");
    } finally {
      setSubmittingReview(false);
    }
  }

  async function createExport(type: ExportDto["type"]) {
    if (!activeBatch) return;
    setMessage("正在生成导出文件...");
    const response = await fetch(`/api/v1/batches/${activeBatch.id}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    if (!response.ok) {
      setMessage("导出失败");
      return;
    }
    const created = (await response.json()) as ExportDto;
    await refreshExports(activeBatch.id);
    await refreshMakeOrderReadiness(activeBatch.id);
    setMessage(created.status === "ready" ? "导出文件已生成" : "导出失败");
  }

  function locateProductMapping(line: ReviewLineDto) {
    const query = line.externalBarcode || line.externalGoodsName || line.wdtSpecNo;
    setMappingFocusQuery(query);
    setMappingFocusProduct({
      externalBarcode: line.externalBarcode,
      externalGoodsCode: line.externalGoodsCode,
      externalGoodsName: line.externalGoodsName,
      wdtSpecNo: line.wdtSpecNo,
      wdtMakeOrderCode: line.wdtMakeOrderCode,
      status: line.status,
      mainAvailableBefore: line.mainAvailableBefore,
      nearExpiryAvailableBefore: line.nearExpiryAvailableBefore,
    });
    setMappingDialogOpen(true);
    setMessage("已打开商品映射，保存长期映射后会自动刷新当前批次");
  }

  function openProductMappingLibrary() {
    setMappingFocusQuery("");
    setMappingFocusProduct(null);
    setMappingDialogOpen(true);
  }

  function updateDraft(lineId: string, patch: Partial<ReviewDraft>) {
    setDraftById((current) => ({ ...current, [lineId]: { ...current[lineId], ...patch } }));
  }

  function dismissHelp() {
    localStorage.setItem(helpDismissedStorageKey, "true");
    setShowHelp(false);
  }

  function reopenHelp() {
    localStorage.removeItem(helpDismissedStorageKey);
    setShowHelp(true);
  }

  useEffect(() => {
    void checkMe();
  }, []);

  useEffect(() => {
    if (combinedSyncRun?.status !== "queued" && combinedSyncRun?.status !== "running") return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refreshGoodsSyncStatus();
      if (!cancelled) timer = window.setTimeout(() => { void poll(); }, 2000);
    };
    timer = window.setTimeout(() => { void poll(); }, 2000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [combinedSyncRun?.status]);

  useEffect(() => {
    setGoodsSyncing(combinedSyncRun?.status === "queued" || combinedSyncRun?.status === "running");
  }, [combinedSyncRun?.status]);

  useEffect(() => {
    if (!successNotice) return;
    const timer = window.setTimeout(() => setSuccessNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [successNotice]);

  const stats = useMemo(() => buildStats(reviewLines), [reviewLines]);
  const filteredLines = useMemo(
    () => reviewLines.filter((line) => matchesFilter(line, activeFilter, activeBatch?.sourceType === "confirmed_order")),
    [reviewLines, activeFilter, activeBatch?.sourceType],
  );
  const pendingMappingSummary = useMemo(() => summarizePendingMappingGroups(reviewLines), [reviewLines]);
  const permissions = useMemo(() => buildUserPermissions(user), [user]);

  if (authLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="text-sm text-muted-foreground">正在检查登录状态...</div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
        <section className="w-full max-w-sm rounded-md border border-border bg-card p-6 shadow-sm">
          <p className="text-sm text-muted-foreground">漾锦贸易订单初审平台</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-normal">登录工作台</h1>
          <label className="mt-6 block text-sm text-muted-foreground">用户名</label>
          <input
            aria-label="用户名"
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={loginName}
            onChange={(event) => setLoginName(event.target.value)}
          />
          <label className="mt-3 block text-sm text-muted-foreground">密码</label>
          <input
            aria-label="密码"
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            type="password"
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void login();
            }}
          />
          {loginError ? <div className="mt-3 text-sm text-rose-700">{loginError}</div> : null}
          <Button className="mt-5 w-full" onClick={() => void login()}>
            登录
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-5 py-5">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-sm text-muted-foreground">漾锦贸易订单初审平台</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">订单处理工作台</h1>
          </div>
          <GoodsSyncHeaderStatus error={goodsSyncError} run={combinedSyncRun} settings={wdtSyncSettings} />
          <div className="flex flex-wrap items-center gap-2">
            {activeBatch ? <Badge tone={batchStatusTone(activeBatch.status)}>{batchStatusText(activeBatch)}</Badge> : null}
            <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={reopenHelp}>
              <HelpCircle className="h-4 w-4" />
              帮助
            </Button>
            <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={() => setShowSettings((current) => !current)}>
              <Settings className="h-4 w-4" />
              设置
            </Button>
            <label className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2 text-sm text-muted-foreground">
              <input
                className="h-4 w-4"
                type="checkbox"
                checked={developerMode}
                onChange={(event) => setDeveloperMode(event.target.checked)}
              />
              开发者模式
            </label>
            <Badge tone="neutral">{user.username}</Badge>
            <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" />
              退出
            </Button>
          </div>
        </header>
        {successNotice ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
            {successNotice}
          </div>
        ) : null}

        {showSettings ? (
          <SettingsPanel
            canSyncGoods={permissions.canSyncGoods}
            canManageSettings={permissions.canManageSettings}
            goodsSyncError={goodsSyncError}
            goodsSyncing={goodsSyncing}
            goodsSyncMessage={goodsSyncMessage}
            goodsSyncRun={goodsSyncRun}
            combinedSyncRun={combinedSyncRun}
            developerMode={developerMode}
            warehouseSettings={warehouseSettings}
            warehouseSettingsDraft={warehouseSettingsDraft}
            warehouseSettingsMessage={warehouseSettingsMessage}
            wdtSyncSettings={wdtSyncSettings}
            wdtSyncSettingsMessage={wdtSyncSettingsMessage}
            onClose={() => setShowSettings(false)}
            onRunGoodsSync={() => void runGoodsSync()}
            onSaveWarehouseSettings={() => void saveWarehouseSettings()}
            onWdtSyncIntervalChange={(intervalHours) => void saveWdtSyncInterval(intervalHours)}
            onWarehouseSettingsDraftChange={setWarehouseSettingsDraft}
          />
        ) : null}

        <section className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <BatchList batches={batches} activeBatchId={activeBatch?.id} canDelete={permissions.canDeleteBatch} onDelete={(batch) => void deleteBatch(batch)} onSelect={(batch) => void loadBatch(batch)} />

          <section className="min-w-0">
            {showHelp ? <HelpPanel onDismiss={dismissHelp} /> : null}
            <CurrentBatchPanel batch={activeBatch} message={message} reviewLines={reviewLines} />

            <div className="mt-4 grid gap-3 2xl:grid-cols-[minmax(0,1fr)_auto]">
              <nav className="grid gap-2 rounded-md border border-border bg-card p-1 sm:grid-cols-3" aria-label="业务步骤">
                {workflowTabs.map((tab) => {
                  const Icon = tab.icon;
                  const active = tab.key === activeTab;
                  return (
                    <button
                      key={tab.key}
                      className={
                        active
                          ? "inline-flex h-10 items-center justify-center gap-2 rounded bg-primary px-3 text-sm font-medium text-primary-foreground"
                          : "inline-flex h-10 items-center justify-center gap-2 rounded px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted"
                      }
                      data-testid={`work-tab-${tab.key}`}
                      onClick={() => setActiveTab(tab.key)}
                    >
                      <Icon className="h-4 w-4" />
                      {tab.label}
                    </button>
                  );
                })}
              </nav>
              <nav className="grid gap-2 rounded-md border border-border bg-muted/30 p-1 sm:grid-cols-2 2xl:min-w-[260px]" aria-label="基础资料">
                {maintenanceTabs.map((tab) => {
                  const Icon = tab.icon;
                  const active = tab.key === activeTab;
                  return (
                    <button
                      key={tab.key}
                      className={
                        active
                          ? "inline-flex h-10 items-center justify-center gap-2 rounded border border-primary/20 bg-card px-3 text-sm font-medium text-primary shadow-sm"
                          : "inline-flex h-10 items-center justify-center gap-2 rounded px-3 text-sm font-medium text-muted-foreground transition hover:bg-card"
                      }
                      data-testid={`maintenance-tab-${tab.key}`}
                      onClick={() => setActiveTab(tab.key)}
                    >
                      <Icon className="h-4 w-4" />
                      {tab.label}
                    </button>
                  );
                })}
              </nav>
            </div>

            {activeTab === "import" ? (
              <ImportTab
                goodsSyncError={goodsSyncError}
                goodsSyncRun={goodsSyncRun}
                isDeveloperMode={developerMode}
                mockFile={mockFile}
                orderFile={orderFile}
                selectedOrderFileName={selectedOrderFileName}
                canImport={permissions.canImport}
                onOrderFileSelect={(file) => {
                  setPendingOrderUpload(file);
                  setSelectedOrderFileName(file.name);
                  setMessage("已选择订货单，点击导入新订单开始初审");
                }}
                onMockFileChange={setMockFile}
                onOrderFileChange={setOrderFile}
                onRunDemo={() => void runMockBatch()}
                onRunConfirmed={() => void importConfirmedOrder()}
                onRunReal={() => void runRealBatch()}
              />
            ) : null}

            {activeTab === "review" ? (
              <ReviewTab
                activeBatch={activeBatch}
                activeFilter={activeFilter}
                draftById={draftById}
                errorsById={errorsById}
                filteredLines={filteredLines}
                isDeveloperMode={developerMode}
                savingDecisionIds={savingDecisionIds}
                submittingReview={submittingReview}
                warehouseSettings={warehouseSettings}
                canReview={permissions.canReview}
                stats={stats}
                pendingMappingSummary={pendingMappingSummary}
                onBulkApprove={() => void bulkApprove()}
                onDraftChange={updateDraft}
                onFilterChange={setActiveFilter}
                onLocateMapping={locateProductMapping}
                onOpenMappingLibrary={openProductMappingLibrary}
                onPriorityChange={togglePriority}
                onQuickDecision={quickDecision}
                onRecheckConfirmedOrder={() => {
                  if (activeBatch) setConfirmedOrderRebuildPrompt({ batch: activeBatch });
                }}
                onSave={saveDecision}
                onSubmitReview={() => void submitReview()}
                canRecheckConfirmedOrder={permissions.canImport}
                recheckingConfirmedOrder={recheckingConfirmedOrder}
              />
            ) : null}

            {activeTab === "export" ? (
              <ExportTab
                activeBatch={activeBatch}
                canExport={permissions.canExport}
                exports={exports}
                makeOrderReadiness={makeOrderReadiness}
                onCorrectStoreFields={(store, next) => void correctBatchStoreFields(store, next)}
                onCreateExport={(type) => void createExport(type)}
              />
            ) : null}

            {activeTab === "addresses" ? (
              <AddressTab
                canEdit={permissions.canExport}
                focusMissingStore={addressFocus?.store ?? null}
                focusMissingStoreRequestId={addressFocus?.requestId ?? 0}
                missingStores={makeOrderReadiness?.missingStores ?? []}
                onMessage={setMessage}
                onSaved={() => {
                  if (activeBatch) void refreshMakeOrderReadiness(activeBatch.id);
                }}
              />
            ) : null}

            {activeTab === "external-products" ? (
              <ExternalProductTab
                canEdit={permissions.canExport}
                onMessage={setMessage}
              />
            ) : null}
          </section>
        </section>
      </section>
      <ProductMappingDialog
        focusQuery={mappingFocusQuery}
        focusProduct={mappingFocusProduct}
        open={mappingDialogOpen}
        sourceBatchId={activeBatch?.id ?? ""}
        onClose={() => setMappingDialogOpen(false)}
        onMessage={setMessage}
        onConfirmed={rerunActiveBatchAfterMapping}
      />
      <ConfirmedOrderRebuildDialog
        prompt={confirmedOrderRebuildPrompt}
        rechecking={recheckingConfirmedOrder}
        onCancel={() => {
          setConfirmedOrderRebuildPrompt(null);
        }}
        onSelect={(strategy) => {
          const prompt = confirmedOrderRebuildPrompt;
          if (!prompt) return;
          setConfirmedOrderRebuildPrompt(null);
          void recheckConfirmedOrderBatch(prompt.batch, strategy, {
            userTriggered: true,
          });
        }}
      />
      <UnverifiedStockConfirmDialog
        warning={unverifiedStockWarning}
        submitting={submittingReview}
        onCancel={() => setUnverifiedStockWarning(null)}
        onConfirm={() => {
          setUnverifiedStockWarning(null);
          void submitReview(true);
        }}
      />
    </main>
  );
}

function ConfirmedOrderRebuildDialog({
  prompt,
  rechecking,
  onCancel,
  onSelect,
}: {
  prompt: ConfirmedOrderRebuildPrompt | null;
  rechecking: boolean;
  onCancel: () => void;
  onSelect: (strategy: ConfirmedOrderRebuildStrategy) => void;
}) {
  if (!prompt) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6" role="dialog" aria-modal="true" aria-labelledby="confirmed-order-rebuild-title">
      <section className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold" id="confirmed-order-rebuild-title">重新校验确定单</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              系统将按最新商品映射、库存和仓库设置重新计算建议。重新校验后必须再次提交审核。
            </p>
          </div>
          <Button className="h-8 shrink-0 bg-muted px-2 text-muted-foreground hover:bg-muted/80" disabled={rechecking} onClick={onCancel}>
            <X className="h-4 w-4" />
            取消
          </Button>
        </div>
        <div className="mt-5 grid gap-3">
          <button
            className="rounded-md border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-muted/40 disabled:opacity-50"
            disabled={rechecking}
            onClick={() => onSelect("preserve")}
          >
            <span className="block text-sm font-semibold">保留当前审核结果</span>
            <span className="mt-1 block text-sm leading-6 text-muted-foreground">更新匹配、库存、系统建议和建议仓库；保留最终数量、最终仓库与备注。</span>
          </button>
          <button
            className="rounded-md border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-muted/40 disabled:opacity-50"
            disabled={rechecking}
            onClick={() => onSelect("replace")}
          >
            <span className="block text-sm font-semibold">按最新库存重新分配</span>
            <span className="mt-1 block text-sm leading-6 text-muted-foreground">用最新系统建议覆盖最终数量和最终仓库；已填写的备注仍会保留。</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function UnverifiedStockConfirmDialog({
  warning,
  submitting,
  onCancel,
  onConfirm,
}: {
  warning: SubmitReviewWarningDto | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!warning) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6" role="alertdialog" aria-modal="true" aria-labelledby="unverified-stock-title">
      <section className="w-full max-w-md rounded-lg border border-amber-200 bg-background p-5 shadow-lg">
        <Badge tone="warn">需要人工确认</Badge>
        <h2 className="mt-3 text-lg font-semibold" id="unverified-stock-title">库存尚未完成核验</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{warning.message}。如果继续，系统会保留人工填写的最终数量和仓库，并允许后续做单。</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button className="bg-muted text-muted-foreground hover:bg-muted/80" disabled={submitting} onClick={onCancel}>返回检查</Button>
          <Button disabled={submitting} onClick={onConfirm}>{submitting ? "提交中..." : `确认并提交 ${warning.affectedCount} 条`}</Button>
        </div>
      </section>
    </div>
  );
}

function BatchList({
  activeBatchId,
  batches,
  canDelete,
  onDelete,
  onSelect,
}: {
  activeBatchId?: string;
  batches: BatchSummary[];
  canDelete: boolean;
  onDelete: (batch: BatchSummary) => void;
  onSelect: (batch: BatchSummary) => void;
}) {
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);

  return (
    <aside className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">历史批次</h2>
        <Badge tone="neutral">{batches.length} 个</Badge>
      </div>
      <div className="space-y-2">
        {batches.length === 0 ? <div className="text-sm text-muted-foreground">暂无批次</div> : null}
        {batches.map((batch) => {
          const expanded = expandedBatchId === batch.id;
          const uploadDate = formatBatchListDate(batch.createdAt);
          return (
            <div
              key={batch.id}
              className={
                batch.id === activeBatchId
                  ? `rounded-md border ${batchStatusCardClass(batch.status)} ring-1 ring-primary/40`
                  : `rounded-md border ${batchStatusCardClass(batch.status)}`
              }
            >
              <button
                className="w-full px-3 py-3 text-left text-sm"
                data-testid={`batch-card-${batch.id}`}
                onClick={() => onSelect(batch)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <time className="rounded bg-teal-100 px-2 py-1 text-xs font-semibold text-teal-900" dateTime={batch.createdAt}>
                        上传 {uploadDate.date}
                      </time>
                      {uploadDate.time ? <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">{uploadDate.time}</span> : null}
                    </div>
                    <div className="mt-2 flex min-w-0 items-start gap-2">
                      <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                      <div className="min-w-0 break-words font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{batch.fileName}</div>
                    </div>
                  </div>
                  <Badge tone={batchStatusTone(batch.status)}>{batchStatusText(batch)}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span>{batch.orderLineCount} 行</span>
                  <span>
                    {batch.matchedBarcodeCount}/{batch.uniqueBarcodeCount} {batch.sourceType === "confirmed_order" ? "可做单" : "已匹配"}
                  </span>
                </div>
              </button>
              <div className="flex border-t border-border/70">
                <button
                  className="flex min-w-0 flex-1 items-center justify-center gap-1 px-3 py-1.5 text-xs text-muted-foreground hover:bg-background/50"
                  onClick={() => setExpandedBatchId(expanded ? null : batch.id)}
                >
                  {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {expanded ? "收起详情" : "查看详情"}
                </button>
                {canDelete ? (
                  <button
                    aria-label={`删除批次 ${batch.fileName}`}
                    className="flex items-center justify-center gap-1 border-l border-border/70 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                    onClick={() => onDelete(batch)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </button>
                ) : null}
              </div>
              {expanded ? (
                <dl className="grid gap-2 border-t border-border/70 px-3 py-2 text-xs">
                  <MetaItem label="上传时间" value={formatShortDate(batch.createdAt)} />
                  <MetaItem label="更新时间" value={formatShortDate(batch.updatedAt)} />
                  <MetaItem label="订单行数" value={`${batch.orderLineCount}`} />
                  <MetaItem label="唯一条码" value={`${batch.uniqueBarcodeCount}`} />
                  <MetaItem label="匹配情况" value={`${batch.matchedBarcodeCount}/${batch.uniqueBarcodeCount}`} />
                  <MetaItem label="初审模式" value={batch.mode === "production_api" ? "真实初审" : "模拟初审"} />
                </dl>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function CurrentBatchPanel({ batch, message, reviewLines }: { batch: BatchSummary | null; message: string; reviewLines: ReviewLineDto[] }) {
  const detail = useMemo(() => buildBatchDetail(reviewLines), [reviewLines]);

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{batch ? batch.fileName : "尚未选择批次"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
        </div>
        {batch ? <Badge tone={batchStatusTone(batch.status)}>{batchStatusText(batch)}</Badge> : null}
      </div>
      {batch ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <MetaItem label="订单行数" value={`${batch.orderLineCount}`} />
          <MetaItem label="匹配条码" value={`${batch.matchedBarcodeCount}/${batch.uniqueBarcodeCount}`} />
          <MetaItem label="上传时间" value={formatShortDate(batch.createdAt)} />
          <MetaItem label="更新时间" value={formatShortDate(batch.updatedAt)} />
          <MetaItem label="订单时间跨度" value={detail.orderTimeRange} />
          <MetaItem label="门店 / 订单" value={`${detail.storeCount} 个门店 / ${detail.orderCount} 个订单`} />
          <MetaItem label="计算库存快照" value={batch.stockSnapshotAt ? formatShortDate(batch.stockSnapshotAt) : "未使用可验证快照"} />
        </dl>
      ) : null}
    </section>
  );
}

function HelpPanel({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-4 text-blue-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5" />
            <h2 className="text-base font-semibold">按三个步骤处理订单</h2>
          </div>
          <div className="mt-2 grid gap-2 text-sm md:grid-cols-3">
            <div>1. 导入订单：选择订货单，系统读取商品和库存。</div>
            <div>2. 审核发货：确认每行发货数量，异常商品单独处理。</div>
            <div>3. 做单：审核完成后生成给仓库或系统使用的 Excel。</div>
          </div>
        </div>
        <Button className="h-8 bg-white px-2 text-blue-950 hover:bg-blue-100" onClick={onDismiss}>
          知道了
        </Button>
      </div>
    </section>
  );
}

function SettingsPanel({
  canSyncGoods,
  canManageSettings,
  goodsSyncError,
  goodsSyncing,
  goodsSyncMessage,
  goodsSyncRun,
  combinedSyncRun,
  developerMode,
  warehouseSettings,
  warehouseSettingsDraft,
  warehouseSettingsMessage,
  wdtSyncSettings,
  wdtSyncSettingsMessage,
  onClose,
  onRunGoodsSync,
  onSaveWarehouseSettings,
  onWdtSyncIntervalChange,
  onWarehouseSettingsDraftChange,
}: {
  canSyncGoods: boolean;
  canManageSettings: boolean;
  goodsSyncError: string;
  goodsSyncing: boolean;
  goodsSyncMessage: string;
  goodsSyncRun: WdtGoodsSyncRunDto | null;
  combinedSyncRun: WdtSyncRunDto | null;
  developerMode: boolean;
  warehouseSettings: WarehouseUsageSettingsDto | null;
  warehouseSettingsDraft: WarehouseUsageSettingsDto | null;
  warehouseSettingsMessage: string;
  wdtSyncSettings: WdtSyncSettingsDto | null;
  wdtSyncSettingsMessage: string;
  onClose: () => void;
  onRunGoodsSync: () => void;
  onSaveWarehouseSettings: () => void;
  onWdtSyncIntervalChange: (intervalHours: WdtAutoSyncIntervalHours) => void;
  onWarehouseSettingsDraftChange: (settings: WarehouseUsageSettingsDto) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6" role="dialog" aria-modal="true" aria-label="设置">
      <section className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-md border border-border bg-card p-5 shadow-xl">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" />
              <h2 className="text-base font-semibold">设置</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">调整会影响之后重新运行的初审结果。</p>
          </div>
          <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={onClose}>
            <X className="h-4 w-4" />
            关闭
          </Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <WarehouseUsageSettingsPanel
            canManageSettings={canManageSettings}
            draft={warehouseSettingsDraft}
            message={warehouseSettingsMessage}
            settings={warehouseSettings}
            onDraftChange={onWarehouseSettingsDraftChange}
            onSave={onSaveWarehouseSettings}
          />
          <GoodsSyncStatusPanel
            canSyncGoods={canSyncGoods}
            canManageSettings={canManageSettings}
            error={goodsSyncError}
            message={goodsSyncMessage}
            run={goodsSyncRun}
            combinedRun={combinedSyncRun}
            developerMode={developerMode}
            syncing={goodsSyncing}
            syncSettings={wdtSyncSettings}
            syncSettingsMessage={wdtSyncSettingsMessage}
            onRunSync={onRunGoodsSync}
            onSyncIntervalChange={onWdtSyncIntervalChange}
          />
        </div>
      </section>
    </div>
  );
}

function AddressTab({
  canEdit,
  focusMissingStore,
  focusMissingStoreRequestId,
  missingStores,
  onMessage,
  onSaved,
}: {
  canEdit: boolean;
  focusMissingStore: MakeOrderReadinessDto["missingStores"][number] | null;
  focusMissingStoreRequestId: number;
  missingStores: MakeOrderReadinessDto["missingStores"];
  onMessage: (message: string) => void;
  onSaved: () => void;
}) {
  return (
    <section className="mt-4">
      <StoreAddressPanel
        canEdit={canEdit}
        focusMissingStore={focusMissingStore}
        focusMissingStoreRequestId={focusMissingStoreRequestId}
        missingStores={missingStores}
        onMessage={onMessage}
        onSaved={onSaved}
      />
    </section>
  );
}

function ExternalProductTab({
  canEdit,
  onMessage,
}: {
  canEdit: boolean;
  onMessage: (message: string) => void;
}) {
  return (
    <section className="mt-4">
      <ExternalProductPanel canEdit={canEdit} onMessage={onMessage} />
    </section>
  );
}

function ImportTab({
  goodsSyncError,
  goodsSyncRun,
  isDeveloperMode,
  mockFile,
  orderFile,
  selectedOrderFileName,
  canImport,
  onOrderFileSelect,
  onMockFileChange,
  onOrderFileChange,
  onRunDemo,
  onRunConfirmed,
  onRunReal,
}: {
  goodsSyncError: string;
  goodsSyncRun: WdtGoodsSyncRunDto | null;
  isDeveloperMode: boolean;
  mockFile: string;
  orderFile: string;
  selectedOrderFileName: string;
  canImport: boolean;
  onOrderFileSelect: (file: File) => void;
  onMockFileChange: (value: string) => void;
  onOrderFileChange: (value: string) => void;
  onRunDemo: () => void;
  onRunConfirmed: () => void;
  onRunReal: () => void;
}) {
  const canRunReal = canImport && goodsSyncRun?.status === "success" && (isDeveloperMode || Boolean(selectedOrderFileName));
  const canRunConfirmed = canImport && Boolean(selectedOrderFileName);
  const realImportHint = !canImport
    ? "当前账号不能导入订单"
    : goodsSyncRun?.status !== "success"
      ? "商品档案可用后才能导入新订单"
      : !selectedOrderFileName && !isDeveloperMode
        ? "请先选择订货单 Excel 文件"
        : "导入原始订货单，系统会先生成初审结果";
  const confirmedImportHint = !canImport
    ? "当前账号不能导入订单"
    : !selectedOrderFileName
      ? "请先选择确定单 Excel 文件"
      : "导入上游确定单，生成建议后进入审核";

  return (
    <section className="mt-4">
      <div className="rounded-md border border-border bg-card p-4">
        <div className="mb-4 flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">导入订单</h2>
        </div>
        <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-5">
          <div className="text-sm font-medium">选择订货单文件</div>
          <div className="mt-1 text-sm text-muted-foreground">{selectedOrderFileName || "请选择 .xls 或 .xlsx 文件"}</div>
          <label className="mt-4 inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90">
            <Upload className="h-4 w-4" />
            选择文件
            <input
              className="sr-only"
              type="file"
              accept=".xls,.xlsx"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onOrderFileSelect(file);
                event.target.value = "";
              }}
            />
          </label>
        </div>
        {isDeveloperMode ? (
          <>
            <label className="mt-3 block text-sm text-muted-foreground">订货单路径</label>
            <input
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={orderFile}
              onChange={(event) => onOrderFileChange(event.target.value)}
            />
            <label className="mt-3 block text-sm text-muted-foreground">演示数据文件</label>
            <input
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={mockFile}
              onChange={(event) => onMockFileChange(event.target.value)}
            />
          </>
        ) : null}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <span className="block" title={realImportHint}>
            <Button aria-label="导入新订单" className="h-auto min-h-12 w-full justify-start px-4 py-3 text-left" disabled={!canRunReal} onClick={onRunReal}>
              <FileSpreadsheet className="h-4 w-4 shrink-0" />
              <span className="grid gap-0.5">
                <span>导入新订单</span>
                <span className="text-xs font-normal text-primary-foreground/85">导入后先审核，再生成做单文件</span>
              </span>
            </Button>
          </span>
          <span className="block" title={confirmedImportHint}>
            <Button
              aria-label="导入确定单"
              className="h-auto min-h-12 w-full justify-start border border-primary/30 bg-card px-4 py-3 text-left text-primary shadow-sm hover:border-primary/50 hover:bg-teal-50 disabled:bg-muted disabled:text-muted-foreground"
              disabled={!canRunConfirmed}
              onClick={onRunConfirmed}
            >
              <PackageCheck className="h-4 w-4 shrink-0" />
              <span className="grid gap-0.5">
                <span>导入确定单</span>
                <span className="text-xs font-normal text-current opacity-75">按库存快照生成建议，确认后再做单</span>
              </span>
            </Button>
          </span>
          {isDeveloperMode ? (
            <Button className="bg-muted text-muted-foreground hover:bg-muted/80 md:col-span-2" onClick={onRunDemo}>
              <RefreshCcw className="h-4 w-4" />
              生成演示批次
            </Button>
          ) : null}
        </div>
        {!canImport ? (
          <PermissionHint message="当前账号不能导入订单，请联系管理员或切换到运营账号。" />
        ) : goodsSyncRun?.status !== "success" ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            本地商品档案可用后才能导入新订单；确定单可先导入，但商品匹配依赖已有商品档案和人工映射。库存建议统一读取本地快照。
          </div>
        ) : !selectedOrderFileName && !isDeveloperMode ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            请先选择订货单文件，再开始导入。
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReviewTab({
  activeBatch,
  activeFilter,
  draftById,
  errorsById,
  filteredLines,
  isDeveloperMode,
  savingDecisionIds,
  submittingReview,
  warehouseSettings,
  canRecheckConfirmedOrder,
  canReview,
  recheckingConfirmedOrder,
  stats,
  pendingMappingSummary,
  onBulkApprove,
  onDraftChange,
  onFilterChange,
  onLocateMapping,
  onOpenMappingLibrary,
  onPriorityChange,
  onQuickDecision,
  onRecheckConfirmedOrder,
  onSave,
  onSubmitReview,
}: {
  activeBatch: BatchSummary | null;
  activeFilter: FilterKey;
  draftById: Record<string, ReviewDraft>;
  errorsById: Record<string, string>;
  filteredLines: ReviewLineDto[];
  isDeveloperMode: boolean;
  savingDecisionIds: Set<string>;
  submittingReview: boolean;
  warehouseSettings: WarehouseUsageSettingsDto | null;
  canRecheckConfirmedOrder: boolean;
  canReview: boolean;
  recheckingConfirmedOrder: boolean;
  stats: ReturnType<typeof buildStats>;
  pendingMappingSummary: { groupCount: number; rowCount: number };
  onBulkApprove: () => void;
  onDraftChange: (lineId: string, patch: Partial<ReviewDraft>) => void;
  onFilterChange: (filter: FilterKey) => void;
  onLocateMapping: (line: ReviewLineDto) => void;
  onOpenMappingLibrary: () => void;
  onPriorityChange: (line: ReviewLineDto, priority: boolean) => void;
  onQuickDecision: (line: ReviewLineDto, decision: ReviewDecision) => void;
  onRecheckConfirmedOrder: () => void;
  onSave: (line: ReviewLineDto) => void;
  onSubmitReview: () => void;
}) {
  const hasRows = filteredLines.length > 0;
  const confirmedOrderMode = activeBatch?.sourceType === "confirmed_order";

  return (
    <section className="mt-4 min-w-0 space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Stat label="明细行" value={stats.total} />
        <Stat label={confirmedOrderMode ? "待处理" : "待审核"} value={stats.pending} />
        <Stat label={confirmedOrderMode ? "做单" : "发货"} value={stats.ship} />
        <Stat label={confirmedOrderMode ? "不做单" : "不发货"} value={stats.doNotShip} />
        <Stat label="优先处理" value={stats.priority} />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label={confirmedOrderMode ? "可做单" : "已匹配"} value={stats.matched} />
        <Stat label={confirmedOrderMode ? "需选择商家编码" : "需确认"} value={stats.ambiguous} />
        <Stat label={confirmedOrderMode ? "缺商家编码" : "未找到"} value={stats.notFound} />
        <Stat label={confirmedOrderMode ? "校验异常" : "库存异常"} value={confirmedOrderMode ? stats.apiError : stats.inventoryException} />
      </div>
      <section className="rounded-md border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{confirmedOrderMode ? "确定单校验" : "审核发货"}</h2>
            <p className="text-sm text-muted-foreground">
              {activeBatch ? (confirmedOrderMode ? "核对确定单做单字段和商品提醒" : "确认本批次发货数量和原因") : "请先选择或导入批次"}
            </p>
          </div>
          {confirmedOrderMode ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button className="bg-muted text-muted-foreground hover:bg-muted/80" disabled={!activeBatch} onClick={onOpenMappingLibrary}>
                <PackageSearch className="h-4 w-4" />
                长期映射库
              </Button>
              <Button disabled={!activeBatch || !canRecheckConfirmedOrder || recheckingConfirmedOrder} onClick={onRecheckConfirmedOrder}>
                <RefreshCcw className={recheckingConfirmedOrder ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                {recheckingConfirmedOrder ? "校验中..." : "重新校验确定单"}
              </Button>
              <Button disabled={!activeBatch || !canReview || recheckingConfirmedOrder || submittingReview || savingDecisionIds.size > 0} onClick={onSubmitReview}>
                <Send className="h-4 w-4" />
                {submittingReview ? "提交中..." : "提交审核完成"}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button className="bg-muted text-muted-foreground hover:bg-muted/80" disabled={!activeBatch} onClick={onOpenMappingLibrary}>
                <PackageSearch className="h-4 w-4" />
                长期映射库
              </Button>
              <Button disabled={!activeBatch || !canReview} onClick={onBulkApprove}>
                <CheckCheck className="h-4 w-4" />
                批量通过可发项
              </Button>
              <Button disabled={!activeBatch || !canReview} onClick={onSubmitReview}>
                <Send className="h-4 w-4" />
                提交审核完成
              </Button>
            </div>
          )}
        </div>
        {confirmedOrderMode && !canRecheckConfirmedOrder ? (
          <PermissionHint className="mb-3" message="当前账号不能重新校验确定单，请联系管理员或切换到运营账号。" />
        ) : null}
        {confirmedOrderMode && !canReview ? (
          <PermissionHint className="mb-3" message="当前账号不能提交确定单审核，请联系管理员或切换到审核账号。" />
        ) : !confirmedOrderMode && !canReview ? (
          <PermissionHint className="mb-3" message="当前账号不能审核发货，请联系管理员或切换到审核账号。" />
        ) : null}
        {activeBatch ? (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {(confirmedOrderMode ? confirmedOrderFilters : orderFilters).map((filter) => (
                <button
                  key={filter.key}
                  className={
                    filter.key === activeFilter
                      ? "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                      : "rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
                  }
                  data-testid={`review-filter-${filter.key}`}
                  onClick={() => onFilterChange(filter.key)}
                >
                  <span className="block">{filter.label}</span>
                  {confirmedOrderMode && filter.key === "unmatched" ? (
                    <span className={filter.key === activeFilter ? "mt-0.5 block text-xs text-primary-foreground/80" : "mt-0.5 block text-xs text-muted-foreground"}>
                      {pendingMappingSummary.groupCount} 种 / {pendingMappingSummary.rowCount} 条
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            {hasRows ? (
              <ReviewTable
                draftById={draftById}
                errorsById={errorsById}
                rows={filteredLines}
                readOnly={!canReview}
                savingDecisionIds={savingDecisionIds}
                warehouseSettings={warehouseSettings}
                onDraftChange={onDraftChange}
                onLocateMapping={onLocateMapping}
                onPriorityChange={onPriorityChange}
                onQuickDecision={onQuickDecision}
                onSave={onSave}
                confirmedOrderMode={confirmedOrderMode}
                isDeveloperMode={isDeveloperMode}
                groupPendingMappings={confirmedOrderMode && activeFilter === "unmatched"}
              />
            ) : (
              <EmptyState title="当前筛选没有明细" description="切换筛选条件，或检查本批次是否已经生成初审明细。" />
            )}
          </>
        ) : (
          <EmptyState title="先选择一个批次" description="从左侧历史批次选择订单，或回到导入订单创建新批次。" />
        )}
      </section>
      {isDeveloperMode ? (
        <div className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
          开发者模式已开启：商品映射现在通过“长期映射库”或明细行按钮打开。
        </div>
      ) : null}
    </section>
  );
}

function missingStoreKey(store: MakeOrderReadinessDto["missingStores"][number]) {
  return `${store.storeNo || ""}|${store.storeName || ""}`;
}

function ExportTab({
  activeBatch,
  canExport,
  exports,
  makeOrderReadiness,
  onCorrectStoreFields,
  onCreateExport,
}: {
  activeBatch: BatchSummary | null;
  canExport: boolean;
  exports: ExportDto[];
  makeOrderReadiness: MakeOrderReadinessDto | null;
  onCorrectStoreFields: (store: MakeOrderReadinessDto["missingStores"][number], next: { storeNo: string; storeName: string }) => Promise<void> | void;
  onCreateExport: (type: ExportDto["type"]) => void;
}) {
  const [editingStoreKey, setEditingStoreKey] = useState("");
  const [storeFieldDraft, setStoreFieldDraft] = useState({ storeNo: "", storeName: "" });
  const [savingStoreFields, setSavingStoreFields] = useState(false);
  const batchReadyForExport = activeBatch?.status === "reviewed" || activeBatch?.status === "exported";
  const makeOrderReady = makeOrderReadiness?.canExport === true;
  const canCreateBasicExport = canExport && batchReadyForExport;
  const readinessBadgeTone = !makeOrderReadiness ? "neutral" : makeOrderReadiness.canExport ? "good" : "bad";
  const readinessBadgeText = !makeOrderReadiness
    ? "检查中"
    : makeOrderReadiness.canExport
      ? "可生成"
      : makeOrderReadiness.missingWarehouseCount > 0
        ? "需选仓库"
        : "需补地址";
  const exportActions: Array<{ type: ExportDto["type"]; title: string; description: string; disabledReason?: string }> = [
    { type: "review", title: "初审单", description: "导出当前批次的初审明细，便于内部复核。" },
    { type: "confirmed", title: "确定发货单", description: "导出最终确认的发货数量和处理结果。" },
    {
      type: "wdt_import",
      title: "做单表格",
      description: "按批量导入模板生成做单表，并附带同格式的不做单核对表。",
      disabledReason: makeOrderReady
        ? undefined
        : makeOrderReadiness && makeOrderReadiness.missingWarehouseCount > 0
          ? "需先为所有发货明细选择仓库"
          : "需先补齐发货地址",
    },
  ];

  function editStoreFields(store: MakeOrderReadinessDto["missingStores"][number]) {
    setEditingStoreKey(missingStoreKey(store));
    setStoreFieldDraft({ storeNo: store.storeNo, storeName: store.storeName });
  }

  async function saveStoreFields(store: MakeOrderReadinessDto["missingStores"][number]) {
    setSavingStoreFields(true);
    try {
      await onCorrectStoreFields(store, storeFieldDraft);
      setEditingStoreKey("");
    } finally {
      setSavingStoreFields(false);
    }
  }

  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">做单</h2>
          <p className="text-sm text-muted-foreground">{activeBatch ? "生成并下载当前批次的 Excel 文件" : "选择批次后可生成 Excel"}</p>
        </div>
      </div>
      {!canExport ? (
        <PermissionHint className="mt-4" message="当前账号不能生成做单文件，请联系管理员或切换到运营账号。" />
      ) : !activeBatch ? (
        <EmptyState className="mt-4" title="先选择一个批次" description="完成审核后，这里会生成初审单、确定发货单或做单 Excel。" />
      ) : !batchReadyForExport ? (
        <EmptyState className="mt-4" title="等待审核完成" description="当前批次还没有提交审核，确认发货数量后再生成做单文件。" />
      ) : null}
      {activeBatch && batchReadyForExport ? (
        <div
          className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))]"
          data-testid="export-actions"
        >
          {exportActions.map((action) => {
            const disabled = !canCreateBasicExport || (action.type === "wdt_import" && !makeOrderReady);
            return (
              <div key={action.type} className={action.type === "wdt_import" ? "min-w-0 rounded-md border border-primary/30 bg-emerald-50/40 p-3" : "min-w-0 rounded-md border border-border bg-background p-3"}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{action.title}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{action.description}</div>
                  </div>
                  {action.type === "wdt_import" ? <Badge tone={readinessBadgeTone}>{readinessBadgeText}</Badge> : null}
                </div>
                <Button className="mt-3 h-auto min-h-8 max-w-full whitespace-normal px-2 text-left" data-testid={`create-export-${action.type}`} disabled={disabled} onClick={() => onCreateExport(action.type)}>
                  <Download className="h-4 w-4" />
                  生成{action.title}
                </Button>
                {disabled && action.disabledReason ? <div className="mt-2 text-xs text-muted-foreground">{action.disabledReason}</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {activeBatch && batchReadyForExport ? (
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">做单预检查</div>
              <div className="mt-1 text-sm text-muted-foreground">
                可做单 {makeOrderReadiness?.shippableLineCount ?? "-"} 行 / 未选仓库 {makeOrderReadiness?.missingWarehouseCount ?? "-"} 行 / 缺地址 {makeOrderReadiness?.missingAddressCount ?? "-"} 个门店
              </div>
            </div>
            <Badge tone={readinessBadgeTone}>{readinessBadgeText}</Badge>
          </div>
          {makeOrderReadiness && makeOrderReadiness.missingWarehouseLines.length > 0 ? (
            <div className="mt-3 space-y-2">
              {makeOrderReadiness.missingWarehouseLines.slice(0, 5).map((line) => (
                <div key={line.reviewLineId} className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2 text-sm">
                  <span className="font-medium">{line.goodsName || line.orderNoticeNo}</span>
                  <span className="text-muted-foreground">{line.storeName || line.storeNo} · 未选择仓库</span>
                </div>
              ))}
              {makeOrderReadiness.missingWarehouseLines.length > 5 ? (
                <div className="text-sm text-muted-foreground">还有 {makeOrderReadiness.missingWarehouseLines.length - 5} 行未选择仓库</div>
              ) : null}
            </div>
          ) : null}
          {makeOrderReadiness && makeOrderReadiness.missingStores.length > 0 ? (
            <div className="mt-3 space-y-2">
              {makeOrderReadiness.missingStores.slice(0, 5).map((store) => (
                <div key={`${store.storeNo}-${store.storeName}`} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-medium">{store.storeName || store.storeNo}</span>
                      {store.storeNo ? <span className="ml-2 text-muted-foreground">{store.storeNo}</span> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">{store.shippableLineCount} 行待做单</span>
                      <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" disabled={!canExport} onClick={() => editStoreFields(store)}>
                        <MapPin className="h-4 w-4" />
                        修正本批字段
                      </Button>
                    </div>
                  </div>
                  {editingStoreKey === missingStoreKey(store) ? (
                    <div className="mt-3 grid gap-2 border-t border-border/70 pt-3 sm:grid-cols-[160px_minmax(220px,1fr)_auto]">
                      <input
                        aria-label="本批收货地编码"
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                        placeholder="收货地编码"
                        value={storeFieldDraft.storeNo}
                        onChange={(event) => setStoreFieldDraft((current) => ({ ...current, storeNo: event.target.value }))}
                      />
                      <input
                        aria-label="本批收货地名称"
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                        placeholder="收货地名称"
                        value={storeFieldDraft.storeName}
                        onChange={(event) => setStoreFieldDraft((current) => ({ ...current, storeName: event.target.value }))}
                      />
                      <div className="flex items-center gap-2">
                        <Button className="h-9 px-3" disabled={!canExport || !storeFieldDraft.storeName.trim() || savingStoreFields} onClick={() => void saveStoreFields(store)}>
                          <Save className="h-4 w-4" />
                          保存
                        </Button>
                        <Button className="h-9 bg-muted px-3 text-muted-foreground hover:bg-muted/80" disabled={savingStoreFields} onClick={() => setEditingStoreKey("")}>
                          取消
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
              {makeOrderReadiness.missingStores.length > 5 ? (
                <div className="text-sm text-muted-foreground">还有 {makeOrderReadiness.missingStores.length - 5} 个缺地址门店</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-4 space-y-2">
        {exports.length === 0 && canCreateBasicExport ? (
          <div className="text-sm text-muted-foreground">暂无导出记录</div>
        ) : (
          exports.map((item) => (
            <div
              key={item.id}
              className={
                item.status === "failed"
                  ? "flex flex-wrap items-start justify-between gap-3 rounded-md border border-rose-200 bg-rose-50/40 px-3 py-2 text-sm"
                  : "flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
              }
            >
              <div className="min-w-0">
                <div data-testid={`export-type-${item.id}`} className="font-semibold">
                  {exportTypeText(item.type)}
                </div>
                <div data-testid={`export-file-${item.id}`} className="mt-1 break-all text-muted-foreground">
                  {item.fileName} / {item.createdByUsername ?? "系统"} / {formatShortDate(item.createdAt)}
                </div>
                {item.errorMessage ? (
                  <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-rose-800">
                    失败原因：{item.errorMessage}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={item.status === "ready" ? "good" : item.status === "failed" ? "bad" : "neutral"}>{exportStatusText(item.status)}</Badge>
                {item.downloadUrl ? (
                  <a
                    className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
                    href={item.downloadUrl}
                  >
                    下载
                  </a>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function EmptyState({ className = "", description, title }: { className?: string; description: string; title: string }) {
  return (
    <div className={`rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center ${className}`}>
      <div className="text-sm font-medium">{title}</div>
      <div className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

function PermissionHint({ className = "", message }: { className?: string; message: string }) {
  return <div className={`rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 ${className}`}>{message}</div>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{value}</div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function GoodsSyncHeaderStatus({ error, run, settings }: { error: string; run: WdtSyncRunDto | null; settings: WdtSyncSettingsDto | null }) {
  const status = run?.status ?? "none";
  const intervalHours = settings?.intervalHours ?? 1;
  const stale = run?.activeSnapshotAt ? Date.now() - Date.parse(run.activeSnapshotAt) > intervalHours * 60 * 60 * 1000 : false;
  const snapshotText = run?.activeSnapshotAt ? formatShortDate(run.activeSnapshotAt) : error || "尚无成功库存快照";
  const snapshotTone = run?.activeSnapshotAt ? (stale ? "warn" : "good") : "warn";
  return (
    <div className="flex min-w-0 flex-1 justify-center max-lg:order-last max-lg:basis-full">
      <div className="flex max-w-full flex-wrap items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
        <span className="font-medium">库存快照</span>
        <Badge tone={snapshotTone}>{run?.activeSnapshotAt ? (stale ? "建议刷新" : "可用") : "未建立"}</Badge>
        {status === "queued" || status === "running" ? <Badge tone="info">更新中</Badge> : null}
        {status === "failed" ? <Badge tone="bad">最近同步失败</Badge> : null}
        {(run?.activeSnapshotMissingWarehouseTypes?.length ?? 0) > 0 ? <Badge tone="warn">仓库范围待同步</Badge> : null}
        <span className="min-w-0 truncate text-muted-foreground">{snapshotText}</span>
        {run?.activeSnapshotAt ? <span className="text-xs text-muted-foreground">来源：{syncTriggerText(run.activeSnapshotTrigger)}</span> : null}
        {stale ? <Badge tone="warn">超过同步周期</Badge> : null}
      </div>
    </div>
  );
}

function GoodsSyncStatusPanel({
  canSyncGoods,
  canManageSettings,
  error,
  message,
  run,
  combinedRun,
  developerMode,
  syncing,
  syncSettings,
  syncSettingsMessage,
  onRunSync,
  onSyncIntervalChange,
}: {
  canSyncGoods: boolean;
  canManageSettings: boolean;
  error: string;
  message: string;
  run: WdtGoodsSyncRunDto | null;
  combinedRun: WdtSyncRunDto | null;
  developerMode: boolean;
  syncing: boolean;
  syncSettings: WdtSyncSettingsDto | null;
  syncSettingsMessage: string;
  onRunSync: () => void;
  onSyncIntervalChange: (intervalHours: WdtAutoSyncIntervalHours) => void;
}) {
  const status = combinedRun?.status ?? "none";
  const total = combinedRun?.totalSpecCount ?? 0;
  const processed = combinedRun?.processedSpecCount ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const intervalHours = syncSettings?.intervalHours ?? 1;
  const stale = combinedRun?.activeSnapshotAt ? Date.now() - Date.parse(combinedRun.activeSnapshotAt) > intervalHours * 60 * 60 * 1000 : false;
  const missingWarehouseTypes = combinedRun?.activeSnapshotMissingWarehouseTypes ?? [];
  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">商品与库存同步</h3>
            <Badge tone={status === "success" ? "good" : status === "failed" ? "bad" : "warn"}>{userSyncStatusText(status)}</Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            当前库存快照：{combinedRun?.activeSnapshotAt ? formatShortDate(combinedRun.activeSnapshotAt) : "尚无成功快照"}
            {combinedRun?.activeSnapshotAt ? ` · 来源：${syncTriggerText(combinedRun.activeSnapshotTrigger)}` : ""}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <label className="font-medium" htmlFor="wdt-sync-interval">自动同步</label>
            <select
              id="wdt-sync-interval"
              className="h-8 rounded-md border border-border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!canManageSettings || !syncSettings}
              value={intervalHours}
              onChange={(event) => onSyncIntervalChange(Number(event.target.value) as WdtAutoSyncIntervalHours)}
            >
              <option value={1}>每 1 小时</option>
              <option value={2}>每 2 小时</option>
              <option value={6}>每 6 小时</option>
              <option value={24}>每 24 小时</option>
            </select>
            <span className="text-xs text-muted-foreground">按上海时间自然整点执行</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">导入、审核和商品查询均使用这份本地快照，不会临时等待旺店通。</p>
          {syncSettings && !syncSettings.autoSyncEnabled ? <p className="mt-1 text-xs text-amber-800">自动同步已被运维配置关闭，手动立即同步仍可使用。</p> : null}
          {missingWarehouseTypes.length > 0 ? (
            <p className="mt-1 text-xs text-amber-800">
              当前快照未覆盖已启用的{missingWarehouseTypes.map(snapshotWarehouseTypeText).join("、")}，这些仓库不会被当作零库存；请手动同步后再重新校验。
            </p>
          ) : null}
          {stale ? <p className="mt-1 text-xs text-amber-800">库存快照已超过当前同步周期，系统仍可使用，建议手动刷新。</p> : null}
          {syncSettingsMessage ? <p className="mt-1 text-xs text-muted-foreground">{syncSettingsMessage}</p> : null}
          {syncing ? (
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              <div>阶段：{syncStageText(combinedRun?.stage)} · SKU {processed}/{total || "-"} · 批次 {combinedRun?.completedBatchCount ?? 0}/{combinedRun?.totalBatchCount ?? "-"}</div>
              <div className="h-2 overflow-hidden rounded bg-muted" aria-label={`同步进度 ${percent}%`}>
                <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : null}
          {combinedRun?.status === "failed" ? (
            <p className="mt-1 text-xs text-rose-700">
              {combinedRun.errorMessage || "本次同步失败"}，{combinedRun.activeSnapshotAt ? `仍使用 ${formatShortDate(combinedRun.activeSnapshotAt)} 的成功快照。` : "当前尚无可用库存快照。"}
            </p>
          ) : null}
          {!combinedRun && error ? <p className="mt-1 text-xs text-amber-800">{error}；业务仍可继续，库存建议会标记为未验证。</p> : null}
          {run?.status === "success" && run.finishedAt ? <p className="mt-1 text-xs text-muted-foreground">商品档案更新完成：{formatShortDate(run.finishedAt)}</p> : null}
          {developerMode && combinedRun?.errorDetail ? <p className="mt-1 break-all text-xs text-muted-foreground">同步详情：{combinedRun.errorCode} {combinedRun.errorDetail}</p> : null}
          {message ? <p className="mt-1 text-sm text-muted-foreground">{message}</p> : null}
          {!canSyncGoods ? <p className="mt-1 text-xs text-amber-700">当前账号只能查看同步状态，请联系管理员或运营账号处理。</p> : null}
        </div>
        <Button className="h-8 px-2" disabled={!canSyncGoods || syncing} onClick={onRunSync}>
          <RefreshCcw className="h-4 w-4" />
          {syncing ? "同步中" : "立即同步"}
        </Button>
      </div>
    </section>
  );
}

function WarehouseUsageSettingsPanel({
  canManageSettings,
  draft,
  message,
  settings,
  onDraftChange,
  onSave,
}: {
  canManageSettings: boolean;
  draft: WarehouseUsageSettingsDto | null;
  message: string;
  settings: WarehouseUsageSettingsDto | null;
  onDraftChange: (settings: WarehouseUsageSettingsDto) => void;
  onSave: () => void;
}) {
  const current = draft ?? settings;
  const changed = Boolean(
    current
      && settings
      && (current.includeMainWarehouse !== settings.includeMainWarehouse
        || current.includeNearExpiryWarehouse !== settings.includeNearExpiryWarehouse
        || current.includeDefectWarehouse !== settings.includeDefectWarehouse
        || current.includeOtherWarehouses !== settings.includeOtherWarehouses),
  );

  function update(patch: Partial<WarehouseUsageSettingsDto>) {
    if (!current || !canManageSettings) return;
    onDraftChange({ ...current, ...patch });
  }

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Warehouse className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">可用仓库范围</h3>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            上次更新：{settings ? formatShortDate(settings.updatedAt) : "正在读取"}
          </p>
        </div>
        <Button className="h-8 px-2" disabled={!canManageSettings || !changed} onClick={onSave}>
          <Save className="h-4 w-4" />
          保存
        </Button>
      </div>
      <div className="mt-4 grid gap-2">
        <WarehouseToggle
          checked={Boolean(current?.includeMainWarehouse)}
          disabled={!canManageSettings || !current}
          label="主仓"
          onChange={(checked) => update({ includeMainWarehouse: checked })}
        />
        <WarehouseToggle
          checked={Boolean(current?.includeNearExpiryWarehouse)}
          disabled={!canManageSettings || !current}
          label="临期仓"
          onChange={(checked) => update({ includeNearExpiryWarehouse: checked })}
        />
        <WarehouseToggle
          checked={Boolean(current?.includeDefectWarehouse)}
          disabled={!canManageSettings || !current}
          label="次品仓"
          onChange={(checked) => update({ includeDefectWarehouse: checked })}
        />
        <WarehouseToggle
          checked={Boolean(current?.includeOtherWarehouses)}
          disabled={!canManageSettings || !current}
          label="其他仓"
          onChange={(checked) => update({ includeOtherWarehouses: checked })}
        />
      </div>
      {message ? <div className="mt-3 text-sm text-muted-foreground">{message}</div> : null}
      {!canManageSettings ? <PermissionHint className="mt-3" message="当前账号只能查看仓库范围，请联系管理员调整。" /> : null}
    </section>
  );
}

function WarehouseToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
      <span className="font-medium">{label}</span>
      <input
        aria-label={label}
        className="h-4 w-4"
        checked={checked}
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function toDraft(line: ReviewLineDto): ReviewDraft {
  return {
    decision: line.decision,
    approvedShipQty: String(line.approvedShipQty),
    fulfillmentWarehouseNo: line.fulfillmentWarehouseNo || (line.decision === "do_not_ship" ? "" : line.suggestedWarehouseNo),
    fulfillmentWarehouseName: line.fulfillmentWarehouseName || (line.decision === "do_not_ship" ? "" : line.suggestedWarehouseName),
    reason: line.reason,
  };
}

function reviewDraftIsDirty(line: ReviewLineDto, draft?: ReviewDraft) {
  if (!draft) return false;
  const persistedWarehouseNo = line.fulfillmentWarehouseNo || (line.decision === "do_not_ship" ? "" : line.suggestedWarehouseNo);
  const persistedWarehouseName = line.fulfillmentWarehouseName || (line.decision === "do_not_ship" ? "" : line.suggestedWarehouseName);
  return draft.decision !== line.decision
    || draft.approvedShipQty !== String(line.approvedShipQty)
    || draft.fulfillmentWarehouseNo !== persistedWarehouseNo
    || draft.fulfillmentWarehouseName !== persistedWarehouseName
    || draft.reason !== line.reason;
}

function buildDrafts(lines: ReviewLineDto[]): Record<string, ReviewDraft> {
  return Object.fromEntries(lines.map((line) => [line.id, toDraft(line)]));
}

function buildStats(lines: ReviewLineDto[]) {
  return {
    total: lines.length,
    matched: lines.filter((line) => line.matchStatus === "matched").length,
    ambiguous: lines.filter((line) => line.matchStatus === "ambiguous").length,
    notFound: lines.filter((line) => line.matchStatus === "not_found").length,
    apiError: lines.filter((line) => line.matchStatus === "api_error").length,
    inventoryException: lines.filter(
      (line) => line.matchStatus === "api_error" || line.status === "库存不足" || line.status === "库存未验证",
    ).length,
    pending: lines.filter((line) => line.decision === "pending").length,
    ship: lines.filter((line) => line.decision === "ship").length,
    doNotShip: lines.filter((line) => line.decision === "do_not_ship").length,
    priority: lines.filter((line) => line.priority).length,
    overSuggested: lines.filter((line) => line.decision === "ship" && line.approvedShipQty > line.suggestedShipQty).length,
  };
}

function sortReviewLines(lines: ReviewLineDto[]) {
  return [...lines].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority ? -1 : 1;
    return left.excelRow - right.excelRow;
  });
}

function buildBatchDetail(lines: ReviewLineDto[]) {
  if (lines.length === 0) {
    return { orderTimeRange: "-", storeCount: 0, orderCount: 0 };
  }
  const uploadTimes = lines.map((line) => line.uploadTime).filter(Boolean).sort();
  const firstTime = uploadTimes[0] ?? "-";
  const lastTime = uploadTimes.at(-1) ?? "-";
  return {
    orderTimeRange: firstTime === lastTime ? firstTime : `${firstTime} 至 ${lastTime}`,
    storeCount: new Set(lines.map((line) => line.storeNo || line.storeName).filter(Boolean)).size,
    orderCount: new Set(lines.map((line) => line.orderNoticeNo).filter(Boolean)).size,
  };
}

function buildUserPermissions(user: AuthUserDto | null) {
  const role = user?.role;
  return {
    canImport: role === "admin" || role === "operator",
    canReview: role === "admin" || role === "reviewer",
    canExport: role === "admin" || role === "operator",
    canSyncGoods: role === "admin" || role === "operator",
    canManageSettings: role === "admin",
    canDeleteBatch: role === "admin",
  };
}

function realReviewBlockedMessage(run: WdtGoodsSyncRunDto | null, error: string) {
  if (!run) return `真实初审已暂停：${error || "未读取到商品档案记录"}。请先完成商品与库存同步。`;
  if (run.status === "running") return "真实初审已暂停：商品档案仍在更新，请等待完成后刷新状态。";
  if (run.status === "failed") return "真实初审已暂停：最近一次商品档案更新失败，请先修复并重新同步。";
  return `真实初审已暂停：最近同步状态为 ${run.status}，不能作为正式审核依据。`;
}

function userSyncStatusText(status: WdtGoodsSyncRunDto["status"] | WdtSyncRunDto["status"] | "none") {
  if (status === "success") return "已更新";
  if (status === "failed") return "需刷新";
  if (status === "running" || status === "queued") return "更新中";
  return "未更新";
}

function syncStageText(stage: WdtSyncRunDto["stage"] | undefined) {
  if (stage === "goods") return "更新商品档案";
  if (stage === "prepare_stock") return "准备库存范围";
  if (stage === "stock") return "同步分仓库存";
  if (stage === "activate") return "激活库存快照";
  if (stage === "complete") return "已完成";
  return "等待执行";
}

function syncTriggerText(trigger: WdtSyncRunDto["activeSnapshotTrigger"] | undefined) {
  if (trigger === "manual") return "手动同步";
  if (trigger === "hourly") return "整点自动";
  if (trigger === "startup") return "启动补偿";
  return "-";
}

function snapshotWarehouseTypeText(type: NonNullable<WdtSyncRunDto["activeSnapshotMissingWarehouseTypes"]>[number]) {
  if (type === "main") return "主仓";
  if (type === "near_expiry") return "临期仓";
  if (type === "defect") return "次品仓";
  return "其他仓";
}

function batchStatusText(batch: BatchSummary) {
  const status = batch.status;
  if (batch.sourceType === "confirmed_order") {
    if (status === "uploaded") return "已导入";
    if (status === "matched") return "已匹配";
    if (status === "review_generated") return "待审核";
    if (status === "reviewed") return "已审核";
    if (status === "exported") return "已生成做单";
    return status;
  }
  if (status === "uploaded") return "已导入";
  if (status === "matched") return "已匹配";
  if (status === "inventory_synced") return "已查库存";
  if (status === "review_generated") return "待审核";
  if (status === "reviewed") return "已审核";
  if (status === "exported") return "已生成做单";
  return status;
}

function batchStatusTone(status: BatchSummary["status"]) {
  if (status === "reviewed" || status === "exported") return "good";
  if (status === "review_generated") return "info";
  if (status === "uploaded") return "warn";
  return "neutral";
}

function batchStatusCardClass(status: BatchSummary["status"]) {
  if (status === "exported") return "border-emerald-300 bg-emerald-50/70";
  if (status === "reviewed") return "border-teal-300 bg-teal-50/70";
  if (status === "review_generated") return "border-sky-300 bg-sky-50/70";
  if (status === "uploaded") return "border-amber-300 bg-amber-50/70";
  return "border-border bg-card";
}

function exportTypeText(type: ExportDto["type"]) {
  if (type === "confirmed") return "确定发货单";
  if (type === "wdt_import") return "做单 Excel";
  return "初审单";
}

function exportStatusText(status: ExportDto["status"]) {
  if (status === "ready") return "已生成";
  if (status === "failed") return "失败";
  return "生成中";
}

function formatShortDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBatchListDate(value: string) {
  if (!value) return { date: "-", time: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value, time: "" };
  return {
    date: date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).replaceAll("/", "-"),
    time: date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function matchesFilter(line: ReviewLineDto, filter: FilterKey, confirmedOrderMode = false) {
  if (filter === "all") return true;
  if (filter === "ready") return line.status === "库存充足" && (!confirmedOrderMode || line.plannedShipQty > 0);
  if (filter === "partial") return line.status === "部分满足";
  if (filter === "blocked") return line.status === "库存不足";
  if (filter === "unverified") return line.status === "库存未验证";
  if (filter === "unmatched") {
    return confirmedOrderMode
      ? line.matchStatus === "ambiguous" || line.matchStatus === "not_found"
      : line.status === "未匹配" || line.matchStatus !== "matched";
  }
  if (filter === "validation_error") return line.matchStatus === "api_error";
  if (filter === "pending") return line.decision === "pending";
  if (filter === "ship") return line.decision === "ship";
  if (filter === "do_not_ship") return line.decision === "do_not_ship";
  if (filter === "priority") return line.priority;
  if (filter === "manual_mapping") return isManualMappingLine(line);
  if (filter === "over_suggested") return line.decision === "ship" && line.approvedShipQty > line.suggestedShipQty;
  return true;
}

function pendingMappingGroupKey(line: ReviewLineDto) {
  const goodsCode = line.externalGoodsCode.trim();
  if (goodsCode) return `goods-code:${goodsCode}`;
  const barcode = line.externalBarcode.trim();
  if (barcode) return `barcode:${barcode}`;
  return `line:${line.id}`;
}

function summarizePendingMappingGroups(lines: ReviewLineDto[]) {
  const groups = new Set<string>();
  let rowCount = 0;
  for (const line of lines) {
    if (line.matchStatus !== "ambiguous" && line.matchStatus !== "not_found") continue;
    groups.add(pendingMappingGroupKey(line));
    rowCount += 1;
  }
  return { groupCount: groups.size, rowCount };
}

function isManualMappingLine(line: ReviewLineDto) {
  return isConfirmedProductMappingMatch(line.matchMessage);
}

function validateDraft(line: ReviewLineDto, draft: ReviewDraft, approvedShipQty: number) {
  if (draft.approvedShipQty.trim() === "" || !Number.isInteger(approvedShipQty) || approvedShipQty < 0) return "最终发货数量必须是非负整数";
  if (draft.decision === "ship" && approvedShipQty > 0 && (!draft.fulfillmentWarehouseNo || !draft.fulfillmentWarehouseName)) {
    return "请选择发货仓库";
  }
  return "";
}
