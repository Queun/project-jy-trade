import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { isConfirmedProductMappingMatch, type ReviewDecision, type ReviewLineDto } from "@jy-trade/shared";
import { Search } from "lucide-react";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { cn } from "@/lib/utils.js";

interface ReviewTableProps {
  rows: ReviewLineDto[];
  draftById: Record<string, ReviewDraft>;
  errorsById: Record<string, string>;
  confirmedOrderMode?: boolean;
  isDeveloperMode?: boolean;
  readOnly?: boolean;
  onDraftChange: (lineId: string, patch: Partial<ReviewDraft>) => void;
  onLocateMapping: (line: ReviewLineDto) => void;
  onPriorityChange: (line: ReviewLineDto, priority: boolean) => void;
  onSave: (line: ReviewLineDto) => void;
  onQuickDecision: (line: ReviewLineDto, decision: ReviewDecision) => void;
}

export interface ReviewDraft {
  decision: ReviewDecision;
  approvedShipQty: string;
  reason: string;
}

function statusTone(status: ReviewLineDto["status"], confirmedOrderMode = false) {
  if (confirmedOrderMode && status === "未匹配") return "warn";
  if (status === "库存充足") return "good";
  if (status === "部分满足") return "warn";
  if (status === "库存不足") return "bad";
  return "neutral";
}

function statusText(status: ReviewLineDto["status"], confirmedOrderMode = false) {
  if (!confirmedOrderMode) return status;
  if (status === "库存充足") return "可做单";
  if (status === "未匹配") return "缺商家编码";
  if (status === "库存不足") return "库存不足";
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
  isDeveloperMode = false,
  readOnly = false,
  onDraftChange,
  onLocateMapping,
  onPriorityChange,
  onSave,
  onQuickDecision,
}: ReviewTableProps) {
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

        return (
          <div className="min-w-60">
            <div className="font-medium">{line.externalGoodsName}</div>
            <div className="mt-1 text-xs text-muted-foreground">{line.externalBarcode}</div>
            {line.wdtSpecNo ? <div className="mt-1 text-xs text-muted-foreground">{line.wdtSpecNo}</div> : null}
            {manualMapping ? <Badge className="mt-2" tone="info">长期映射</Badge> : null}
            {needsMapping || manualMapping ? (
              <Button className="mt-2 h-7 bg-muted px-2 text-xs text-muted-foreground hover:bg-muted/80" onClick={() => onLocateMapping(line)}>
                <Search className="h-3.5 w-3.5" />
                {manualMapping ? "复查映射" : "定位映射"}
              </Button>
            ) : null}
          </div>
        );
      },
    },
    {
      header: "数量",
      cell: ({ row }) => (
        <div className="min-w-28 text-sm">
          <div>{confirmedOrderMode ? "确定" : "订货"} {row.original.orderQty}</div>
          <div className="mt-1 text-muted-foreground">{confirmedOrderMode ? "做单" : "建议"} {row.original.suggestedShipQty}</div>
          <div className="mt-1 text-muted-foreground">
            可发 主 {row.original.mainAvailableBefore} / 临 {row.original.nearExpiryAvailableBefore}
          </div>
        </div>
      ),
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
        const draft = draftById[line.id] ?? {
          decision: line.decision,
          approvedShipQty: String(line.approvedShipQty),
          reason: line.reason,
        };
        const error = errorsById[line.id];
        const approvedQty = Number(draft.approvedShipQty);
        const isOverSuggested = draft.decision === "ship" && Number.isFinite(approvedQty) && approvedQty > line.suggestedShipQty;
        const isDirty =
          draft.decision !== line.decision
          || draft.approvedShipQty !== String(line.approvedShipQty)
          || draft.reason !== line.reason;

        return (
          <div className="min-w-80 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={decisionTone(draft.decision)}>{decisionText(draft.decision, confirmedOrderMode)}</Badge>
              {line.priority ? <Badge tone="info">优先</Badge> : null}
              {isOverSuggested ? <Badge tone="warn">超建议数</Badge> : null}
              <Button className="h-8 px-2" disabled={readOnly} onClick={() => onQuickDecision(line, "ship")}>
                {confirmedOrderMode ? "做单" : "发货"}
              </Button>
              <Button
                className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80"
                disabled={readOnly}
                onClick={() => onQuickDecision(line, "do_not_ship")}
              >
                {confirmedOrderMode ? "不做单" : "不发"}
              </Button>
              <label className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-2 text-sm text-muted-foreground">
                <input
                  aria-label={`优先处理 ${line.id}`}
                  className="h-4 w-4"
                  checked={line.priority}
                  disabled={readOnly}
                  type="checkbox"
                  onChange={(event) => onPriorityChange(line, event.target.checked)}
                />
                优先处理
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label={`审核发货数 ${line.id}`}
                className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm"
                disabled={readOnly}
                inputMode="numeric"
                min={0}
                pattern="[0-9]*"
                step={1}
                type="text"
                value={draft.approvedShipQty}
                onChange={(event) => {
                  const value = event.target.value;
                  if (/^\d*$/.test(value)) onDraftChange(line.id, { approvedShipQty: value });
                }}
              />
              <input
                aria-label={`审核原因 ${line.id}`}
                className="h-9 min-w-52 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                disabled={readOnly}
                placeholder={confirmedOrderMode ? "处理备注" : "原因"}
                value={draft.reason}
                onChange={(event) => onDraftChange(line.id, { reason: event.target.value })}
              />
              {isDirty && !readOnly ? (
                <Button className="h-9 px-3" onClick={() => onSave(line)}>
                  保存
                </Button>
              ) : null}
            </div>
            {error ? <div className="text-xs text-rose-700">{error}</div> : null}
          </div>
        );
      },
    },
  ];
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

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
          {table.getRowModel().rows.map((row) => {
            const line = row.original;
            const decision = draftById[line.id]?.decision ?? line.decision;
            const tone = reviewRowTone(line, decision);

            return (
              <tr key={row.id} className={cn("border-t border-border transition-colors", tone.rowClass)} data-review-state={tone.key}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-3 align-top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
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
