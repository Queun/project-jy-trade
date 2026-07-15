import { useEffect, useState } from "react";
import { Check, PackageSearch, Search, Upload, X } from "lucide-react";
import type { ExternalProductDto, ImportExternalProductsPreviewResponse, ImportExternalProductsResponse } from "@jy-trade/shared";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

interface ExternalProductPanelProps {
  canEdit: boolean;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}

export function ExternalProductPanel({ canEdit, onError, onMessage }: ExternalProductPanelProps) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<ExternalProductDto[]>([]);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importDraft, setImportDraft] = useState<{ fileName: string; contentBase64: string } | null>(null);
  const [importPreview, setImportPreview] = useState<ImportExternalProductsPreviewResponse | null>(null);

  function reportError(message: string) {
    setError(message);
    onError(message);
  }

  async function refreshProducts(nextQuery = query) {
    const response = await fetch(`/api/v1/external-products?query=${encodeURIComponent(nextQuery)}`);
    if (!response.ok) {
      setProducts([]);
      return;
    }
    setProducts((await response.json()) as ExternalProductDto[]);
  }

  async function importWorkbook(file: File) {
    setError("");
    setImporting(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const nextImportDraft = { fileName: file.name, contentBase64 };
      const response = await fetch("/api/v1/external-products/import-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextImportDraft),
      });
      if (!response.ok) {
        const body = await response.json();
        reportError(body.message ?? "商品维护表解析失败");
        return;
      }
      const preview = (await response.json()) as ImportExternalProductsPreviewResponse;
      setImportDraft(nextImportDraft);
      setImportPreview(preview);
      onMessage(`已解析 ${preview.parsedProductCount} 个维护商品，新增 ${preview.createCount} 个，更新 ${preview.updateCount} 个，需复查 ${preview.needsReviewCount} 个`);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "商品维护表解析失败");
    } finally {
      setImporting(false);
    }
  }

  async function confirmImportWorkbook() {
    if (!importDraft || !importPreview) return;
    setError("");
    setImporting(true);
    try {
      const response = await fetch("/api/v1/external-products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(importDraft),
      });
      if (!response.ok) {
        const body = await response.json();
        reportError(body.message ?? "商品维护表导入失败");
        return;
      }
      const result = (await response.json()) as ImportExternalProductsResponse;
      setQuery("");
      await refreshProducts("");
      setImportDraft(null);
      setImportPreview(null);
      onMessage(`已导入 ${result.importedProductCount} 个维护商品、${result.importedComponentCount} 个组件，需复查 ${result.needsReviewCount} 个`);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "商品维护表导入失败");
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    void refreshProducts();
  }, []);

  const hasImportChanges = Boolean(importPreview && (importPreview.createCount > 0 || importPreview.updateCount > 0));
  const visiblePreviewItems = importPreview?.items.filter((item) => item.action !== "unchanged").slice(0, 6) ?? [];

  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PackageSearch className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">小样和套盒维护</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">维护表只用于后续商品匹配依据，当前不会自动改动库存初审结果。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className={`inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border px-2 text-sm ${canEdit ? "cursor-pointer bg-background hover:bg-muted" : "cursor-not-allowed bg-muted text-muted-foreground"}`}>
            <Upload className="h-4 w-4" />
            {importing ? "处理中" : "导入维护 Excel"}
            <input
              className="sr-only"
              disabled={!canEdit || importing}
              type="file"
              accept=".xls,.xlsx"
              aria-label="导入商品维护 Excel"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importWorkbook(file);
              }}
            />
          </label>
          <Badge tone={canEdit ? "info" : "neutral"}>{canEdit ? "可编辑" : "只读"}</Badge>
        </div>
      </div>

      {importPreview ? (
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">商品维护导入预览</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {importPreview.fileName} / {importPreview.sheetCount} 个工作表 / {importPreview.parsedProductCount} 个维护商品 / {importPreview.parsedComponentCount} 个组件
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="good">新增 {importPreview.createCount}</Badge>
              <Badge tone="info">更新 {importPreview.updateCount}</Badge>
              <Badge tone="neutral">不变 {importPreview.unchangedCount}</Badge>
              <Badge tone={importPreview.needsReviewCount > 0 ? "warn" : "good"}>需复查 {importPreview.needsReviewCount}</Badge>
            </div>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {visiblePreviewItems.map((item) => (
              <div key={`${item.type}-${item.externalBarcode}-${item.externalGoodsCode}-${item.externalGoodsName}-${item.sourceSheet}-${item.sourceRow}`} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.externalGoodsName || item.externalBarcode || item.externalGoodsCode}</div>
                    <div className="mt-1 text-muted-foreground">{item.externalBarcode || item.externalGoodsCode || "无外部编号"}</div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <Badge tone={item.action === "create" ? "good" : "info"}>{item.action === "create" ? "新增" : "更新"}</Badge>
                    <Badge tone={item.status === "confirmed" ? "good" : "warn"}>{item.status === "confirmed" ? "已确认" : "需复查"}</Badge>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{typeText(item.type)}</span>
                  <span>{item.componentCount} 个组件</span>
                  <span>{item.sourceSheet} 第 {item.sourceRow} 行</span>
                </div>
                <div className="mt-2 grid gap-1">
                  {item.components.slice(0, 3).map((component, index) => (
                    <div key={`${component.role}-${component.componentBarcode}-${component.componentGoodsCode}-${index}`} className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-xs">
                      <span className="min-w-0 truncate">
                        {roleText(component.role)}：{component.componentBarcode || component.componentGoodsCode || component.componentName || "缺编号"}
                      </span>
                      <Badge tone={matchStatusTone(component.matchStatus)}>{matchStatusText(component.matchStatus)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {importPreview.items.filter((item) => item.action !== "unchanged").length > 6 ? (
            <div className="mt-2 text-sm text-muted-foreground">还有 {importPreview.items.filter((item) => item.action !== "unchanged").length - 6} 个变更未展示</div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button disabled={!canEdit || importing || !hasImportChanges} onClick={() => void confirmImportWorkbook()}>
              <Check className="h-4 w-4" />
              确认导入维护表
            </Button>
            <Button className="bg-muted text-muted-foreground hover:bg-muted/80" disabled={importing} onClick={() => { setImportDraft(null); setImportPreview(null); }}>
              <X className="h-4 w-4" />
              取消
            </Button>
            {!hasImportChanges ? <span className="text-sm text-muted-foreground">没有需要更新的维护商品。</span> : null}
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <input
            aria-label="商品维护查询"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            placeholder="外部条码、商品编码或商品名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button className="h-9" onClick={() => void refreshProducts()}>
            <Search className="h-4 w-4" />
            查询
          </Button>
        </div>
        <div className="mt-3 max-w-full overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[980px] border-collapse text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">维护商品</th>
                <th className="px-3 py-2 text-left font-medium">组件匹配</th>
                <th className="px-3 py-2 text-left font-medium">来源</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id} className="border-t border-border">
                  <td className="px-3 py-3 align-top">
                    <div className="font-medium">{product.externalGoodsName || product.externalBarcode || product.externalGoodsCode}</div>
                    <div className="mt-1 text-muted-foreground">{typeText(product.type)} / {product.externalBarcode || product.externalGoodsCode || "无外部编号"}</div>
                    {product.note ? <div className="mt-1 text-xs text-muted-foreground">{product.note}</div> : null}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="grid gap-1">
                      {product.components.slice(0, 4).map((component) => (
                        <div key={component.id} className="rounded bg-muted px-2 py-1 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate">
                              {roleText(component.role)}：{component.componentBarcode || component.componentGoodsCode || component.componentName || "缺编号"}
                            </span>
                            <Badge tone={matchStatusTone(component.matchStatus)}>{matchStatusText(component.matchStatus)}</Badge>
                          </div>
                          {component.wdtSpecNo ? <div className="mt-1 text-muted-foreground">WDT：{component.wdtSpecNo} / {component.wdtGoodsName || "-"}</div> : null}
                        </div>
                      ))}
                    </div>
                    {product.components.length > 4 ? <div className="mt-1 text-xs text-muted-foreground">还有 {product.components.length - 4} 个组件</div> : null}
                  </td>
                  <td className="px-3 py-3 align-top text-muted-foreground">
                    <div>{product.sourceSheet || product.sourceFileName || "手工维护"}</div>
                    {product.sourceRow ? <div className="mt-1">第 {product.sourceRow} 行</div> : null}
                    <div className="mt-1">{formatShortDate(product.updatedAt)}</div>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <Badge tone={product.status === "confirmed" ? "good" : product.status === "disabled" ? "neutral" : "warn"}>
                      {product.status === "confirmed" ? "已确认" : product.status === "disabled" ? "已停用" : "需复查"}
                    </Badge>
                  </td>
                </tr>
              ))}
              {products.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-muted-foreground" colSpan={4}>
                    暂无维护商品
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {error ? <div className="mt-3 text-sm text-rose-700">{error}</div> : null}
      {!canEdit ? <div className="mt-3 text-sm text-muted-foreground">当前账号只能查看维护商品。</div> : null}
    </section>
  );
}

function typeText(type: ExternalProductDto["type"]) {
  if (type === "sample") return "小样";
  if (type === "bundle") return "套盒";
  if (type === "gift") return "赠品";
  return "普通商品";
}

function roleText(role: ExternalProductDto["components"][number]["role"]) {
  if (role === "replacement") return "替换";
  if (role === "extra") return "额外";
  return "主件";
}

function matchStatusText(status: ExternalProductDto["components"][number]["matchStatus"]) {
  if (status === "unique_wdt_hit") return "唯一命中";
  if (status === "ambiguous_wdt_hit") return "多规格";
  if (status === "deleted_only_wdt_hit") return "已删除";
  if (status === "no_wdt_hit") return "未命中";
  return "需复查";
}

function matchStatusTone(status: ExternalProductDto["components"][number]["matchStatus"]): "neutral" | "good" | "warn" | "bad" | "info" {
  if (status === "unique_wdt_hit") return "good";
  if (status === "no_wdt_hit") return "bad";
  if (status === "needs_review") return "warn";
  return "info";
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
