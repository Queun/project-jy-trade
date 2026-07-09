import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, ShieldAlert, Trash2, X, XCircle } from "lucide-react";
import type {
  ProductMappingDto,
  ProductMappingStatus,
  ProductMatchCandidateDto,
  WdtGoodsSpecSearchResultDto,
} from "@jy-trade/shared";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

export interface ProductMappingFocusProduct {
  externalBarcode: string;
  externalGoodsCode: string;
  externalGoodsName: string;
  wdtSpecNo?: string;
  wdtMakeOrderCode?: string;
  status?: string;
  mainAvailableBefore?: number;
  nearExpiryAvailableBefore?: number;
}

interface ProductMappingPanelProps {
  focusQuery?: string;
  focusProduct?: ProductMappingFocusProduct | null;
  sourceBatchId?: string;
  surface?: "panel" | "dialog";
  onMessage: (message: string) => void;
  onConfirmed?: (mapping: ProductMappingDto) => Promise<void> | void;
}

interface ProductMappingDialogProps extends Omit<ProductMappingPanelProps, "surface"> {
  open: boolean;
  onClose: () => void;
}

interface MappingDraft {
  externalBarcode: string;
  externalGoodsCode: string;
  externalGoodsName: string;
  wdtSpecNo: string;
  wdtMakeOrderCode: string;
  note: string;
}

const emptyDraft: MappingDraft = {
  externalBarcode: "",
  externalGoodsCode: "",
  externalGoodsName: "",
  wdtSpecNo: "",
  wdtMakeOrderCode: "",
  note: "",
};

export function ProductMappingDialog({ open, onClose, ...props }: ProductMappingDialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/35 px-3 py-5 sm:px-6" role="dialog" aria-modal="true" aria-labelledby="product-mapping-title">
      <div className="max-h-[calc(100vh-2.5rem)] w-full max-w-6xl overflow-hidden rounded-lg border border-border bg-background shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold" id="product-mapping-title">商品映射确认</h2>
            <p className="text-sm text-muted-foreground">查询库存、选择替代编码，并保存可复用映射</p>
          </div>
          <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={onClose}>
            <X className="h-4 w-4" />
            关闭
          </Button>
        </div>
        <div className="max-h-[calc(100vh-7.5rem)] overflow-y-auto">
          <ProductMappingPanel {...props} surface="dialog" />
        </div>
      </div>
    </div>
  );
}

