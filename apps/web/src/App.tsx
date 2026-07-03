import { useEffect, useMemo, useState } from "react";
import { CheckCheck, Download, FileSpreadsheet, LogOut, RefreshCcw, Send } from "lucide-react";
import type { AuthUserDto, BatchSummary, ExportDto, ReviewDecision, ReviewLineDto, WdtGoodsSyncRunDto } from "@jy-trade/shared";

import { ProductMappingPanel } from "./components/ProductMappingPanel.js";
import { ReviewTable, type ReviewDraft } from "./components/ReviewTable.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";

const defaultOrderFile = "ole案例文件——发货前\\1订货单\\订货通知单 .xls";
const defaultMockFile = "examples/mock_flow_data.json";

type FilterKey =
  | "all"
  | "ready"
  | "partial"
  | "blocked"
  | "unmatched"
  | "pending"
  | "ship"
  | "do_not_ship"
  | "over_suggested";

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "ready", label: "库存充足" },
  { key: "partial", label: "部分满足" },
  { key: "blocked", label: "库存不足" },
  { key: "unmatched", label: "未匹配" },
  { key: "pending", label: "待审核" },
  { key: "ship", label: "已发货" },
  { key: "do_not_ship", label: "不发货" },
  { key: "over_suggested", label: "超建议数" },
];

