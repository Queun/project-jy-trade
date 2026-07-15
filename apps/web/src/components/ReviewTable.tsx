import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { isConfirmedProductMappingMatch, type ReviewDecision, type ReviewLineDto, type WarehouseUsageSettingsDto } from "@jy-trade/shared";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { cn } from "@/lib/utils.js";

interface ReviewTableProps {
  rows: ReviewLineDto[];
  draftById: Record<string, ReviewDraft>;
  errorsById: Record<string, string>;
  confirmedOrderMode?: boolean;
  groupPendingMappings?: boolean;
  isDeveloperMode?: boolean;
  readOnly?: boolean;
  savingDecisionIds?: Set<string>;
  warehouseSettings?: WarehouseUsageSettingsDto | null;
  onDraftChange: (lineId: string, patch: Partial<ReviewDraft>) => void;
  onLocateMapping: (line: ReviewLineDto) => void;
  onPriorityChange: (line: ReviewLineDto, priority: boolean) => void;
  onSave: (line: ReviewLineDto) => void;
  onQuickDecision: (line: ReviewLineDto, decision: ReviewDecision) => void;
}

export interface ReviewDraft {
  decision: ReviewDecision;
  approvedShipQty: string;
  fulfillmentWarehouseNo: string;
  fulfillmentWarehouseName: string;
  reason: string;
}

interface WarehouseOption {
  warehouseNo: string;
  warehouseName: string;
  enabled: boolean;
}

function statusTone(status: ReviewLineDto["status"], confirmedOrderMode = false) {
  if (confirmedOrderMode && status === "未匹配") return "warn";
  if (status === "库存充足") return "good";
  if (status === "部分满足") return "warn";
  if (status === "库存未验证") return "warn";
  if (status === "库存不足") return "bad";
  return "neutral";
}

function statusText(status: ReviewLineDto["status"], confirmedOrderMode = false) {
  if (!confirmedOrderMode) return status;
  if (status === "库存充足") return "可做单";
  if (status === "未匹配") return "缺商家编码";
  if (status === "库存不足") return "库存不足";
  if (status === "库存未验证") return "库存待人工确认";
  return "库存可能不足";
}

function decisionTone(decision: ReviewDecision) {
  if (decision === "ship") return "good";
  if (decision === "do_not_ship") return "bad";
  return "neutral";
}

function decisionText(decision: ReviewDecision, confirmedOrderMode = false) {
  if (decision === "ship") return confirmedOrderMode ? "做单" : "发货";
  if (decision === "do_not_ship") return confirmedOrderMode ? "不做单" : "不发";
  return confirmedOrderMode ? "待补全" : "待审核";
}

function matchStatusText(matchStatus: ReviewLineDto["matchStatus"], confirmedOrderMode = false) {
  if (confirmedOrderMode) {
    if (matchStatus === "matched") return "字段已补全";
    if (matchStatus === "ambiguous") return "需选择商家编码";
    if (matchStatus === "not_found") return "缺商家编码";
    return "校验异常";
  }
  if (matchStatus === "matched") return "已匹配";
  if (matchStatus === "ambiguous") return "待确认";
  if (matchStatus === "not_found") return "未匹配";
  return "匹配异常";
}

function isManualMappingLine(line: ReviewLineDto) {
  return isConfirmedProductMappingMatch(line.matchMessage);
}

function confirmedOrderSystemNotice(line: ReviewLineDto) {
  return line.matchMessage
    .split("；")
    .map((part) => part.trim())
    .find((part) => part.startsWith("确定单")) ?? "";
}

