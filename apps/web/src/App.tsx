import { useEffect, useMemo, useState } from "react";
import { CheckCheck, ChevronDown, ChevronUp, ClipboardList, Download, FileSpreadsheet, HelpCircle, LogOut, MapPin, PackageCheck, PackageSearch, RefreshCcw, Save, Send, Settings, Trash2, Upload, Warehouse, X } from "lucide-react";
import type {
  AuthUserDto,
  BatchSummary,
  ExportDto,
  ImportConfirmedOrderResponse,
  MakeOrderReadinessDto,
  ProductMappingDto,
  ReviewDecision,
  ReviewLineDto,
  WarehouseUsageSettingsDto,
  WdtGoodsSyncRunDto,
} from "@jy-trade/shared";

import { ProductMappingPanel, type ProductMappingFocusProduct } from "./components/ProductMappingPanel.js";
import { ExternalProductPanel } from "./components/ExternalProductPanel.js";
import { ReviewTable, type ReviewDraft } from "./components/ReviewTable.js";
import { StoreAddressPanel } from "./components/StoreAddressPanel.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";

const defaultOrderFile = "outputs\\fixtures\\sample-order.xlsx";
const defaultMockFile = "examples/mock_flow_data.json";
const helpDismissedStorageKey = "jy-trade-help-dismissed-v1";

