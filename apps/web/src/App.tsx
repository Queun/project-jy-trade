import { useEffect, useMemo, useState } from "react";
import { CheckCheck, ChevronDown, ChevronUp, ClipboardList, Download, FileSpreadsheet, HelpCircle, LogOut, PackageCheck, RefreshCcw, Save, Send, Settings, Upload, Warehouse } from "lucide-react";
import type { AuthUserDto, BatchSummary, ExportDto, ReviewDecision, ReviewLineDto, WarehouseUsageSettingsDto, WdtGoodsSyncRunDto } from "@jy-trade/shared";

import { ProductMappingPanel } from "./components/ProductMappingPanel.js";
import { ReviewTable, type ReviewDraft } from "./components/ReviewTable.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";

const defaultOrderFile = "ole案例文件——发货前\\1订货单\\订货通知单 .xls";
const defaultMockFile = "examples/mock_flow_data.json";
const helpDismissedStorageKey = "jy-trade-help-dismissed-v1";

type WorkTab = "import" | "review" | "export";
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
  { key: "blocked", label: "库存不足" },
  { key: "unmatched", label: "商品异常" },
  { key: "pending", label: "待审核" },
  { key: "ship", label: "已发货" },
  { key: "do_not_ship", label: "不发货" },
  { key: "priority", label: "优先处理" },
  { key: "over_suggested", label: "超建议数" },
];

const workTabs: Array<{ key: WorkTab; label: string; icon: typeof FileSpreadsheet }> = [
  { key: "import", label: "导入订单", icon: FileSpreadsheet },
  { key: "review", label: "审核发货", icon: ClipboardList },
  { key: "export", label: "做单", icon: PackageCheck },
];