function reviewRowTone(line: ReviewLineDto, decision: ReviewDecision) {
  if (decision === "do_not_ship") {
    return {
      key: "do_not_ship",
      rowClass: "bg-rose-50/70 hover:bg-rose-50",
    };
  }
  if (line.matchStatus !== "matched" || line.status === "未匹配") {
    return {
      key: "unmatched",
      rowClass: "bg-sky-50/60 hover:bg-sky-50",
    };
  }
  if (line.status === "库存不足") {
    return {
      key: "out_of_stock",
      rowClass: "bg-red-50/60 hover:bg-red-50",
    };
  }
  if (line.status === "部分满足") {
    return {
      key: "partial",
      rowClass: "bg-amber-50/70 hover:bg-amber-50",
    };
  }
  if (line.status === "库存未验证") {
    return {
      key: "unverified_stock",
      rowClass: "bg-amber-50/70 hover:bg-amber-50",
    };
  }
  if (decision === "ship") {
    return {
      key: "ship",
      rowClass: "bg-emerald-50/70 hover:bg-emerald-50",
    };
  }
  if (line.status === "库存充足") {
    return {
      key: "ready",
      rowClass: "bg-emerald-50/35 hover:bg-emerald-50/60",
    };
  }
  return {
    key: "pending",
    rowClass: "bg-background hover:bg-muted/30",
  };
}