export function ProductMappingPanel({ focusQuery = "", focusProduct = null, sourceBatchId = "", surface = "panel", onMessage, onConfirmed }: ProductMappingPanelProps) {
  const [query, setQuery] = useState("");
  const [specQuery, setSpecQuery] = useState("");
  const [draft, setDraft] = useState<MappingDraft>(emptyDraft);
  const [mappings, setMappings] = useState<ProductMappingDto[]>([]);
  const [candidates, setCandidates] = useState<ProductMatchCandidateDto[]>([]);
  const [specs, setSpecs] = useState<WdtGoodsSpecSearchResultDto[]>([]);
  const [error, setError] = useState("");
  const [activeView, setActiveView] = useState<"lookup" | "current" | "library">(focusProduct ? "current" : "lookup");
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [isSearchingSpecs, setIsSearchingSpecs] = useState(false);
  const mappingRequestIdRef = useRef(0);
  const candidateRequestIdRef = useRef(0);

  async function refreshMappings(nextQuery = query) {
    const requestId = mappingRequestIdRef.current + 1;
    mappingRequestIdRef.current = requestId;
    const response = await fetch(`/api/v1/product-mappings?query=${encodeURIComponent(nextQuery)}`);
    if (requestId !== mappingRequestIdRef.current) return;
    if (!response.ok) {
      setMappings([]);
      return;
    }
    setMappings((await response.json()) as ProductMappingDto[]);
  }

  async function refreshCandidates(nextQuery = query) {
    const requestId = candidateRequestIdRef.current + 1;
    candidateRequestIdRef.current = requestId;
    setIsLoadingCandidates(true);
    try {
      const response = await fetch(`/api/v1/product-match-candidates?query=${encodeURIComponent(nextQuery)}`);
      if (requestId !== candidateRequestIdRef.current) return;
      if (!response.ok) {
        setCandidates([]);
        return;
      }
      setCandidates((await response.json()) as ProductMatchCandidateDto[]);
    } finally {
      if (requestId === candidateRequestIdRef.current) setIsLoadingCandidates(false);
    }
  }

  async function searchSpecs() {
    setError("");
    setIsSearchingSpecs(true);
    try {
      const response = await fetch(`/api/v1/wdt/goods-specs/search?query=${encodeURIComponent(specQuery)}`);
      if (!response.ok) {
        setSpecs([]);
        setError("商品规格搜索失败");
        return;
      }
      setSpecs((await response.json()) as WdtGoodsSpecSearchResultDto[]);
    } finally {
      setIsSearchingSpecs(false);
    }
  }

  async function confirmMapping() {
    setError("");
    const response = await fetch("/api/v1/product-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft, sourceBatchId }),
    });
    if (!response.ok) {
      const body = await response.json();
      setError(body.message ?? "保存长期映射失败");
      return;
    }
    const mapping = (await response.json()) as ProductMappingDto;
    setQuery(mapping.externalBarcode || mapping.externalGoodsCode || mapping.externalGoodsName);
    setDraft(emptyDraft);
    await refreshMappings(mapping.externalBarcode || mapping.externalGoodsCode || mapping.externalGoodsName);
    await refreshCandidates(mapping.externalBarcode || mapping.externalGoodsCode || mapping.externalGoodsName);
    onMessage("长期商品映射已保存");
    await onConfirmed?.(mapping);
  }

  async function updateStatus(mapping: ProductMappingDto, status: Exclude<ProductMappingStatus, "confirmed">) {
    const response = await fetch(`/api/v1/product-mappings/${mapping.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note: status === "disabled" ? "前端标记禁用" : "前端标记需复查" }),
    });
    if (!response.ok) {
      const body = await response.json();
      setError(body.message ?? "更新映射状态失败");
      return;
    }
    await refreshMappings();
    onMessage(status === "disabled" ? "商品映射已禁用" : "商品映射已标记复查");
  }

  async function reviewMapping(mapping: ProductMappingDto) {
    setActiveView("current");
    setDraft({
      externalBarcode: mapping.externalBarcode,
      externalGoodsCode: mapping.externalGoodsCode,
      externalGoodsName: mapping.externalGoodsName,
      wdtSpecNo: mapping.wdtSpecNo,
      wdtMakeOrderCode: mapping.wdtMakeOrderCode || mapping.wdtSpecNo,
      note: mapping.note || "复查长期映射",
    });
    setSpecQuery(mapping.wdtGoodsName || mapping.wdtSpecNo);
    setSpecs([]);
    await updateStatus(mapping, "needs_review");
  }

  async function deleteMapping(mapping: ProductMappingDto) {
    if (!window.confirm(`确定删除长期映射“${mapping.externalGoodsName || mapping.externalBarcode || mapping.externalGoodsCode}”吗？删除后后续批次不会再使用这条人工映射。`)) return;
    const response = await fetch(`/api/v1/product-mappings/${mapping.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json();
      setError(body.message ?? "删除长期映射失败");
      return;
    }
    await refreshMappings();
    await refreshCandidates();
    onMessage("长期商品映射已删除，重新初审后生效");
  }

  function chooseSpec(spec: WdtGoodsSpecSearchResultDto) {
    setDraft((current) => ({
      ...current,
      wdtSpecNo: spec.specNo,
      wdtMakeOrderCode: spec.makeOrderCode || spec.specNo,
      note: current.note || "前端人工确认映射",
    }));
  }

  function chooseCandidate(candidate: ProductMatchCandidateDto) {
    setDraft({
      externalBarcode: candidate.externalBarcode,
      externalGoodsCode: candidate.externalGoodsCode,
      externalGoodsName: candidate.externalGoodsName,
      wdtSpecNo: candidate.wdtSpecNo,
      wdtMakeOrderCode: candidate.source === "suite" ? candidate.wdtGoodsNo : candidate.wdtSpecNo,
      note: `智能候选确认：${candidateBasisLabel(candidate.basis)}，分数 ${candidate.score}`,
    });
    setSpecQuery(candidate.wdtSpecNo);
  }

  function useSpecAsMappingTarget(spec: WdtGoodsSpecSearchResultDto) {
    chooseSpec(spec);
    setActiveView("current");
    onMessage("已带入旺店通规格，请补充外部条码或编码后保存长期映射");
  }

  useEffect(() => {
    if (!focusQuery) void refreshMappings();
  }, []);

  useEffect(() => {
    if (!focusQuery) return;
    setQuery(focusQuery);
    setSpecQuery(focusProduct?.externalGoodsName || focusQuery);
    setMappings([]);
    setCandidates([]);
    setSpecs([]);
    setActiveView("current");
    if (focusProduct) {
      setDraft({
        externalBarcode: focusProduct.externalBarcode,
        externalGoodsCode: focusProduct.externalGoodsCode,
        externalGoodsName: focusProduct.externalGoodsName,
        wdtSpecNo: "",
        wdtMakeOrderCode: "",
        note: "审核异常行保存为长期映射",
      });
    }
    void refreshMappings(focusQuery);
    void refreshCandidates(focusQuery);
  }, [focusQuery, focusProduct]);

  const selectedSpec = useMemo(
    () => specs.find((spec) => spec.specNo === draft.wdtSpecNo && (spec.makeOrderCode || spec.specNo) === (draft.wdtMakeOrderCode || draft.wdtSpecNo)),
    [draft.wdtMakeOrderCode, draft.wdtSpecNo, specs],
  );
  const canSaveMapping = Boolean(draft.wdtSpecNo && (draft.externalBarcode || draft.externalGoodsCode));

  return (
    <section className={surface === "dialog" ? "p-4" : "mt-4 rounded-md border border-border bg-card p-4"} id="product-mapping-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {surface === "panel" ? <h2 className="text-lg font-semibold">商品映射确认</h2> : null}
          <p className="mt-1 text-sm text-muted-foreground">查询旺店通可发库存，选择替代编码，并把核实后的关系保存为长期映射</p>
        </div>
        <Badge tone="warn">WDT 只读</Badge>
      </div>
      {focusProduct ? (
        <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <div className="font-medium">{focusProduct.externalGoodsName || "当前订单行"}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            <span>外部条码 {focusProduct.externalBarcode || "无"}</span>
            <span>外部编码 {focusProduct.externalGoodsCode || "无"}</span>
            {focusProduct.wdtMakeOrderCode || focusProduct.wdtSpecNo ? <span>当前编码 {focusProduct.wdtMakeOrderCode || focusProduct.wdtSpecNo}</span> : null}
            {focusProduct.status ? <span>状态 {focusProduct.status}</span> : null}
            {focusProduct.mainAvailableBefore !== undefined || focusProduct.nearExpiryAvailableBefore !== undefined ? (
              <span>可发 主 {focusProduct.mainAvailableBefore ?? 0} / 临 {focusProduct.nearExpiryAvailableBefore ?? 0}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        智能候选和手动查询都只辅助人工判断，不会自动改订单；只有手动保存后的编号映射会在后续批次优先命中。
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className={activeView === "lookup" ? "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" : "rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:bg-muted"}
          onClick={() => setActiveView("lookup")}
        >
          查库存
        </button>
        <button
          className={activeView === "current" ? "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" : "rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:bg-muted"}
          onClick={() => setActiveView("current")}
        >
          当前行映射
        </button>
        <button
          className={activeView === "library" ? "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" : "rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:bg-muted"}
          onClick={() => setActiveView("library")}
        >
          长期映射库
        </button>
      </div>

      {activeView === "lookup" ? (
        <div className="mt-4 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">库存查询</h3>
              <p className="mt-1 text-sm text-muted-foreground">输入名称、商品条码、组合装条码、商家编码或规格编码，结果按当前仓库范围显示可发库存。</p>
            </div>
            <Badge tone="info">旺店通商品库</Badge>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              aria-label="库存查询"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              placeholder="输入名称、条码或编码"
              value={specQuery}
              onChange={(event) => setSpecQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void searchSpecs();
              }}
            />
            <Button className="h-9" disabled={isSearchingSpecs} onClick={() => void searchSpecs()}>
              <Search className="h-4 w-4" />
              {isSearchingSpecs ? "查询中..." : "查询库存"}
            </Button>
          </div>
          <SpecSearchResults
            specs={specs}
            emptyText={isSearchingSpecs ? "正在查询库存..." : "输入关键词后查询可发库存"}
            actionLabel="用作映射目标"
            onChoose={useSpecAsMappingTarget}
          />
        </div>
      ) : null}

      {activeView === "current" ? <div className="mt-4 grid gap-3 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-md border border-border p-3">
          <h3 className="text-sm font-semibold">手动查询</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              aria-label="旺店通商品搜索"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={specQuery}
              onChange={(event) => setSpecQuery(event.target.value)}
            />
            <Button className="h-9" disabled={isSearchingSpecs} onClick={() => void searchSpecs()}>
              <Search className="h-4 w-4" />
              {isSearchingSpecs ? "搜索中..." : "搜索规格"}
            </Button>
          </div>
          <SpecSearchResults specs={specs} emptyText={isSearchingSpecs ? "正在搜索商品..." : ""} onChoose={chooseSpec} />
        </div>

        <div className="rounded-md border border-border p-3">
          <h3 className="text-sm font-semibold">保存映射</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Field label="外部条码" value={draft.externalBarcode} onChange={(value) => setDraft((current) => ({ ...current, externalBarcode: value }))} />
            <Field label="外部编码" value={draft.externalGoodsCode} onChange={(value) => setDraft((current) => ({ ...current, externalGoodsCode: value }))} />
            <Field
              className="sm:col-span-2"
              label="外部商品名"
              value={draft.externalGoodsName}
              onChange={(value) => setDraft((current) => ({ ...current, externalGoodsName: value }))}
            />
            <Field label="旺店通 spec_no" value={draft.wdtSpecNo} onChange={(value) => setDraft((current) => ({ ...current, wdtSpecNo: value }))} />
            <Field label="做单码" value={draft.wdtMakeOrderCode} onChange={(value) => setDraft((current) => ({ ...current, wdtMakeOrderCode: value }))} />
            <Field label="备注" value={draft.note} onChange={(value) => setDraft((current) => ({ ...current, note: value }))} />
          </div>
          {selectedSpec ? (
            <div className="mt-3 rounded-md bg-muted px-3 py-2 text-sm">
              已选：{selectedSpec.goodsName} / {selectedSpec.specName} / {selectedSpec.barcode}
              {(selectedSpec.makeOrderCode || selectedSpec.specNo) !== selectedSpec.specNo ? ` / 做单码 ${selectedSpec.makeOrderCode}` : ""}
            </div>
          ) : null}
          {error ? <div className="mt-3 text-sm text-rose-700">{error}</div> : null}
          <Button className="mt-3" disabled={!canSaveMapping} onClick={() => void confirmMapping()}>
            <Check className="h-4 w-4" />
            保存长期映射
          </Button>
        </div>
      </div> : null}

      {activeView === "current" ? (
        <div className="mb-4 rounded-md border border-border p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">智能候选</h3>
            <Button
              className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80"
              disabled={isLoadingCandidates}
              onClick={() => void refreshCandidates()}
            >
              <Search className="h-4 w-4" />
              {isLoadingCandidates ? "刷新中..." : "刷新智能候选"}
            </Button>
          </div>
          {isLoadingCandidates ? <div className="mb-2 text-sm text-muted-foreground">正在查询智能候选...</div> : null}
          <div className="grid gap-2 lg:grid-cols-2">
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                className="rounded-md border border-border px-3 py-2 text-left text-sm transition hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                onClick={() => chooseCandidate(candidate)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{candidate.externalGoodsName || "未填名称"}</span>
                  <Badge tone="warn">智能分 {candidate.score}</Badge>
                  <Badge tone="info">{candidateBasisLabel(candidate.basis)}</Badge>
                  <Badge tone="neutral">{candidateSourceLabel(candidate.source)}</Badge>
                  <StockBadge stockError={candidate.stockError} stockTotalAvailable={candidate.stockTotalAvailable} />
                </div>
                <div className="mt-1 text-muted-foreground">
                  {candidate.externalBarcode || "无条码"} / {candidate.externalGoodsCode || "无编码"}
                </div>
                <div className="mt-1 text-muted-foreground">
                  {"->"} {candidate.wdtGoodsName} / {candidate.wdtSpecNo} / {candidate.wdtSpecName}
                </div>
                <StockRows id={candidate.id} rows={candidate.stockRows} stockError={candidate.stockError} />
              </button>
            ))}
            {candidates.length === 0 && !isLoadingCandidates ? <div className="text-sm text-muted-foreground">暂无智能候选，可使用上方手动查询继续查找。</div> : null}
          </div>
        </div>
      ) : null}

      <div className={activeView === "library" ? "mt-4" : "mt-4"}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">已确认/待处理映射</h3>
          <div className="flex gap-2">
            <input
              aria-label="映射搜索"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button className="h-9" onClick={() => void refreshMappings()}>
              <Search className="h-4 w-4" />
              查询
            </Button>
            <Button
              className="h-9 bg-muted text-muted-foreground hover:bg-muted/80"
              disabled={isLoadingCandidates}
              onClick={() => {
                setActiveView("current");
                void refreshCandidates();
              }}
            >
              {isLoadingCandidates ? "查询中..." : "查智能候选"}
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[920px] border-collapse text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">外部商品</th>
                <th className="px-3 py-2 text-left font-medium">旺店通规格</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">备注</th>
                <th className="px-3 py-2 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping) => (
                <tr key={mapping.id} className="border-t border-border">
                  <td className="px-3 py-3 align-top">
                    <div className="font-medium">{mapping.externalGoodsName || "未填名称"}</div>
                    <div className="mt-1 text-muted-foreground">{mapping.externalBarcode || "无条码"} / {mapping.externalGoodsCode || "无编码"}</div>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="font-medium">{mapping.wdtGoodsName}</div>
                    <div className="mt-1 text-muted-foreground">{mapping.wdtSpecNo} / {mapping.wdtSpecName} / {mapping.wdtBarcode}</div>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <Badge tone={mapping.status === "confirmed" ? "good" : mapping.status === "needs_review" ? "warn" : "bad"}>{mapping.status}</Badge>
                  </td>
                  <td className="px-3 py-3 align-top text-muted-foreground">{mapping.note}</td>
                  <td className="px-3 py-3 align-top">
                    <div className="flex flex-wrap gap-2">
                      <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={() => void reviewMapping(mapping)}>
                        <ShieldAlert className="h-4 w-4" />
                        复查
                      </Button>
                      <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={() => void updateStatus(mapping, "disabled")}>
                        <XCircle className="h-4 w-4" />
                        禁用
                      </Button>
                      <Button className="h-8 bg-rose-50 px-2 text-rose-700 hover:bg-rose-100" onClick={() => void deleteMapping(mapping)}>
                        <Trash2 className="h-4 w-4" />
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {mappings.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-muted-foreground" colSpan={5}>
                    暂无映射记录
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function SpecSearchResults({
  specs,
  emptyText,
  actionLabel = "选择",
  onChoose,
}: {
  specs: WdtGoodsSpecSearchResultDto[];
  emptyText: string;
  actionLabel?: string;
  onChoose: (spec: WdtGoodsSpecSearchResultDto) => void;
}) {
  return (
    <div className="mt-3 max-h-80 space-y-2 overflow-auto">
      {specs.length === 0 && emptyText ? <div className="text-sm text-muted-foreground">{emptyText}</div> : null}
      {specs.map((spec) => (
        <button
          key={spec.id}
          className="w-full rounded-md border border-border px-3 py-2 text-left text-sm transition hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
          onClick={() => onChoose(spec)}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{spec.goodsName}</span>
              <Badge tone={spec.source === "suite" ? "info" : "neutral"}>{spec.source === "suite" ? "组合装" : "商品"}</Badge>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <StockBadge stockError={spec.stockError} stockTotalAvailable={spec.stockTotalAvailable} />
              <span className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-muted-foreground">{actionLabel}</span>
            </span>
          </div>
          <div className="mt-1 text-muted-foreground">
            {spec.specNo} / {spec.specName} / {spec.barcode || "无主条码"}
          </div>
          {(spec.makeOrderCode || spec.specNo) !== spec.specNo ? (
            <div className="mt-1 text-muted-foreground">做单码 {spec.makeOrderCode}</div>
          ) : null}
          <StockRows id={spec.id} rows={spec.stockRows} stockError={spec.stockError} />
        </button>
      ))}
    </div>
  );
}

function Field({ className = "", label, value, onChange }: { className?: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={className}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        aria-label={label}
        className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function StockBadge({ stockError, stockTotalAvailable }: { stockError?: string; stockTotalAvailable?: number }) {
  return (
    <Badge tone={stockError ? "bad" : stockTotalAvailable && stockTotalAvailable > 0 ? "good" : "neutral"}>
      {stockError ? "库存未查到" : stockTotalAvailable === undefined ? "库存未查询" : `可发 ${stockTotalAvailable}`}
    </Badge>
  );
}

function candidateBasisLabel(basis: ProductMatchCandidateDto["basis"]) {
  const labels: Record<ProductMatchCandidateDto["basis"], string> = {
    barcode: "条码命中",
    code: "编码命中",
    exact_name: "名称完全一致",
    contains_name: "名称包含",
    fuzzy_name: "名称相似",
  };
  return labels[basis];
}

function candidateSourceLabel(source: ProductMatchCandidateDto["source"]) {
  return source === "suite" ? "组合装" : "商品";
}

function StockRows({
  id,
  rows,
  stockError,
}: {
  id: string;
  rows?: Array<{ warehouseNo: string; warehouseName: string; availableSendStock: number; included: boolean }>;
  stockError?: string;
}) {
  const includedRows = rows?.filter((row) => row.included) ?? [];
  if (includedRows.length > 0) {
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {includedRows.map((row) => (
          <span
            key={`${id}-${row.warehouseNo}-${row.warehouseName}`}
            className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-900"
          >
            {row.warehouseNo || row.warehouseName || "未命名仓"} {row.warehouseName ? `/${row.warehouseName}` : ""}: {row.availableSendStock}
          </span>
        ))}
      </div>
    );
  }
  return stockError ? <div className="mt-2 text-xs text-rose-700">{stockError}</div> : null;
}