export function App() {
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginName, setLoginName] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("admin123");
  const [loginError, setLoginError] = useState("");
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [activeBatch, setActiveBatch] = useState<BatchSummary | null>(null);
  const [activeTab, setActiveTab] = useState<WorkTab>("import");
  const [reviewLines, setReviewLines] = useState<ReviewLineDto[]>([]);
  const [exports, setExports] = useState<ExportDto[]>([]);
  const [exportType, setExportType] = useState<ExportDto["type"]>("review");
  const [orderFile, setOrderFile] = useState(defaultOrderFile);
  const [mockFile, setMockFile] = useState(defaultMockFile);
  const [message, setMessage] = useState("请选择订单文件并开始初审");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [draftById, setDraftById] = useState<Record<string, ReviewDraft>>({});
  const [errorsById, setErrorsById] = useState<Record<string, string>>({});
  const [savingReasonById, setSavingReasonById] = useState<Record<string, boolean>>({});
  const [goodsSyncRun, setGoodsSyncRun] = useState<WdtGoodsSyncRunDto | null>(null);
  const [goodsSyncError, setGoodsSyncError] = useState("正在读取商品同步状态");
  const [warehouseSettings, setWarehouseSettings] = useState<WarehouseUsageSettingsDto | null>(null);
  const [warehouseSettingsDraft, setWarehouseSettingsDraft] = useState<WarehouseUsageSettingsDto | null>(null);
  const [warehouseSettingsMessage, setWarehouseSettingsMessage] = useState("");
  const [selectedOrderFileName, setSelectedOrderFileName] = useState("");
  const [pendingOrderUpload, setPendingOrderUpload] = useState<File | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(() => localStorage.getItem(helpDismissedStorageKey) !== "true");

  async function refreshBatches() {
    const response = await fetch("/api/v1/batches");
    setBatches(await response.json());
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
    setGoodsSyncRun(null);
    setGoodsSyncError("正在读取商品同步状态");
    setWarehouseSettings(null);
    setWarehouseSettingsDraft(null);
    setWarehouseSettingsMessage("");
  }

  async function loadBatch(batch: BatchSummary, nextTab?: WorkTab) {
    setActiveBatch(batch);
    if (nextTab) setActiveTab(nextTab);
    const lines = await fetchReviewLines(batch.id);
    if (!lines) return;
    setReviewLines(sortReviewLines(lines));
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await refreshExports(batch.id);
  }

  async function refreshExports(batchId: string) {
    const response = await fetch(`/api/v1/batches/${batchId}/exports`);
    if (!response.ok) {
      setExports([]);
      return;
    }
    setExports((await response.json()) as ExportDto[]);
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
    setMessage("初审已完成，请进入审核发货");
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
    setMessage(`真实初审已完成，已查询库存 ${review.stockQueriedCount ?? 0} 个规格`);
    await refreshBatches();
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
    await refreshBatches();
    setMessage(`审核已提交：待审核 ${result.pendingCount}，发货 ${result.shipCount}，不发 ${result.doNotShipCount}`);
  }

  async function createExport() {
    if (!activeBatch) return;
    setMessage("正在生成导出文件...");
    const response = await fetch(`/api/v1/batches/${activeBatch.id}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: exportType }),
    });
    if (!response.ok) {
      setMessage("导出失败");
      return;
    }
    const created = (await response.json()) as ExportDto;
    await refreshExports(activeBatch.id);
    setMessage(created.status === "ready" ? "导出文件已生成" : "导出失败");
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

        {showSettings ? (
          <SettingsPanel
            canManageSettings={permissions.canManageSettings}
            goodsSyncError={goodsSyncError}
            goodsSyncRun={goodsSyncRun}
            warehouseSettings={warehouseSettings}
            warehouseSettingsDraft={warehouseSettingsDraft}
            warehouseSettingsMessage={warehouseSettingsMessage}
            onClose={() => setShowSettings(false)}
            onRefreshGoodsSync={() => void refreshGoodsSyncStatus()}
            onSaveWarehouseSettings={() => void saveWarehouseSettings()}
            onWarehouseSettingsDraftChange={setWarehouseSettingsDraft}
          />
        ) : null}

        <section className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <BatchList batches={batches} activeBatchId={activeBatch?.id} onSelect={(batch) => void loadBatch(batch)} />

          <section className="min-w-0">
            {showHelp ? <HelpPanel onDismiss={dismissHelp} /> : null}
            <CurrentBatchPanel batch={activeBatch} message={message} reviewLines={reviewLines} />

            <nav className="mt-4 grid gap-2 rounded-md border border-border bg-card p-1 sm:grid-cols-3" aria-label="业务步骤">
              {workTabs.map((tab) => {
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
                onBulkApprove={() => void bulkApprove()}
                onDraftChange={updateDraft}
                onFilterChange={setActiveFilter}
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
                exportType={exportType}
                exports={exports}
                onCreateExport={() => void createExport()}
                onExportTypeChange={setExportType}
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
  onSelect,
}: {
  activeBatchId?: string;
  batches: BatchSummary[];
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
                className="w-full px-3 py-2 text-left text-sm"
                data-testid={`batch-card-${batch.id}`}
                onClick={() => onSelect(batch)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{batch.fileName}</div>
                    <div className="mt-1 text-xs text-muted-foreground">上传 {formatShortDate(batch.createdAt)}</div>
                  </div>
                  <Badge tone={batchStatusTone(batch.status)}>{batchStatusText(batch.status)}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span>{batch.orderLineCount} 行</span>
                  <span>{batch.matchedBarcodeCount}/{batch.uniqueBarcodeCount} 已匹配</span>
                </div>
              </button>
              <button
                className="flex w-full items-center justify-center gap-1 border-t border-border/70 px-3 py-1.5 text-xs text-muted-foreground hover:bg-background/50"
                onClick={() => setExpandedBatchId(expanded ? null : batch.id)}
              >
                {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {expanded ? "收起详情" : "查看详情"}
              </button>
              {expanded ? (
                <dl className="grid gap-2 border-t border-border/70 px-3 py-2 text-xs">
                  <MetaItem label="上传时间" value={formatShortDate(batch.createdAt)} />
                  <MetaItem label="更新时间" value={formatShortDate(batch.updatedAt)} />
                  <MetaItem label="订单行数" value={`${batch.orderLineCount}`} />
                  <MetaItem label="匹配情况" value={`${batch.matchedBarcodeCount}/${batch.uniqueBarcodeCount}`} />
                  <MetaItem label="订单时间跨度" value="选择批次后查看" />
                  <MetaItem label="门店 / 订单" value="选择批次后统计" />
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
  canManageSettings,
  goodsSyncError,
  goodsSyncRun,
  warehouseSettings,
  warehouseSettingsDraft,
  warehouseSettingsMessage,
  onClose,
  onRefreshGoodsSync,
  onSaveWarehouseSettings,
  onWarehouseSettingsDraftChange,
}: {
  canManageSettings: boolean;
  goodsSyncError: string;
  goodsSyncRun: WdtGoodsSyncRunDto | null;
  warehouseSettings: WarehouseUsageSettingsDto | null;
  warehouseSettingsDraft: WarehouseUsageSettingsDto | null;
  warehouseSettingsMessage: string;
  onClose: () => void;
  onRefreshGoodsSync: () => void;
  onSaveWarehouseSettings: () => void;
  onWarehouseSettingsDraftChange: (settings: WarehouseUsageSettingsDto) => void;
}) {
  return (
    <section className="rounded-md border border-border bg-card p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">设置</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">调整会影响之后重新运行的初审结果。</p>
        </div>
        <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={onClose}>
          收起
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
        <GoodsSyncStatusPanel error={goodsSyncError} run={goodsSyncRun} onRefresh={onRefreshGoodsSync} />
      </div>
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
  onRunReal: () => void;
}) {
  const canRunReal = canImport && goodsSyncRun?.status === "success" && (isDeveloperMode || Boolean(selectedOrderFileName));

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
            商品档案同步可用后才能导入新订单。请在设置中刷新状态，或先完成商品档案同步。
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
  savingReasonById,
  canReview,
  stats,
  onBulkApprove,
  onDraftChange,
  onFilterChange,
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
  savingReasonById: Record<string, boolean>;
  canReview: boolean;
  stats: ReturnType<typeof buildStats>;
  onBulkApprove: () => void;
  onDraftChange: (lineId: string, patch: Partial<ReviewDraft>) => void;
  onFilterChange: (filter: FilterKey) => void;
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
      {isDeveloperMode ? <ProductMappingPanel onMessage={onMessage} /> : null}
    </section>
  );
}

function ExportTab({
  activeBatch,
  canExport,
  exportType,
  exports,
  onCreateExport,
  onExportTypeChange,
}: {
  activeBatch: BatchSummary | null;
  canExport: boolean;
  exportType: ExportDto["type"];
  exports: ExportDto[];
  onCreateExport: () => void;
  onExportTypeChange: (type: ExportDto["type"]) => void;
}) {
  const batchReadyForExport = activeBatch?.status === "reviewed" || activeBatch?.status === "exported";
  const canCreateExport = canExport && batchReadyForExport;

  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">做单</h2>
          <p className="text-sm text-muted-foreground">{activeBatch ? "生成并下载当前批次的 Excel 文件" : "选择批次后可生成 Excel"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={exportType}
            onChange={(event) => onExportTypeChange(event.target.value as ExportDto["type"])}
            disabled={!canCreateExport}
          >
            <option value="review">初审单</option>
            <option value="confirmed">确定发货单</option>
            <option value="wdt_import">做单 Excel</option>
          </select>
          <Button data-testid="create-export" disabled={!canCreateExport} onClick={onCreateExport}>
            <Download className="h-4 w-4" />
            生成导出
          </Button>
        </div>
      </div>
      {!canExport ? (
        <PermissionHint className="mt-4" message="当前账号不能生成做单文件，请联系管理员或切换到运营账号。" />
      ) : !activeBatch ? (
        <EmptyState className="mt-4" title="先选择一个批次" description="完成审核后，这里会生成初审单、确定发货单或做单 Excel。" />
      ) : !batchReadyForExport ? (
        <EmptyState className="mt-4" title="等待审核完成" description="当前批次还没有提交审核，确认发货数量后再生成做单文件。" />
      ) : null}
      <div className="mt-4 space-y-2">
        {exports.length === 0 && canCreateExport ? (
          <div className="text-sm text-muted-foreground">暂无导出记录</div>
        ) : (
          exports.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <div>
                <div className="font-medium">{item.fileName}</div>
                <div className="mt-1 text-muted-foreground">
                  {exportTypeText(item.type)} / {item.createdByUsername ?? "系统"} / {formatShortDate(item.createdAt)}
                </div>
                {item.errorMessage ? <div className="mt-1 text-rose-700">{item.errorMessage}</div> : null}
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
  error,
  run,
  onRefresh,
}: {
  error: string;
  run: WdtGoodsSyncRunDto | null;
  onRefresh: () => void;
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
          {status !== "success" ? <p className="mt-1 text-xs text-amber-700">刷新后仍不可用时，请先完成商品档案同步。</p> : null}
        </div>
        <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={onRefresh}>
          <RefreshCcw className="h-4 w-4" />
          刷新
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
    canManageSettings: role === "admin",
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