export function ReviewTable({
  rows,
  draftById,
  errorsById,
  confirmedOrderMode = false,
  groupPendingMappings = false,
  isDeveloperMode = false,
  readOnly = false,
  savingDecisionIds = new Set<string>(),
  warehouseSettings = null,
  onDraftChange,
  onLocateMapping,
  onPriorityChange,
  onSave,
  onQuickDecision,
}: ReviewTableProps) {
  const [expandedComponentLineIds, setExpandedComponentLineIds] = useState<Set<string>>(() => new Set());
  const columns: Array<ColumnDef<ReviewLineDto>> = [
    {
      header: "门店 / 订单",
      cell: ({ row }) => (
        <div className="min-w-36">
          <div className="font-medium">{row.original.storeName}</div>
          <div className="mt-1 text-xs text-muted-foreground">{row.original.orderNoticeNo}</div>
        </div>
      ),
    },
    {
      header: "商品",
      cell: ({ row }) => {
        const line = row.original;
        const needsMapping = line.matchStatus !== "matched";
        const manualMapping = isManualMappingLine(line);
        const canReviewAlternative = confirmedOrderMode && line.matchStatus === "matched" && (line.status === "库存不足" || line.status === "部分满足");
        const showMappingAction = !groupPendingMappings && (needsMapping || manualMapping || canReviewAlternative);
        const mappingActionLabel = canReviewAlternative ? "查替代编码" : manualMapping ? "复查映射" : "定位映射";

        return (
          <div className="min-w-60">
            <div className="font-medium">{line.externalGoodsName}</div>
            <div className="mt-1 text-xs text-muted-foreground">{line.externalBarcode}</div>
            {line.wdtSpecNo ? <div className="mt-1 text-xs text-muted-foreground">{line.wdtSpecNo}</div> : null}
            {line.productType === "suite" && (line.componentStocks?.length ?? 0) > 0 ? (
              <button
                aria-expanded={expandedComponentLineIds.has(line.id)}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary"
                onClick={() => toggleComponentLine(line.id)}
              >
                {expandedComponentLineIds.has(line.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {line.componentStocks?.length} 个组合装组件
              </button>
            ) : null}
            {manualMapping ? <Badge className="mt-2" tone="info">长期映射</Badge> : null}
            {showMappingAction ? (
              <Button className="mt-2 h-7 bg-muted px-2 text-xs text-muted-foreground hover:bg-muted/80" onClick={() => onLocateMapping(line)}>
                <Search className="h-3.5 w-3.5" />
                {mappingActionLabel}
              </Button>
            ) : null}
          </div>
        );
      },
    },
    {
      header: "数量",
      cell: ({ row }) => {
        const line = row.original;
        return (
          <div className="min-w-36 text-sm">
            {confirmedOrderMode ? (
              <>
                <div><span className="text-muted-foreground">订货</span> <span className="font-medium">{line.orderQty}</span></div>
                <div className="mt-1"><span className="text-muted-foreground">发货</span> <span className="font-medium">{line.plannedShipQty}</span></div>
                <div className="mt-1"><span className="text-muted-foreground">系统建议</span> <span className="font-medium">{line.suggestedShipQty}</span></div>
              </>
            ) : (
              <>
                <div>订货 {line.orderQty}</div>
                <div className="mt-1 text-muted-foreground">建议 {line.suggestedShipQty}</div>
              </>
            )}
            <div className="mt-1 text-muted-foreground">建议仓 {line.suggestedWarehouseName || "暂无建议"}</div>
            <div className="mt-1 text-muted-foreground">可发 主 {line.mainAvailableBefore} / 临 {line.nearExpiryAvailableBefore}</div>
          </div>
        );
      },
    },
    {
      header: "状态",
      cell: ({ row }) => {
        const notice = confirmedOrderMode ? confirmedOrderSystemNotice(row.original) : "";
        const stockErrorDetail = confirmedOrderMode && isDeveloperMode ? row.original.stockErrorDetail?.trim() ?? "" : "";
        return (
          <div className="flex min-w-40 flex-col items-start gap-2">
            <Badge tone={statusTone(row.original.status, confirmedOrderMode)}>{statusText(row.original.status, confirmedOrderMode)}</Badge>
            <Badge tone={row.original.matchStatus === "matched" ? "info" : "warn"}>{matchStatusText(row.original.matchStatus, confirmedOrderMode)}</Badge>
            {notice ? <div className="max-w-64 text-xs leading-5 text-amber-800">{notice}</div> : null}
            {stockErrorDetail ? <div className="max-w-64 text-xs leading-5 text-muted-foreground">库存查询详情：{stockErrorDetail}</div> : null}
          </div>
        );
      },
    },
    {
      header: confirmedOrderMode ? "做单处理" : "审核",
      cell: ({ row }) => {
        const line = row.original;
        const persistedWarehouseNo = line.fulfillmentWarehouseNo || (line.decision === "do_not_ship" ? "" : line.suggestedWarehouseNo);
        const persistedWarehouseName = line.fulfillmentWarehouseName || (line.decision === "do_not_ship" ? "" : line.suggestedWarehouseName);
        const draft = draftById[line.id] ?? {
          decision: line.decision,
          approvedShipQty: String(line.approvedShipQty),
          fulfillmentWarehouseNo: persistedWarehouseNo,
          fulfillmentWarehouseName: persistedWarehouseName,
          reason: line.reason,
        };
        const warehouseOptions = warehouseOptionsFor(line, warehouseSettings);
        const error = errorsById[line.id];
        const approvedQty = Number(draft.approvedShipQty);
        const isOverSuggested = draft.decision === "ship" && Number.isFinite(approvedQty) && approvedQty > line.suggestedShipQty;
        const isOverPlanned = confirmedOrderMode && draft.decision === "ship" && Number.isFinite(approvedQty) && approvedQty > line.plannedShipQty;
        const isNonSuggestedWarehouse = draft.decision === "ship"
          && Boolean(draft.fulfillmentWarehouseNo)
          && Boolean(line.suggestedWarehouseNo)
          && draft.fulfillmentWarehouseNo !== line.suggestedWarehouseNo;
        const isInvalidWarehouse = draft.decision === "ship"
          && approvedQty > 0
          && Boolean(draft.fulfillmentWarehouseNo)
          && !warehouseEnabled(draft.fulfillmentWarehouseNo, draft.fulfillmentWarehouseName, warehouseSettings);
        const isSaving = savingDecisionIds.has(line.id);
        const isDirty =
          draft.decision !== line.decision
          || draft.approvedShipQty !== String(line.approvedShipQty)
          || draft.fulfillmentWarehouseNo !== persistedWarehouseNo
          || draft.fulfillmentWarehouseName !== persistedWarehouseName
          || draft.reason !== line.reason;

        return (
          <div className="min-w-80 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={decisionTone(draft.decision)}>{decisionText(draft.decision, confirmedOrderMode)}</Badge>
              {line.priority ? <Badge tone="info">优先</Badge> : null}
              {isOverSuggested ? <Badge tone="warn">超系统建议</Badge> : null}
              {isOverPlanned ? <Badge tone="warn">偏离原计划</Badge> : null}
              {isNonSuggestedWarehouse ? <Badge tone="warn">非建议仓库</Badge> : null}
              <Button className="h-8 px-2" disabled={readOnly || isSaving} onClick={() => onQuickDecision(line, "ship")}>
                {confirmedOrderMode ? "做单" : "发货"}
              </Button>
              <Button
                className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80"
                disabled={readOnly || isSaving}
                onClick={() => onQuickDecision(line, "do_not_ship")}
              >
                {confirmedOrderMode ? "不做单" : "不发"}
              </Button>
              <label className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-2 text-sm text-muted-foreground">
                <input
                  aria-label={`优先处理 ${line.id}`}
                  className="h-4 w-4"
                  checked={line.priority}
                  disabled={readOnly || isSaving}
                  type="checkbox"
                  onChange={(event) => onPriorityChange(line, event.target.checked)}
                />
                优先处理
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>最终仓库</span>
                <select
                  aria-label={`发货仓库 ${line.id}`}
                  className="h-9 min-w-32 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  disabled={readOnly || isSaving || draft.decision === "do_not_ship"}
                  value={draft.fulfillmentWarehouseNo}
                  onChange={(event) => {
                    const warehouse = warehouseOptions.find((option) => option.warehouseNo === event.target.value);
                    onDraftChange(line.id, {
                      fulfillmentWarehouseNo: warehouse?.warehouseNo ?? "",
                      fulfillmentWarehouseName: warehouse?.warehouseName ?? "",
                    });
                  }}
                >
                  <option value="">选择仓库</option>
                  {warehouseOptions.map((warehouse) => (
                    <option key={`${warehouse.warehouseNo}-${warehouse.warehouseName}`} value={warehouse.warehouseNo}>
                      {warehouse.warehouseName}{warehouse.enabled ? "" : "（当前已停用）"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>最终发货数量</span>
                <input
                  aria-label={`审核发货数 ${line.id}`}
                  className="h-9 w-24 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  disabled={readOnly || isSaving}
                  inputMode="numeric"
                  min={0}
                  pattern="[0-9]*"
                  step={1}
                  type="text"
                  value={draft.approvedShipQty}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (/^\d*$/.test(value)) {
                      onDraftChange(line.id, {
                        approvedShipQty: value,
                        decision: value !== "" && Number(value) > 0 ? "ship" : draft.decision,
                      });
                    }
                  }}
                />
              </label>
              <input
                aria-label={`审核原因 ${line.id}`}
                className="h-9 min-w-52 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                disabled={readOnly || isSaving}
                placeholder={confirmedOrderMode ? "处理备注" : "原因"}
                value={draft.reason}
                onChange={(event) => onDraftChange(line.id, { reason: event.target.value })}
              />
              {isDirty && !readOnly ? (
                <Button className="h-9 px-3" disabled={isSaving} onClick={() => onSave(line)}>
                  {isSaving ? "保存中..." : "保存"}
                </Button>
              ) : null}
            </div>
            <div className="space-y-1 text-xs leading-5 text-amber-800">
              {isOverSuggested ? <div>最终数量超过系统建议，可能存在库存风险。</div> : null}
              {isOverPlanned ? <div>最终数量超过确定单发货数量，已偏离原计划。</div> : null}
              {isNonSuggestedWarehouse ? <div>最终仓库与系统建议不同，请确认人工调整。</div> : null}
              {isInvalidWarehouse ? <div className="text-rose-700">所选仓库当前未启用，提交审核前必须重新选择。</div> : null}
            </div>
            {error ? <div className="text-xs text-rose-700">{error}</div> : null}
          </div>
        );
      },
    },
  ];
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(() => new Set());
  const pendingMappingGroups = useMemo(() => groupPendingMappingRows(rows), [rows]);
  const tableRowsByLineId = new Map(table.getRowModel().rows.map((row) => [row.original.id, row]));

  function toggleGroup(groupKey: string) {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  function toggleComponentLine(lineId: string) {
    setExpandedComponentLineIds((current) => {
      const next = new Set(current);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  function renderReviewRow(row: ReturnType<typeof table.getRowModel>["rows"][number], grouped = false) {
    const line = row.original;
    const decision = draftById[line.id]?.decision ?? line.decision;
    const tone = reviewRowTone(line, decision);
    return (
      <Fragment key={line.id}>
        <tr className={cn("border-t border-border transition-colors", tone.rowClass)} data-review-state={tone.key}>
          {row.getVisibleCells().map((cell, index) => (
            <td key={cell.id} className={cn("px-3 py-3 align-top", grouped && index === 0 && "pl-9")}>
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </td>
          ))}
        </tr>
        {expandedComponentLineIds.has(line.id) ? (
          <tr className="border-t border-border bg-muted/20">
            <td className="px-4 py-3" colSpan={columns.length}>
              <ComponentStockDetails line={line} />
            </td>
          </tr>
        ) : null}
      </Fragment>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full min-w-[1080px] border-collapse text-sm">
        <thead className="bg-muted text-muted-foreground">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-3 py-2 text-left font-medium">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {groupPendingMappings
            ? pendingMappingGroups.map((group) => {
                const expanded = expandedGroupKeys.has(group.key);
                const representative = group.rows[0];
                return (
                  <Fragment key={group.key}>
                    <tr className="border-t border-border bg-muted/35">
                      <td className="px-3 py-3" colSpan={columns.length}>
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "收起" : "展开"} ${representative.externalGoodsName}`}
                            className="flex min-w-0 items-start gap-2 text-left"
                            onClick={() => toggleGroup(group.key)}
                          >
                            {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
                            <span className="min-w-0">
                              <span className="block font-semibold text-foreground">{representative.externalGoodsName || "未命名商品"}</span>
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {group.identityLabel} · {group.rows.length} 条订单 · {group.storeCount} 个门店
                              </span>
                            </span>
                          </button>
                          <Button className="h-8 shrink-0 bg-muted px-2 text-xs text-muted-foreground hover:bg-muted/80" onClick={() => onLocateMapping(representative)}>
                            <Search className="h-3.5 w-3.5" />
                            定位映射
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {expanded
                      ? group.rows.map((line) => {
                          const row = tableRowsByLineId.get(line.id);
                          return row ? renderReviewRow(row, true) : null;
                        })
                      : null}
                  </Fragment>
                );
              })
            : table.getRowModel().rows.map((row) => renderReviewRow(row))}
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-8 text-center text-sm text-muted-foreground" colSpan={columns.length}>
                当前筛选条件下没有明细
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function ComponentStockDetails({ line }: { line: ReviewLineDto }) {
  const components = line.componentStocks ?? [];
  const selectedWarehouseNo = line.suggestedWarehouseNo || line.fulfillmentWarehouseNo;
  const capacities = components.map((component) => {
    const warehouseStock = selectedWarehouseNo
      ? component.warehouses.find((warehouse) => warehouse.warehouseNo === selectedWarehouseNo)?.availableStock ?? 0
      : component.mainAvailableStock;
    return Math.floor((warehouseStock + 1e-9) / component.quantityPerItem);
  });
  const bottleneck = capacities.length > 0 ? Math.min(...capacities) : 0;
  return (
    <div className="min-w-[760px]">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">组合装组件库存</span>
        <span>{selectedWarehouseNo ? `按建议仓 ${line.suggestedWarehouseName || selectedWarehouseNo} 计算` : "当前无建议仓，按主仓查看"}</span>
      </div>
      <div className="grid grid-cols-[minmax(220px,1fr)_90px_100px_100px_minmax(240px,1.2fr)] gap-x-3 border-b border-border pb-1 text-xs font-medium text-muted-foreground">
        <span>组件</span><span>每套用量</span><span>主仓</span><span>临期仓</span><span>分仓库存</span>
      </div>
      {components.map((component, index) => (
        <div key={`${component.specNo}-${index}`} className="grid grid-cols-[minmax(220px,1fr)_90px_100px_100px_minmax(240px,1.2fr)] gap-x-3 border-b border-border/60 py-2 text-xs last:border-0">
          <span>
            <span className="block font-medium">{component.goodsName || component.specNo}</span>
            <span className="mt-0.5 block text-muted-foreground">{component.specNo}{component.specName ? ` · ${component.specName}` : ""}</span>
            {!component.stockVerified ? <Badge className="mt-1" tone="warn">库存未验证</Badge> : capacities[index] === bottleneck ? <Badge className="mt-1" tone="warn">瓶颈组件</Badge> : null}
          </span>
          <span>{component.quantityPerItem}</span>
          <span>{component.mainAvailableStock}</span>
          <span>{component.nearExpiryAvailableStock}</span>
          <span className="text-muted-foreground">
            {component.warehouses.length > 0
              ? component.warehouses.map((warehouse) => `${warehouse.warehouseName || warehouse.warehouseNo} ${warehouse.availableStock}`).join(" / ")
              : "无可发库存"}
          </span>
        </div>
      ))}
    </div>
  );
}

interface PendingMappingGroup {
  key: string;
  identityLabel: string;
  rows: ReviewLineDto[];
  storeCount: number;
}

function groupPendingMappingRows(rows: ReviewLineDto[]): PendingMappingGroup[] {
  const groups = new Map<string, ReviewLineDto[]>();
  for (const line of rows) {
    const key = pendingMappingGroupKey(line);
    const groupRows = groups.get(key);
    if (groupRows) groupRows.push(line);
    else groups.set(key, [line]);
  }
  return [...groups.entries()].map(([key, groupRows]) => {
    const representative = groupRows[0];
    const goodsCode = representative.externalGoodsCode.trim();
    const barcode = representative.externalBarcode.trim();
    return {
      key,
      identityLabel: goodsCode ? `货品码 ${goodsCode}` : barcode ? `条码 ${barcode}` : `Excel 第 ${representative.excelRow} 行`,
      rows: groupRows,
      storeCount: new Set(groupRows.map((line) => `${line.storeNo}\u0000${line.storeName}`)).size,
    };
  });
}

function pendingMappingGroupKey(line: ReviewLineDto) {
  const goodsCode = line.externalGoodsCode.trim();
  if (goodsCode) return `goods-code:${goodsCode}`;
  const barcode = line.externalBarcode.trim();
  if (barcode) return `barcode:${barcode}`;
  return `line:${line.id}`;
}

function warehouseOptionsFor(line: ReviewLineDto, settings: WarehouseUsageSettingsDto | null): WarehouseOption[] {
  const candidates = [
    { warehouseNo: "001", warehouseName: "主仓" },
    { warehouseNo: "LINQI", warehouseName: "临期仓" },
    { warehouseNo: "CIPIN", warehouseName: "次品仓" },
    { warehouseNo: line.suggestedWarehouseNo, warehouseName: line.suggestedWarehouseName },
    { warehouseNo: line.fulfillmentWarehouseNo, warehouseName: line.fulfillmentWarehouseName },
  ];
  const seen = new Set<string>();
  return candidates.flatMap<WarehouseOption>((candidate) => {
    if (!candidate.warehouseNo || !candidate.warehouseName || seen.has(candidate.warehouseNo)) return [];
    seen.add(candidate.warehouseNo);
    const enabled = warehouseEnabled(candidate.warehouseNo, candidate.warehouseName, settings);
    const isPersistedWarehouse = candidate.warehouseNo === line.fulfillmentWarehouseNo;
    const isSuggestedWarehouse = candidate.warehouseNo === line.suggestedWarehouseNo;
    return enabled || isPersistedWarehouse || isSuggestedWarehouse ? [{ ...candidate, enabled }] : [];
  });
}

function warehouseEnabled(warehouseNo: string, warehouseName: string, settings: WarehouseUsageSettingsDto | null) {
  if (!settings) return true;
  const normalizedNo = warehouseNo.trim().toUpperCase();
  const normalizedName = warehouseName.trim();
  if (normalizedNo === "001" || normalizedName.includes("主仓")) return settings.includeMainWarehouse;
  if (normalizedNo === "LINQI" || normalizedName.includes("临期")) return settings.includeNearExpiryWarehouse;
  if (normalizedNo === "CIPIN" || normalizedName.includes("次品")) return settings.includeDefectWarehouse;
  return settings.includeOtherWarehouses;
}