type WorkTab = "import" | "review" | "export" | "addresses" | "external-products";
type FilterKey =
  | "all"
  | "ready"
  | "partial"
  | "blocked"
  | "unmatched"
  | "pending"
  | "ship"
  | "do_not_ship"
  | "priority"
  | "over_suggested";

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "ready", label: "可发货" },
  { key: "partial", label: "部分满足" },
  { key: "blocked", label: "缺货" },
  { key: "unmatched", label: "商品异常" },
  { key: "pending", label: "待审核" },
  { key: "ship", label: "已发货" },
  { key: "do_not_ship", label: "不发货" },
  { key: "priority", label: "优先处理" },
  { key: "over_suggested", label: "超建议数" },
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
  const [loginPassword, setLoginPassword] = useState("jymy");
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
  const [savingReasonById, setSavingReasonById] = useState<Record<string, boolean>>({});
  const [goodsSyncRun, setGoodsSyncRun] = useState<WdtGoodsSyncRunDto | null>(null);
  const [goodsSyncError, setGoodsSyncError] = useState("正在读取商品同步状态");
  const [goodsSyncMessage, setGoodsSyncMessage] = useState("");
  const [goodsSyncing, setGoodsSyncing] = useState(false);
  const [warehouseSettings, setWarehouseSettings] = useState<WarehouseUsageSettingsDto | null>(null);
  const [warehouseSettingsDraft, setWarehouseSettingsDraft] = useState<WarehouseUsageSettingsDto | null>(null);
  const [warehouseSettingsMessage, setWarehouseSettingsMessage] = useState("");
  const [selectedOrderFileName, setSelectedOrderFileName] = useState("");
  const [pendingOrderUpload, setPendingOrderUpload] = useState<File | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [mappingFocusQuery, setMappingFocusQuery] = useState("");
  const [mappingFocusProduct, setMappingFocusProduct] = useState<ProductMappingFocusProduct | null>(null);
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
    const response = await fetch("/api/v1/wdt/goods-sync-runs/latest");
    if (response.status === 404) {
      setGoodsSyncRun(null);
      setGoodsSyncError("还没有可用的商品档案同步记录");
      return null;
    }
    if (!response.ok) {
      setGoodsSyncRun(null);
      setGoodsSyncError("商品档案同步状态读取失败");
      return null;
    }
    const run = (await response.json()) as WdtGoodsSyncRunDto;
    setGoodsSyncRun(run);
    setGoodsSyncError("");
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

  async function runGoodsSync() {
    setGoodsSyncing(true);
    setGoodsSyncMessage("正在同步商品档案...");
    const response = await fetch("/api/v1/wdt/goods-sync-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "incremental" }),
    });
    if (!response.ok) {
      const error = await response.json();
      setGoodsSyncMessage(error.message ?? "商品档案同步失败");
      setGoodsSyncing(false);
      return;
    }
    const run = (await response.json()) as WdtGoodsSyncRunDto;
    setGoodsSyncRun(run);
    setGoodsSyncError("");
    setGoodsSyncMessage(run.status === "success" ? "商品档案同步完成" : "商品档案同步已提交");
    setGoodsSyncing(false);
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
  }

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    setUser(null);
    setActiveBatch(null);
    setReviewLines([]);
    setExports([]);
    setMakeOrderReadiness(null);
    setGoodsSyncRun(null);
    setGoodsSyncError("正在读取商品同步状态");
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
    setActiveTab(result.unmatchedRowCount > 0 ? "review" : "export");
    const lines = await fetchReviewLines(result.batch.id);
    if (!lines) return;
    setReviewLines(sortReviewLines(lines));
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await refreshExports(result.batch.id);
    await refreshMakeOrderReadiness(result.batch.id);
    await refreshBatches();
    setMessage(`确定单已导入：${result.parsedRowCount} 行，已匹配 ${result.matchedRowCount} 行，异常 ${result.unmatchedRowCount} 行`);
    setSuccessNotice(result.unmatchedRowCount > 0 ? "确定单导入成功，请先处理商品异常" : "确定单导入成功，可以直接进入做单");
  }

  async function rerunActiveBatchAfterMapping(mapping: ProductMappingDto) {
    if (!activeBatch || activeBatch.mode !== "production_api") {
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
    await refreshExports(activeBatch.id);
    await refreshMakeOrderReadiness(activeBatch.id);
    await refreshBatches();
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

    const response = await fetch(`/api/v1/batches/${line.batchId}/review-lines/${line.id}/decision`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: draft.decision,
        approvedShipQty,
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
  }

  async function quickDecision(line: ReviewLineDto, decision: ReviewDecision) {
    const nextDraft: ReviewDraft =
      decision === "ship"
        ? { decision, approvedShipQty: String(line.suggestedShipQty), reason: draftById[line.id]?.reason ?? "" }
        : { decision, approvedShipQty: "0", reason: draftById[line.id]?.reason ?? "" };
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

  async function autoSaveReason(line: ReviewLineDto, reason: string) {
    const draft = { ...draftById[line.id], reason };
    setSavingReasonById((current) => ({ ...current, [line.id]: true }));
    await saveDecision(line, draft, { silent: true });
    setSavingReasonById((current) => {
      const next = { ...current };
      delete next[line.id];
      return next;
    });
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

  async function submitReview() {
    if (!activeBatch) return;
    const response = await fetch(`/api/v1/batches/${activeBatch.id}/actions/submit-review`, { method: "POST" });
    if (!response.ok) {
      setMessage("提交审核失败");
      return;
    }
    const result = await response.json();
    setActiveBatch(result.batch);
    await refreshMakeOrderReadiness(result.batch.id);
    await refreshBatches();
    setMessage(`审核已提交：待审核 ${result.pendingCount}，发货 ${result.shipCount}，不发 ${result.doNotShipCount}`);
    setSuccessNotice("审核完成，当前批次可以进入做单");
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
    setDeveloperMode(true);
    setMappingFocusQuery(query);
    setMappingFocusProduct({
      externalBarcode: line.externalBarcode,
      externalGoodsCode: line.externalGoodsCode,
      externalGoodsName: line.externalGoodsName,
    });
    setMessage("已定位到商品映射面板，保存长期映射后会自动刷新当前正式批次");
    window.setTimeout(() => document.getElementById("product-mapping-panel")?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
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
    if (!successNotice) return;
    const timer = window.setTimeout(() => setSuccessNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [successNotice]);

  const stats = useMemo(() => buildStats(reviewLines), [reviewLines]);
  const filteredLines = useMemo(() => reviewLines.filter((line) => matchesFilter(line, activeFilter)), [reviewLines, activeFilter]);
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
          <GoodsSyncHeaderStatus error={goodsSyncError} run={goodsSyncRun} />
          <div className="flex flex-wrap items-center gap-2">
            {activeBatch ? <Badge tone={batchStatusTone(activeBatch.status)}>{batchStatusText(activeBatch.status)}</Badge> : null}
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
            warehouseSettings={warehouseSettings}
            warehouseSettingsDraft={warehouseSettingsDraft}
            warehouseSettingsMessage={warehouseSettingsMessage}
            onClose={() => setShowSettings(false)}
            onRunGoodsSync={() => void runGoodsSync()}
            onSaveWarehouseSettings={() => void saveWarehouseSettings()}
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
                savingReasonById={savingReasonById}
                canReview={permissions.canReview}
                stats={stats}
                mappingFocusQuery={mappingFocusQuery}
                mappingFocusProduct={mappingFocusProduct}
                onBulkApprove={() => void bulkApprove()}
                onDraftChange={updateDraft}
                onFilterChange={setActiveFilter}
                onLocateMapping={locateProductMapping}
                onMappingConfirmed={rerunActiveBatchAfterMapping}
                onMessage={setMessage}
                onPriorityChange={togglePriority}
                onQuickDecision={quickDecision}
                onReasonSave={autoSaveReason}
                onSave={saveDecision}
                onSubmitReview={() => void submitReview()}
              />
            ) : null}

            {activeTab === "export" ? (
              <ExportTab
                activeBatch={activeBatch}
                canExport={permissions.canExport}
                exports={exports}
                makeOrderReadiness={makeOrderReadiness}
                onCreateExport={(type) => void createExport(type)}
                onOpenAddressTab={() => setActiveTab("addresses")}
              />
            ) : null}

            {activeTab === "addresses" ? (
              <AddressTab
                canEdit={permissions.canExport}
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
    </main>
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
                  <Badge tone={batchStatusTone(batch.status)}>{batchStatusText(batch.status)}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span>{batch.orderLineCount} 行</span>
                  <span>{batch.matchedBarcodeCount}/{batch.uniqueBarcodeCount} 已匹配</span>
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
        {batch ? <Badge tone={batchStatusTone(batch.status)}>{batchStatusText(batch.status)}</Badge> : null}
      </div>
      {batch ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <MetaItem label="订单行数" value={`${batch.orderLineCount}`} />
          <MetaItem label="匹配条码" value={`${batch.matchedBarcodeCount}/${batch.uniqueBarcodeCount}`} />
          <MetaItem label="上传时间" value={formatShortDate(batch.createdAt)} />
          <MetaItem label="更新时间" value={formatShortDate(batch.updatedAt)} />
          <MetaItem label="订单时间跨度" value={detail.orderTimeRange} />
          <MetaItem label="门店 / 订单" value={`${detail.storeCount} 个门店 / ${detail.orderCount} 个订单`} />
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
  warehouseSettings,
  warehouseSettingsDraft,
  warehouseSettingsMessage,
  onClose,
  onRunGoodsSync,
  onSaveWarehouseSettings,
  onWarehouseSettingsDraftChange,
}: {
  canSyncGoods: boolean;
  canManageSettings: boolean;
  goodsSyncError: string;
  goodsSyncing: boolean;
  goodsSyncMessage: string;
  goodsSyncRun: WdtGoodsSyncRunDto | null;
  warehouseSettings: WarehouseUsageSettingsDto | null;
  warehouseSettingsDraft: WarehouseUsageSettingsDto | null;
  warehouseSettingsMessage: string;
  onClose: () => void;
  onRunGoodsSync: () => void;
  onSaveWarehouseSettings: () => void;
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
            error={goodsSyncError}
            message={goodsSyncMessage}
            run={goodsSyncRun}
            syncing={goodsSyncing}
            onRunSync={onRunGoodsSync}
          />
        </div>
      </section>
    </div>
  );
}

function AddressTab({
  canEdit,
  missingStores,
  onMessage,
  onSaved,
}: {
  canEdit: boolean;
  missingStores: MakeOrderReadinessDto["missingStores"];
  onMessage: (message: string) => void;
  onSaved: () => void;
}) {
  return (
    <section className="mt-4">
      <StoreAddressPanel canEdit={canEdit} missingStores={missingStores} onMessage={onMessage} onSaved={onSaved} />
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled={!canRunReal} onClick={onRunReal}>
            <FileSpreadsheet className="h-4 w-4" />
            导入新订单
          </Button>
          <Button className="bg-muted text-muted-foreground hover:bg-muted/80" disabled={!canRunConfirmed} onClick={onRunConfirmed}>
            <PackageCheck className="h-4 w-4" />
            导入确定单
          </Button>
          {isDeveloperMode ? (
            <Button className="bg-muted text-muted-foreground hover:bg-muted/80" onClick={onRunDemo}>
              <RefreshCcw className="h-4 w-4" />
              生成演示批次
            </Button>
          ) : null}
        </div>
        {!canImport ? (
          <PermissionHint message="当前账号不能导入订单，请联系管理员或切换到运营账号。" />
        ) : goodsSyncRun?.status !== "success" ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            商品档案同步可用后才能导入新订单；确定单可先导入，但商品匹配依赖本地已有商品档案和人工映射。
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
  mappingFocusQuery,
  mappingFocusProduct,
  savingReasonById,
  canReview,
  stats,
  onBulkApprove,
  onDraftChange,
  onFilterChange,
  onLocateMapping,
  onMappingConfirmed,
  onMessage,
  onPriorityChange,
  onQuickDecision,
  onReasonSave,
  onSave,
  onSubmitReview,
}: {
  activeBatch: BatchSummary | null;
  activeFilter: FilterKey;
  draftById: Record<string, ReviewDraft>;
  errorsById: Record<string, string>;
  filteredLines: ReviewLineDto[];
  isDeveloperMode: boolean;
  mappingFocusQuery: string;
  mappingFocusProduct: ProductMappingFocusProduct | null;
  savingReasonById: Record<string, boolean>;
  canReview: boolean;
  stats: ReturnType<typeof buildStats>;
  onBulkApprove: () => void;
  onDraftChange: (lineId: string, patch: Partial<ReviewDraft>) => void;
  onFilterChange: (filter: FilterKey) => void;
  onLocateMapping: (line: ReviewLineDto) => void;
  onMappingConfirmed: (mapping: ProductMappingDto) => Promise<void> | void;
  onMessage: (message: string) => void;
  onPriorityChange: (line: ReviewLineDto, priority: boolean) => void;
  onQuickDecision: (line: ReviewLineDto, decision: ReviewDecision) => void;
  onReasonSave: (line: ReviewLineDto, reason: string) => void;
  onSave: (line: ReviewLineDto) => void;
  onSubmitReview: () => void;
}) {
  const hasRows = filteredLines.length > 0;

  return (
    <section className="mt-4 min-w-0 space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Stat label="明细行" value={stats.total} />
        <Stat label="待审核" value={stats.pending} />
        <Stat label="发货" value={stats.ship} />
        <Stat label="不发货" value={stats.doNotShip} />
        <Stat label="优先处理" value={stats.priority} />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="已匹配" value={stats.matched} />
        <Stat label="需确认" value={stats.ambiguous} />
        <Stat label="未找到" value={stats.notFound} />
        <Stat label="库存异常" value={stats.inventoryException} />
      </div>
      <section className="rounded-md border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">审核发货</h2>
            <p className="text-sm text-muted-foreground">{activeBatch ? "确认本批次发货数量和原因" : "请先选择或导入批次"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!activeBatch || !canReview} onClick={onBulkApprove}>
              <CheckCheck className="h-4 w-4" />
              批量通过可发项
            </Button>
            <Button disabled={!activeBatch || !canReview} onClick={onSubmitReview}>
              <Send className="h-4 w-4" />
              提交审核完成
            </Button>
          </div>
        </div>
        {!canReview ? <PermissionHint className="mb-3" message="当前账号不能审核发货，请联系管理员或切换到审核账号。" /> : null}
        {activeBatch ? (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {filters.map((filter) => (
                <button
                  key={filter.key}
                  className={
                    filter.key === activeFilter
                      ? "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                      : "rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
                  }
                  onClick={() => onFilterChange(filter.key)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            {hasRows ? (
              <ReviewTable
                draftById={draftById}
                errorsById={errorsById}
                savingReasonById={savingReasonById}
                rows={filteredLines}
                readOnly={!canReview}
                onDraftChange={onDraftChange}
                onLocateMapping={onLocateMapping}
                onPriorityChange={onPriorityChange}
                onQuickDecision={onQuickDecision}
                onReasonSave={onReasonSave}
                onSave={onSave}
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
        <ProductMappingPanel
          focusQuery={mappingFocusQuery}
          focusProduct={mappingFocusProduct}
          sourceBatchId={activeBatch?.id ?? ""}
          onMessage={onMessage}
          onConfirmed={onMappingConfirmed}
        />
      ) : null}
    </section>
  );
}

function ExportTab({
  activeBatch,
  canExport,
  exports,
  makeOrderReadiness,
  onCreateExport,
  onOpenAddressTab,
}: {
  activeBatch: BatchSummary | null;
  canExport: boolean;
  exports: ExportDto[];
  makeOrderReadiness: MakeOrderReadinessDto | null;
  onCreateExport: (type: ExportDto["type"]) => void;
  onOpenAddressTab: () => void;
}) {
  const batchReadyForExport = activeBatch?.status === "reviewed" || activeBatch?.status === "exported";
  const makeOrderReady = makeOrderReadiness?.canExport === true;
  const canCreateBasicExport = canExport && batchReadyForExport;
  const readinessBadgeTone = !makeOrderReadiness ? "neutral" : makeOrderReadiness.canExport ? "good" : "bad";
  const readinessBadgeText = !makeOrderReadiness ? "检查中" : makeOrderReadiness.canExport ? "可生成" : "需补地址";
  const exportActions: Array<{ type: ExportDto["type"]; title: string; description: string; disabledReason?: string }> = [
    { type: "review", title: "初审单", description: "导出当前批次的初审明细，便于内部复核。" },
    { type: "confirmed", title: "确定发货单", description: "导出最终确认的发货数量和处理结果。" },
    {
      type: "wdt_import",
      title: "做单表格",
      description: "按批量导入模板生成给系统导入的做单 Excel。",
      disabledReason: makeOrderReady ? undefined : "需先补齐发货地址",
    },
  ];

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
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {exportActions.map((action) => {
            const disabled = !canCreateBasicExport || (action.type === "wdt_import" && !makeOrderReady);
            return (
              <div key={action.type} className={action.type === "wdt_import" ? "rounded-md border border-primary/30 bg-emerald-50/40 p-3" : "rounded-md border border-border bg-background p-3"}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{action.title}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{action.description}</div>
                  </div>
                  {action.type === "wdt_import" ? <Badge tone={readinessBadgeTone}>{readinessBadgeText}</Badge> : null}
                </div>
                <Button className="mt-3 h-8 px-2" data-testid={`create-export-${action.type}`} disabled={disabled} onClick={() => onCreateExport(action.type)}>
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
                可做单 {makeOrderReadiness?.shippableLineCount ?? "-"} 行 / 缺地址 {makeOrderReadiness?.missingAddressCount ?? "-"} 个门店
              </div>
            </div>
            <Badge tone={readinessBadgeTone}>{readinessBadgeText}</Badge>
          </div>
          {makeOrderReadiness && makeOrderReadiness.missingStores.length > 0 ? (
            <div className="mt-3 space-y-2">
              {makeOrderReadiness.missingStores.slice(0, 5).map((store) => (
                <div key={`${store.storeNo}-${store.storeName}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
                  <div>
                    <span className="font-medium">{store.storeName || store.storeNo}</span>
                    {store.storeNo ? <span className="ml-2 text-muted-foreground">{store.storeNo}</span> : null}
                  </div>
                  <span className="text-muted-foreground">{store.shippableLineCount} 行待做单</span>
                </div>
              ))}
              {makeOrderReadiness.missingStores.length > 5 ? (
                <div className="text-sm text-muted-foreground">还有 {makeOrderReadiness.missingStores.length - 5} 个缺地址门店</div>
              ) : null}
              <Button className="h-8 px-2" onClick={onOpenAddressTab}>
                <MapPin className="h-4 w-4" />
                去地址维护
              </Button>
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

function GoodsSyncHeaderStatus({ error, run }: { error: string; run: WdtGoodsSyncRunDto | null }) {
  const status = run?.status ?? "none";
  return (
    <div className="flex min-w-[260px] flex-1 justify-center">
      <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
        <span className="font-medium">商品档案</span>
        <Badge tone={status === "success" ? "good" : status === "failed" ? "bad" : "warn"}>{userSyncStatusText(status)}</Badge>
        <span className="truncate text-muted-foreground">上次更新：{run ? formatShortDate(run.finishedAt || run.startedAt) : error}</span>
      </div>
    </div>
  );
}

function GoodsSyncStatusPanel({
  canSyncGoods,
  error,
  message,
  run,
  syncing,
  onRunSync,
}: {
  canSyncGoods: boolean;
  error: string;
  message: string;
  run: WdtGoodsSyncRunDto | null;
  syncing: boolean;
  onRunSync: () => void;
}) {
  const status = run?.status ?? "none";
  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">商品档案同步</h3>
            <Badge tone={status === "success" ? "good" : status === "failed" ? "bad" : "warn"}>{userSyncStatusText(status)}</Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">上次更新：{run ? formatShortDate(run.finishedAt || run.startedAt) : error}</p>
          {message ? <p className="mt-1 text-sm text-muted-foreground">{message}</p> : null}
          {!canSyncGoods ? <p className="mt-1 text-xs text-amber-700">当前账号只能查看同步状态，请联系管理员或运营账号处理。</p> : null}
        </div>
        <Button className="h-8 px-2" disabled={!canSyncGoods || syncing} onClick={onRunSync}>
          <RefreshCcw className="h-4 w-4" />
          {syncing ? "同步中" : "手动同步"}
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
    reason: line.reason,
  };
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
    inventoryException: lines.filter((line) => line.matchStatus === "api_error" || line.status === "库存不足").length,
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
  if (!run) return `真实初审已暂停：${error || "未读取到商品同步记录"}。请先完成商品档案同步。`;
  if (run.status === "running") return "真实初审已暂停：商品档案仍在同步中，请等待同步完成后刷新状态。";
  if (run.status === "failed") return "真实初审已暂停：最近一次商品档案同步失败，请先修复并重新同步。";
  return `真实初审已暂停：最近同步状态为 ${run.status}，不能作为正式审核依据。`;
}

function userSyncStatusText(status: WdtGoodsSyncRunDto["status"] | "none") {
  if (status === "success") return "已更新";
  if (status === "failed") return "需刷新";
  if (status === "running") return "更新中";
  return "未更新";
}

function batchStatusText(status: BatchSummary["status"]) {
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

function matchesFilter(line: ReviewLineDto, filter: FilterKey) {
  if (filter === "all") return true;
  if (filter === "ready") return line.status === "库存充足";
  if (filter === "partial") return line.status === "部分满足";
  if (filter === "blocked") return line.status === "库存不足";
  if (filter === "unmatched") return line.status === "未匹配" || line.matchStatus !== "matched";
  if (filter === "pending") return line.decision === "pending";
  if (filter === "ship") return line.decision === "ship";
  if (filter === "do_not_ship") return line.decision === "do_not_ship";
  if (filter === "priority") return line.priority;
  if (filter === "over_suggested") return line.decision === "ship" && line.approvedShipQty > line.suggestedShipQty;
  return true;
}

function validateDraft(line: ReviewLineDto, draft: ReviewDraft, approvedShipQty: number) {
  if (!Number.isFinite(approvedShipQty) || approvedShipQty < 0) return "发货数量不能小于 0";
  return "";
}
