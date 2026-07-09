import { useEffect, useMemo, useState } from "react";
import { Check, Search, ShieldAlert, Trash2, XCircle } from "lucide-react";
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
}

interface ProductMappingPanelProps {
  focusQuery?: string;
  focusProduct?: ProductMappingFocusProduct | null;
  sourceBatchId?: string;
  onMessage: (message: string) => void;
  onConfirmed?: (mapping: ProductMappingDto) => Promise<void> | void;
}

interface MappingDraft {
  externalBarcode: string;
  externalGoodsCode: string;
  externalGoodsName: string;
  wdtSpecNo: string;
  note: string;
}

const emptyDraft: MappingDraft = {
  externalBarcode: "",
  externalGoodsCode: "",
  externalGoodsName: "",
  wdtSpecNo: "",
  note: "",
};

export function ProductMappingPanel({ focusQuery = "", focusProduct = null, sourceBatchId = "", onMessage, onConfirmed }: ProductMappingPanelProps) {
  const [query, setQuery] = useState("2153722460015");
  const [specQuery, setSpecQuery] = useState("雅漾");
  const [draft, setDraft] = useState<MappingDraft>(emptyDraft);
  const [mappings, setMappings] = useState<ProductMappingDto[]>([]);
  const [candidates, setCandidates] = useState<ProductMatchCandidateDto[]>([]);
  const [specs, setSpecs] = useState<WdtGoodsSpecSearchResultDto[]>([]);
  const [error, setError] = useState("");

  async function refreshMappings(nextQuery = query) {
    const response = await fetch(`/api/v1/product-mappings?query=${encodeURIComponent(nextQuery)}`);
    if (!response.ok) {
      setMappings([]);
      return;
    }
    setMappings((await response.json()) as ProductMappingDto[]);
  }

  async function refreshCandidates(nextQuery = query) {
    const response = await fetch(`/api/v1/product-match-candidates?query=${encodeURIComponent(nextQuery)}`);
    if (!response.ok) {
      setCandidates([]);
      return;
    }
    setCandidates((await response.json()) as ProductMatchCandidateDto[]);
  }

  async function searchSpecs() {
    setError("");
    const response = await fetch(`/api/v1/wdt/goods-specs/search?query=${encodeURIComponent(specQuery)}`);
    if (!response.ok) {
      setSpecs([]);
      setError("商品规格搜索失败");
      return;
    }
    setSpecs((await response.json()) as WdtGoodsSpecSearchResultDto[]);
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
      note: current.note || "前端人工确认映射",
    }));
  }

  function chooseCandidate(candidate: ProductMatchCandidateDto) {
    setDraft({
      externalBarcode: candidate.externalBarcode,
      externalGoodsCode: candidate.externalGoodsCode,
      externalGoodsName: candidate.externalGoodsName,
      wdtSpecNo: candidate.wdtSpecNo,
      note: `候选确认：score=${candidate.score} basis=${candidate.basis}`,
    });
    setSpecQuery(candidate.wdtSpecNo);
  }

  useEffect(() => {
    void refreshMappings();
    void refreshCandidates();
  }, []);

  useEffect(() => {
    if (!focusQuery) return;
    setQuery(focusQuery);
    setSpecQuery(focusProduct?.externalGoodsName || focusQuery);
    setSpecs([]);
    if (focusProduct) {
      setDraft({
        externalBarcode: focusProduct.externalBarcode,
        externalGoodsCode: focusProduct.externalGoodsCode,
        externalGoodsName: focusProduct.externalGoodsName,
        wdtSpecNo: "",
        note: "审核异常行保存为长期映射",
      });
    }
    void refreshMappings(focusQuery);
    void refreshCandidates(focusQuery);
  }, [focusQuery, focusProduct]);

  const selectedSpec = useMemo(() => specs.find((spec) => spec.specNo === draft.wdtSpecNo), [draft.wdtSpecNo, specs]);
  const canSaveMapping = Boolean(draft.wdtSpecNo && (draft.externalBarcode || draft.externalGoodsCode));

  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4" id="product-mapping-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">商品映射确认</h2>
          <p className="mt-1 text-sm text-muted-foreground">把已核实的客户侧编码、小样或组合装保存为可复用规则</p>
        </div>
        <Badge tone="warn">保存后长期复用</Badge>
      </div>
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        名称候选只用于人工判断，不会自动通过；只有保存后的编号映射会在后续批次优先命中。
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-md border border-border p-3">
          <h3 className="text-sm font-semibold">候选查询</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              aria-label="旺店通商品搜索"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={specQuery}
              onChange={(event) => setSpecQuery(event.target.value)}
            />
            <Button className="h-9" onClick={() => void searchSpecs()}>
              <Search className="h-4 w-4" />
              搜索规格
            </Button>
          </div>
          <div className="mt-3 max-h-72 space-y-2 overflow-auto">
            {specs.length === 0 ? <div className="text-sm text-muted-foreground">输入名称、条码或规格编码搜索</div> : null}
            {specs.map((spec) => (
              <button
                key={spec.id}
                className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => chooseSpec(spec)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{spec.goodsName}</span>
                  <StockBadge stockError={spec.stockError} stockTotalAvailable={spec.stockTotalAvailable} />
                </div>
                <div className="mt-1 text-muted-foreground">
                  {spec.specNo} / {spec.specName} / {spec.barcode || "无主条码"}
                </div>
                <StockRows id={spec.id} rows={spec.stockRows} stockError={spec.stockError} />
              </button>
            ))}
          </div>
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
            <Field label="备注" value={draft.note} onChange={(value) => setDraft((current) => ({ ...current, note: value }))} />
          </div>
          {selectedSpec ? (
            <div className="mt-3 rounded-md bg-muted px-3 py-2 text-sm">
              已选：{selectedSpec.goodsName} / {selectedSpec.specName} / {selectedSpec.barcode}
            </div>
          ) : null}
          {error ? <div className="mt-3 text-sm text-rose-700">{error}</div> : null}
          <Button className="mt-3" disabled={!canSaveMapping} onClick={() => void confirmMapping()}>
            <Check className="h-4 w-4" />
            保存长期映射
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-4 rounded-md border border-border p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">待确认候选</h3>
            <Button
              className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80"
              onClick={() => void refreshCandidates()}
            >
              <Search className="h-4 w-4" />
              刷新候选
            </Button>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                className="rounded-md border border-border px-3 py-2 text-left text-sm transition hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                onClick={() => chooseCandidate(candidate)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{candidate.externalGoodsName || "未填名称"}</span>
                  <Badge tone="warn">{candidate.score}</Badge>
                  <Badge tone="info">{candidate.basis}</Badge>
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
            {candidates.length === 0 ? <div className="text-sm text-muted-foreground">暂无待确认候选</div> : null}
          </div>
        </div>

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
            <Button className="h-9 bg-muted text-muted-foreground hover:bg-muted/80" onClick={() => void refreshCandidates()}>
              候选
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
                      <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" onClick={() => void updateStatus(mapping, "needs_review")}>
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