export function App() {
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginName, setLoginName] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("admin123");
  const [loginError, setLoginError] = useState("");
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [activeBatch, setActiveBatch] = useState<BatchSummary | null>(null);
  const [reviewLines, setReviewLines] = useState<ReviewLineDto[]>([]);
  const [exports, setExports] = useState<ExportDto[]>([]);
  const [exportType, setExportType] = useState<ExportDto["type"]>("review");
  const [orderFile, setOrderFile] = useState(defaultOrderFile);
  const [mockFile, setMockFile] = useState(defaultMockFile);
  const [message, setMessage] = useState("准备创建 mock 批次");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [draftById, setDraftById] = useState<Record<string, ReviewDraft>>({});
  const [errorsById, setErrorsById] = useState<Record<string, string>>({});
  const [goodsSyncRun, setGoodsSyncRun] = useState<WdtGoodsSyncRunDto | null>(null);
  const [goodsSyncError, setGoodsSyncError] = useState("正在读取商品同步状态");

  async function refreshBatches() {
    const response = await fetch("/api/v1/batches");
    setBatches(await response.json());
  }

  async function refreshGoodsSyncStatus() {
    const response = await fetch("/api/v1/wdt/goods-sync-runs/latest");
    if (response.status === 404) {
      setGoodsSyncRun(null);
      setGoodsSyncError("还没有成功或失败的商品同步记录");
      return null;
    }
    if (!response.ok) {
      setGoodsSyncRun(null);
      setGoodsSyncError("商品同步状态读取失败");
      return null;
    }
    const run = (await response.json()) as WdtGoodsSyncRunDto;
    setGoodsSyncRun(run);
    setGoodsSyncError("");
    return run;
  }

  async function checkMe() {
    const response = await fetch("/api/v1/me");
    const body = await response.json();
    setUser(body.user ?? null);
    setAuthLoading(false);
    if (body.user) {
      await refreshBatches();
      await refreshGoodsSyncStatus();
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
  }

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    setUser(null);
    setActiveBatch(null);
    setReviewLines([]);
    setExports([]);
    setGoodsSyncRun(null);
    setGoodsSyncError("正在读取商品同步状态");
  }

  async function loadBatch(batch: BatchSummary) {
    setActiveBatch(batch);
    const response = await fetch(`/api/v1/batches/${batch.id}/review-lines`);
    const lines = (await response.json()) as ReviewLineDto[];
    setReviewLines(lines);
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

  async function runMockBatch() {
    setMessage("正在创建批次...");
    const createdResponse = await fetch("/api/v1/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: orderFile, mode: "mock" }),
    });
    const created = (await createdResponse.json()) as BatchSummary;
    setMessage("正在运行 mock 初审...");
    const reviewResponse = await fetch(`/api/v1/batches/${created.id}/actions/run-mock-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mockDataFile: mockFile }),
    });
    const review = await reviewResponse.json();
    setActiveBatch(review.batch);
    const linesResponse = await fetch(`/api/v1/batches/${created.id}/review-lines`);
    const lines = (await linesResponse.json()) as ReviewLineDto[];
    setReviewLines(lines);
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await refreshExports(created.id);
    setMessage("mock 初审已完成");
    await refreshBatches();
  }

  async function runRealBatch() {
    const latestSync = goodsSyncRun?.status ? goodsSyncRun : await refreshGoodsSyncStatus();
    if (!latestSync || latestSync.status !== "success") {
      setMessage(realReviewBlockedMessage(latestSync, goodsSyncError));
      return;
    }
    setMessage("正在创建真实初审批次...");
    const createdResponse = await fetch("/api/v1/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: orderFile, mode: "production_api" }),
    });
    if (!createdResponse.ok) {
      setMessage("创建真实初审批次失败");
      return;
    }

    const created = (await createdResponse.json()) as BatchSummary;
    setMessage("正在读取商品档案并查询旺店通库存...");
    const reviewResponse = await fetch(`/api/v1/batches/${created.id}/actions/run-real-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowStaleCache: false }),
    });
    if (!reviewResponse.ok) {
      const error = await reviewResponse.json();
      setActiveBatch(created);
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
    const linesResponse = await fetch(`/api/v1/batches/${created.id}/review-lines`);
    const lines = (await linesResponse.json()) as ReviewLineDto[];
    setReviewLines(lines);
    setDraftById(buildDrafts(lines));
    setErrorsById({});
    await refreshExports(created.id);
    setMessage(`真实初审已完成，已查询库存 ${review.stockQueriedCount ?? 0} 个规格`);
    await refreshBatches();
  }

  async function saveDecision(line: ReviewLineDto, patch?: Partial<ReviewDraft>) {
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
    setReviewLines((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setDraftById((current) => ({ ...current, [updated.id]: toDraft(updated) }));
    setErrorsById((current) => {
      const next = { ...current };
      delete next[updated.id];
      return next;
    });
    setMessage("审核决定已保存");
  }

  async function quickDecision(line: ReviewLineDto, decision: ReviewDecision) {
    const nextDraft: ReviewDraft =
      decision === "ship"
        ? { decision, approvedShipQty: String(line.suggestedShipQty), reason: draftById[line.id]?.reason ?? "" }
        : { decision, approvedShipQty: "0", reason: draftById[line.id]?.reason ?? "" };
    setDraftById((current) => ({ ...current, [line.id]: nextDraft }));
    await saveDecision(line, nextDraft);
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
    await loadBatch(result.batch);
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

  useEffect(() => {
    void checkMe();
  }, []);

  const stats = useMemo(() => buildStats(reviewLines), [reviewLines]);
  const filteredLines = useMemo(() => reviewLines.filter((line) => matchesFilter(line, activeFilter)), [reviewLines, activeFilter]);

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
        <section className="w-full max-w-sm rounded-md border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">甲方贸易发货初审平台</p>
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
      <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-6 py-6">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
          <div>
            <p className="text-sm text-muted-foreground">甲方贸易发货初审平台</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal">批次审核工作台</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {activeBatch ? <Badge tone={activeBatch.status === "reviewed" ? "good" : "info"}>{activeBatch.status}</Badge> : null}
            <Badge tone="neutral">{user.username}</Badge>
            <Badge tone="info">Mock/API 可切换架构</Badge>
            <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" />
              退出
            </Button>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-md border border-border bg-card p-4">
            <div className="mb-4 flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">运行 mock 初审</h2>
            </div>
            <label className="block text-sm text-muted-foreground">订货单路径</label>
            <input
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={orderFile}
              onChange={(event) => setOrderFile(event.target.value)}
            />
            <label className="mt-3 block text-sm text-muted-foreground">Mock 数据</label>
            <input
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={mockFile}
              onChange={(event) => setMockFile(event.target.value)}
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={runMockBatch}>
                <RefreshCcw className="h-4 w-4" />
                创建批次并初审
              </Button>
              <Button onClick={() => void runRealBatch()}>
                <FileSpreadsheet className="h-4 w-4" />
                运行真实初审
              </Button>
              <Button disabled={!activeBatch} onClick={bulkApprove}>
                <CheckCheck className="h-4 w-4" />
                批量通过可发项
              </Button>
              <Button disabled={!activeBatch} onClick={submitReview}>
                <Send className="h-4 w-4" />
                提交审核完成
              </Button>
              <span className="text-sm text-muted-foreground">{message}</span>
            </div>
            <GoodsSyncStatusPanel
              error={goodsSyncError}
              run={goodsSyncRun}
              onRefresh={() => void refreshGoodsSyncStatus()}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
            <Stat label="明细行" value={stats.total} />
            <Stat label="待审核" value={stats.pending} />
            <Stat label="已发货" value={stats.ship} />
            <Stat label="不发货" value={stats.doNotShip} />
            <Stat label="超建议数" value={stats.overSuggested} />
          </div>
        </section>

        <section className="grid min-w-0 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="rounded-md border border-border bg-card p-4">
            <h2 className="mb-3 text-lg font-semibold">批次列表</h2>
            <div className="space-y-2">
              {batches.map((batch) => (
                <button
                  key={batch.id}
                  className="w-full rounded-md border border-border px-3 py-2 text-left text-sm transition hover:bg-muted"
                  onClick={() => void loadBatch(batch)}
                >
                  <div className="font-medium">{batch.fileName}</div>
                  <div className="mt-1 text-muted-foreground">
                    {batch.status} / {batch.orderLineCount} 行
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">初审明细</h2>
                <p className="text-sm text-muted-foreground">{activeBatch ? activeBatch.id : "尚未选择批次"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {filters.map((filter) => (
                  <button
                    key={filter.key}
                    className={
                      filter.key === activeFilter
                        ? "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                        : "rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
                    }
                    onClick={() => setActiveFilter(filter.key)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
            <ReviewTable
              draftById={draftById}
              errorsById={errorsById}
              rows={filteredLines}
              onDraftChange={updateDraft}
              onQuickDecision={quickDecision}
              onSave={saveDecision}
            />

            <section className="mt-4 rounded-md border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">导出中心</h2>
                  <p className="text-sm text-muted-foreground">{activeBatch ? "生成和下载当前批次的 Excel" : "选择批次后可导出"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={exportType}
                    onChange={(event) => setExportType(event.target.value as ExportDto["type"])}
                  >
                    <option value="review">初审单</option>
                    <option value="confirmed">确定发货单</option>
                    <option value="wdt_import">做单 Excel</option>
                  </select>
                  <Button disabled={!activeBatch} onClick={() => void createExport()}>
                    <Download className="h-4 w-4" />
                    生成导出
                  </Button>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                {exports.length === 0 ? (
                  <div className="text-sm text-muted-foreground">暂无导出记录</div>
                ) : (
                  exports.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                      <div>
                        <div className="font-medium">{item.fileName}</div>
                        <div className="mt-1 text-muted-foreground">
                          {item.type} / {item.createdByUsername ?? "system"} / {new Date(item.createdAt).toLocaleString()}
                        </div>
                        {item.errorMessage ? <div className="mt-1 text-rose-700">{item.errorMessage}</div> : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={item.status === "ready" ? "good" : item.status === "failed" ? "bad" : "neutral"}>{item.status}</Badge>
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
            <ProductMappingPanel onMessage={setMessage} />
          </section>
        </section>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{value}</div>
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
  const isReady = status === "success";
  return (
    <section className="mt-4 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">商品档案同步</h3>
            <Badge tone={isReady ? "good" : status === "failed" ? "bad" : "warn"}>{syncStatusText(status)}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{syncSummary(run, error)}</p>
          {run?.errorMessage ? <p className="mt-1 text-xs text-rose-700">{run.errorMessage}</p> : null}
        </div>
        <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={onRefresh}>
          <RefreshCcw className="h-4 w-4" />
          刷新状态
        </Button>
      </div>
    </section>
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
    overSuggested: lines.filter((line) => line.decision === "ship" && line.approvedShipQty > line.suggestedShipQty).length,
  };
}

function realReviewBlockedMessage(run: WdtGoodsSyncRunDto | null, error: string) {
  if (!run) return `真实初审已暂停：${error || "未读取到商品同步记录"}。请先完成商品档案同步。`;
  if (run.status === "running") return "真实初审已暂停：商品档案仍在同步中，请等待同步完成后刷新状态。";
  if (run.status === "failed") return "真实初审已暂停：最近一次商品档案同步失败，请先修复并重新同步。";
  return `真实初审已暂停：最近同步状态为 ${run.status}，不能作为正式审核依据。`;
}

function syncStatusText(status: WdtGoodsSyncRunDto["status"] | "none") {
  if (status === "success") return "可用于真实初审";
  if (status === "failed") return "同步失败";
  if (status === "running") return "同步中";
  return "未同步";
}

function syncSummary(run: WdtGoodsSyncRunDto | null, error: string) {
  if (!run) return error || "暂无商品档案同步记录";
  const range = `${formatShortDate(run.rangeStart)} -> ${formatShortDate(run.rangeEnd)}`;
  return `范围 ${range}，拉取 ${run.fetchedCount} 条，写入 ${run.upsertedCount} 条，完成于 ${formatShortDate(run.finishedAt || run.startedAt)}`;
}

function formatShortDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
  if (filter === "over_suggested") return line.decision === "ship" && line.approvedShipQty > line.suggestedShipQty;
  return true;
}

function validateDraft(line: ReviewLineDto, draft: ReviewDraft, approvedShipQty: number) {
  if (!Number.isFinite(approvedShipQty) || approvedShipQty < 0) return "发货数量不能小于 0";
  if (draft.decision === "do_not_ship" && !draft.reason.trim()) return "不发货必须填写原因";
  if (draft.decision === "ship" && approvedShipQty > line.suggestedShipQty && !draft.reason.trim()) {
    return "发货数量超过建议发货数时必须填写原因";
  }
  return "";
}
