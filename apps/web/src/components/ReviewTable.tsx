import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type { ReviewDecision, ReviewLineDto } from "@jy-trade/shared";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

interface ReviewTableProps {
  rows: ReviewLineDto[];
  draftById: Record<string, ReviewDraft>;
  errorsById: Record<string, string>;
  savingReasonById: Record<string, boolean>;
  readOnly?: boolean;
  onDraftChange: (lineId: string, patch: Partial<ReviewDraft>) => void;
  onPriorityChange: (line: ReviewLineDto, priority: boolean) => void;
  onSave: (line: ReviewLineDto) => void;
  onReasonSave: (line: ReviewLineDto, reason: string) => void;
  onQuickDecision: (line: ReviewLineDto, decision: ReviewDecision) => void;
}

export interface ReviewDraft {
  decision: ReviewDecision;
  approvedShipQty: string;
  reason: string;
}

function statusTone(status: ReviewLineDto["status"]) {
  if (status === "库存充足") return "good";
  if (status === "部分满足") return "warn";
  if (status === "库存不足") return "bad";
  return "neutral";
}

function decisionTone(decision: ReviewDecision) {
  if (decision === "ship") return "good";
  if (decision === "do_not_ship") return "bad";
  return "neutral";
}

function decisionText(decision: ReviewDecision) {
  if (decision === "ship") return "发货";
  if (decision === "do_not_ship") return "不发";
  return "待审核";
}

export function ReviewTable({
  rows,
  draftById,
  errorsById,
  savingReasonById,
  readOnly = false,
  onDraftChange,
  onPriorityChange,
  onReasonSave,
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
      cell: ({ row }) => (
        <div className="min-w-60">
          <div className="font-medium">{row.original.externalGoodsName}</div>
          <div className="mt-1 text-xs text-muted-foreground">{row.original.externalBarcode}</div>
          {row.original.wdtSpecNo ? <div className="mt-1 text-xs text-muted-foreground">{row.original.wdtSpecNo}</div> : null}
        </div>
      ),
    },
    {
      header: "数量",
      cell: ({ row }) => (
        <div className="min-w-28 text-sm">
          <div>订货 {row.original.orderQty}</div>
          <div className="mt-1 text-muted-foreground">建议 {row.original.suggestedShipQty}</div>
          <div className="mt-1 text-muted-foreground">
            主 {row.original.mainAvailableBefore} / 临 {row.original.nearExpiryAvailableBefore}
          </div>
        </div>
      ),
    },
    {
      header: "状态",
      cell: ({ row }) => (
        <div className="flex min-w-28 flex-col items-start gap-2">
          <Badge tone={statusTone(row.original.status)}>{row.original.status}</Badge>
          <Badge tone={row.original.matchStatus === "matched" ? "info" : "warn"}>{row.original.matchStatus}</Badge>
        </div>
      ),
    },
    {
      header: "审核",
      cell: ({ row }) => {
        const line = row.original;
        const draft = draftById[line.id] ?? {
          decision: line.decision,
          approvedShipQty: String(line.approvedShipQty),
          reason: line.reason,
        };
        const error = errorsById[line.id];
        const isSavingReason = Boolean(savingReasonById[line.id]);
        const approvedQty = Number(draft.approvedShipQty);
        const isOverSuggested = draft.decision === "ship" && Number.isFinite(approvedQty) && approvedQty > line.suggestedShipQty;

        return (
          <div className="min-w-80 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={decisionTone(draft.decision)}>{decisionText(draft.decision)}</Badge>
              {line.priority ? <Badge tone="info">优先</Badge> : null}
              {isOverSuggested ? <Badge tone="warn">超建议数</Badge> : null}
              <Button className="h-8 px-2" disabled={readOnly} onClick={() => onQuickDecision(line, "ship")}>
                发货
              </Button>
              <Button
                className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80"
                disabled={readOnly}
                onClick={() => onQuickDecision(line, "do_not_ship")}
              >
                不发
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
            <div className="grid gap-2 sm:grid-cols-[120px_1fr_auto]">
              <input
                aria-label={`审核发货数 ${line.id}`}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                disabled={readOnly}
                min={0}
                type="number"
                value={draft.approvedShipQty}
                onChange={(event) => onDraftChange(line.id, { approvedShipQty: event.target.value })}
              />
              <input
                aria-label={`审核原因 ${line.id}`}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                disabled={readOnly}
                placeholder="原因"
                value={draft.reason}
                onChange={(event) => {
                  onDraftChange(line.id, { reason: event.target.value });
                  onReasonSave(line, event.target.value);
                }}
              />
              <Button className="h-9 px-3" disabled={readOnly} onClick={() => onSave(line)}>
                保存数量
              </Button>
            </div>
            {isSavingReason ? <div className="text-xs text-muted-foreground">原因保存中...</div> : null}
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
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-t border-border">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-3 align-top">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
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
