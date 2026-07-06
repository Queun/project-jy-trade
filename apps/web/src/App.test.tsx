import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type {
  BatchSummary,
  ExportDto,
  ProductMappingDto,
  ProductMatchCandidateDto,
  ReviewLineDto,
  WdtGoodsSpecSearchResultDto,
  WdtGoodsSyncRunDto,
} from "@jy-trade/shared";

const batch: BatchSummary = {
  id: "batch-1",
  fileName: "订货通知单 .xls",
  mode: "mock",
  status: "review_generated",
  orderLineCount: 3,
  uniqueBarcodeCount: 3,
  matchedBarcodeCount: 2,
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
};

let lines: ReviewLineDto[];
let currentBatch: BatchSummary;
let exportRows: ExportDto[];
let mappingRows: ProductMappingDto[];
let candidateRows: ProductMatchCandidateDto[];
let specRows: WdtGoodsSpecSearchResultDto[];
let latestGoodsSyncRun: WdtGoodsSyncRunDto | null;
let currentUser: { id: string; username: string; role: "admin" | "operator" | "reviewer"; createdAt: string };
let failReviewLines: boolean;

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    currentBatch = { ...batch };
    lines = [
      reviewLine({ id: "line-1", externalGoodsName: "可发商品", status: "库存充足", suggestedShipQty: 5 }),
      reviewLine({
        id: "line-2",
        externalGoodsName: "部分满足商品",
        status: "部分满足",
        suggestedShipQty: 2,
        orderQty: 5,
      }),
      reviewLine({
        id: "line-3",
        externalGoodsName: "未匹配商品",
        status: "未匹配",
        matchStatus: "not_found",
        suggestedShipQty: 0,
      }),
    ];
    exportRows = [];
    mappingRows = [productMapping()];
    candidateRows = [productCandidate()];
    specRows = [wdtSpec()];
    latestGoodsSyncRun = goodsSyncRun();
    currentUser = { id: "user-1", username: "admin", role: "admin", createdAt: "2026-06-30T00:00:00.000Z" };
    failReviewLines = false;
    vi.stubGlobal("fetch", vi.fn(handleFetch));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads persisted batches and filters review lines", async () => {
    render(<App />);

    expect(await screen.findByText("订货通知单 .xls")).toBeInTheDocument();
    expect(await screen.findByText(/上传/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(screen.getByText("订单时间跨度")).toBeInTheDocument();
    expect(screen.getByText("门店 / 订单")).toBeInTheDocument();
    await clickBatch();
    switchToReviewTab();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/batches/batch-1/review-lines"));
    await waitFor(() => expect(document.body.textContent).toContain("可发商品"));

    fireEvent.click(screen.getByRole("button", { name: "商品异常" }));
    expect(document.body.textContent).toContain("未匹配商品");
    expect(document.body.textContent).not.toContain("可发商品");
    expect(document.body.textContent).not.toContain("production_api");
    expect(document.body.textContent).not.toContain("Mock/API");
  });

  it("shows dismissible first-run help and can reopen it", async () => {
    const { unmount } = render(<App />);

    expect(await screen.findByText("按三个步骤处理订单")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));

    await waitFor(() => expect(screen.queryByText("按三个步骤处理订单")).not.toBeInTheDocument());
    expect(localStorage.getItem("jy-trade-help-dismissed-v1")).toBe("true");

    unmount();
    render(<App />);
    await screen.findByText("订单处理工作台");
    expect(screen.queryByText("按三个步骤处理订单")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    expect(await screen.findByText("按三个步骤处理订单")).toBeInTheDocument();
  });

  it("keeps developer tools hidden until developer mode is enabled", async () => {
    render(<App />);

    expect(await screen.findByText("订单处理工作台")).toBeInTheDocument();
    expect(screen.queryByText("演示数据文件")).not.toBeInTheDocument();
    expect(screen.queryByText("订货单路径")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成演示批次" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("mock");
    expect(document.body.textContent).not.toContain("API");
    expect(document.body.textContent).not.toContain("production_api");

    await clickBatch();
    switchToReviewTab();
    expect(screen.queryByText("商品映射确认")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "开发者模式" }));
    switchToReviewTab();

    expect(await screen.findByText("商品映射确认")).toBeInTheDocument();
    switchToImportTab();
    expect(screen.getByText("订货单路径")).toBeInTheDocument();
    expect(screen.getByText("演示数据文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成演示批次" })).toBeInTheDocument();
  });

  it("disables order import while goods sync is unavailable", async () => {
    latestGoodsSyncRun = goodsSyncRun({ status: "running" });
    render(<App />);

    const file = new File(["order"], "新订货单.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.change(await screen.findByLabelText("选择文件"), { target: { files: [file] } });
    const importButton = await screen.findByRole("button", { name: "导入新订单" });
    expect(importButton).toBeDisabled();
    expect(screen.getByText("商品档案同步可用后才能导入新订单。请刷新右侧状态，或先完成商品档案同步。")).toBeInTheDocument();
  });

  it("requires selecting an order file before import", async () => {
    render(<App />);

    const importButton = await screen.findByRole("button", { name: "导入新订单" });
    expect(importButton).toBeDisabled();
    expect(screen.getByText("请先选择订货单文件，再开始导入。")).toBeInTheDocument();
  });

  it("disables import and export actions for reviewer accounts", async () => {
    currentUser = { id: "reviewer-1", username: "reviewer", role: "reviewer", createdAt: "2026-06-30T00:00:00.000Z" };
    render(<App />);

    expect(await screen.findByText("reviewer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入新订单" })).toBeDisabled();
    expect(screen.getByText("当前账号不能导入订单，请联系管理员或切换到运营账号。")).toBeInTheDocument();

    await clickBatch();
    switchToReviewTab();
    expect(screen.getByRole("button", { name: "提交审核完成" })).not.toBeDisabled();
    switchToExportTab();
    expect(screen.getByRole("button", { name: "生成导出" })).toBeDisabled();
    expect(screen.getByText("当前账号不能生成做单文件，请联系管理员或切换到运营账号。")).toBeInTheDocument();
  });

  it("disables review actions for operator accounts", async () => {
    currentUser = { id: "operator-1", username: "operator", role: "operator", createdAt: "2026-06-30T00:00:00.000Z" };
    render(<App />);

    expect(await screen.findByText("operator")).toBeInTheDocument();
    await clickBatch();
    switchToReviewTab();

    expect(screen.getByText("当前账号不能审核发货，请联系管理员或切换到审核账号。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批量通过可发项" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交审核完成" })).toBeDisabled();
    const row = await rowFor("可发商品");
    expect(within(row).getByRole("button", { name: "发货" })).toBeDisabled();
    expect(within(row).getByRole("checkbox", { name: "优先处理 line-1" })).toBeDisabled();
    switchToExportTab();
    expect(screen.getByText("等待审核完成")).toBeInTheDocument();
  });

  it("shows clear empty states before a batch is selected", async () => {
    render(<App />);

    await screen.findByText("订单处理工作台");
    switchToReviewTab();
    expect(screen.getByText("先选择一个批次")).toBeInTheDocument();
    expect(screen.getByText("从左侧历史批次选择订单，或回到导入订单创建新批次。")).toBeInTheDocument();

    switchToExportTab();
    expect(screen.getByText("完成审核后，这里会生成初审单、确定发货单或做单 Excel。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成导出" })).toBeDisabled();
  });

  it("allows do-not-ship decisions without a reason", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("可发商品");
    fireEvent.click(within(row).getByRole("button", { name: "不发" }));

    await waitFor(() => expect(lines.find((line) => line.id === "line-1")?.decision).toBe("do_not_ship"));
    expect(within(row).queryByText("不发货必须填写原因")).not.toBeInTheDocument();
  });

  it("shows an error instead of crashing when review lines fail to load", async () => {
    failReviewLines = true;
    render(<App />);

    await clickBatch();

    expect(await screen.findByText("审核明细读取失败")).toBeInTheDocument();
    expect(screen.queryByText("可发商品")).not.toBeInTheDocument();
  });

  it("saves over-suggested quantities when a reason is provided", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("可发商品");
    fireEvent.click(within(row).getByRole("button", { name: "发货" }));
    await waitFor(() => expect(lines.find((line) => line.id === "line-1")?.decision).toBe("ship"));
    fireEvent.change(within(row).getByLabelText("审核发货数 line-1"), { target: { value: "8" } });
    fireEvent.change(within(row).getByLabelText("审核原因 line-1"), { target: { value: "人工确认额外库存" } });
    fireEvent.click(within(row).getByRole("button", { name: "保存数量" }));

    await waitFor(() => expect(within(row).getByText("超建议数")).toBeInTheDocument());
    expect(lines.find((line) => line.id === "line-1")).toMatchObject({
      decision: "ship",
      approvedShipQty: 8,
      reason: "人工确认额外库存",
    });
  });

  it("marks priority lines without a reason", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("部分满足商品");
    fireEvent.click(within(row).getByRole("checkbox", { name: "优先处理 line-2" }));

    await waitFor(() => expect(lines.find((line) => line.id === "line-2")?.priority).toBe(true));
    expect(within(row).queryByText("优先处理必须填写原因")).not.toBeInTheDocument();
  });

  it("auto-saves reason edits when the field loses focus", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("可发商品");
    const reasonInput = within(row).getByLabelText("审核原因 line-1");
    fireEvent.change(reasonInput, { target: { value: "门店备注" } });
    fireEvent.blur(reasonInput);

    await waitFor(() => expect(lines.find((line) => line.id === "line-1")?.reason).toBe("门店备注"));
  });

  it("marks priority lines and moves them to the top", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("部分满足商品");
    fireEvent.change(within(row).getByLabelText("审核原因 line-2"), { target: { value: "门店急用" } });
    fireEvent.click(within(row).getByRole("checkbox", { name: "优先处理 line-2" }));

    await waitFor(() => expect(lines.find((line) => line.id === "line-2")?.priority).toBe(true));
    const bodyRows = [...document.querySelectorAll<HTMLElement>("tbody tr")];
    expect(bodyRows[0].textContent).toContain("部分满足商品");
    expect(within(bodyRows[0]).getByText("优先")).toBeInTheDocument();
  });

  it("bulk approves matched ready and partial lines, then submits review", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "批量通过可发项" }));
    expect(await screen.findByText("已批量通过 2 行")).toBeInTheDocument();
    expect(lines.filter((line) => line.decision === "ship")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "提交审核完成" }));
    expect(await screen.findByText(/审核已提交/)).toBeInTheDocument();
    expect(currentBatch.status).toBe("reviewed");
  });

  it("creates a production batch and runs real review", async () => {
    render(<App />);

    const file = new File(["order"], "新订货单.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.change(await screen.findByLabelText("选择文件"), { target: { files: [file] } });
    expect(await screen.findByText("新订货单.xlsx")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "导入新订单" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/v1/order-files",
        expect.objectContaining({
          method: "POST",
        }),
      ),
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/v1/batches/batch-1/actions/run-real-review",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ allowStaleCache: false }),
        }),
      ),
    );
    expect(await screen.findByText("真实初审已完成，已查询库存 1 个规格")).toBeInTheDocument();
    expect(currentBatch.mode).toBe("production_api");
  });

  it("blocks real review when latest goods sync failed", async () => {
    latestGoodsSyncRun = goodsSyncRun({ status: "failed", errorMessage: "fetch failed" });
    render(<App />);

    expect(await screen.findByText("需刷新")).toBeInTheDocument();
    const importButton = await screen.findByRole("button", { name: "导入新订单" });

    expect(importButton).toBeDisabled();
    expect(screen.getByText("商品档案同步可用后才能导入新订单。请刷新右侧状态，或先完成商品档案同步。")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/v1/batches",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("creates and lists exports", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();
    fireEvent.click(screen.getByRole("button", { name: "提交审核完成" }));
    await screen.findByText(/审核已提交/);
    switchToExportTab();

    fireEvent.click(screen.getByRole("button", { name: "生成导出" }));

    expect(await screen.findByText("导出文件已生成")).toBeInTheDocument();
    expect(await screen.findByText("batch-1-review.xlsx")).toBeInTheDocument();
    expect(screen.getByText("已生成")).toBeInTheDocument();
  });

  it("keeps exports disabled until review is submitted", async () => {
    render(<App />);
    await clickBatch();
    switchToExportTab();

    expect(screen.getByText("等待审核完成")).toBeInTheDocument();
    expect(screen.getByText("当前批次还没有提交审核，确认发货数量后再生成做单文件。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成导出" })).toBeDisabled();
  });

  it("confirms product mappings from searched WDT specs", async () => {
    render(<App />);
    await clickBatch();
    fireEvent.click(screen.getByRole("checkbox", { name: "开发者模式" }));
    switchToReviewTab();

    expect(await screen.findByText("商品映射确认")).toBeInTheDocument();
    expect(await screen.findByText("待确认候选")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("雅漾专研保湿修护面膜25ml*5片").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: /雅漾专研保湿修护面膜25ml/ }));
    expect(screen.getByLabelText("旺店通 spec_no")).toHaveValue("3282770392869");

    fireEvent.change(screen.getByLabelText("外部条码"), { target: { value: "2153722460015" } });
    fireEvent.change(screen.getByLabelText("外部编码"), { target: { value: "5372246" } });
    fireEvent.change(screen.getByLabelText("外部商品名"), { target: { value: "雅漾专研保湿修护面膜25ml*5片" } });
    fireEvent.click(screen.getByRole("button", { name: "确认映射" }));

    expect(await screen.findByText("商品映射已确认")).toBeInTheDocument();
    expect(mappingRows[0]).toMatchObject({
      externalBarcode: "2153722460015",
      externalGoodsCode: "5372246",
      wdtSpecNo: "3282770392869",
      status: "confirmed",
    });
  });
});

async function rowFor(productName: string) {
  await waitFor(() => expect(document.body.textContent).toContain(productName));
  const row = [...document.querySelectorAll("tr")].find((item) => item.textContent?.includes(productName));
  if (!row) throw new Error(`No row found for ${productName}`);
  return row;
}

async function clickBatch() {
  const label = await screen.findByText("订货通知单 .xls");
  const button = label.closest("button");
  if (!button) throw new Error("Batch button not found");
  fireEvent.click(button);
}

function switchToReviewTab() {
  fireEvent.click(screen.getByTestId("work-tab-review"));
}

function switchToImportTab() {
  fireEvent.click(screen.getByTestId("work-tab-import"));
}

function switchToExportTab() {
  fireEvent.click(screen.getByTestId("work-tab-export"));
}

async function handleFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  const method = init?.method ?? "GET";

  if (url === "/api/v1/me") {
    return json({ user: currentUser });
  }
  if (url === "/api/v1/auth/login") {
    const body = JSON.parse(String(init?.body));
    currentUser = {
      id: `${body.username}-1`,
      username: body.username,
      role: body.username === "operator" ? "operator" : body.username === "reviewer" ? "reviewer" : "admin",
      createdAt: "2026-06-30T00:00:00.000Z",
    };
    return json({ user: currentUser });
  }
  if (url === "/api/v1/auth/logout") return json({ ok: true });
  if (url === "/api/v1/wdt/goods-sync-runs/latest") {
    return latestGoodsSyncRun ? json(latestGoodsSyncRun) : json({ message: "WDT goods sync run not found" }, 404);
  }
  if (url === "/api/v1/batches" && method === "GET") return json([currentBatch]);
  if (url === "/api/v1/batches" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    currentBatch = { ...currentBatch, fileName: body.fileName ?? currentBatch.fileName, mode: body.mode ?? currentBatch.mode };
    return json(currentBatch, 201);
  }
  if (url === "/api/v1/order-files" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    return json({ filePath: `inputs/uploads/${body.fileName}`, fileName: body.fileName }, 201);
  }
  if (url.includes("/review-lines") && method === "GET") {
    return failReviewLines ? json({ message: "审核明细读取失败" }, 500) : json(lines);
  }
  if (url.includes("/actions/run-mock-review")) return json({ batch: currentBatch });
  if (url.includes("/actions/run-real-review")) return json({ batch: currentBatch, stockQueriedCount: 1 });
  if (url.includes("/actions/bulk-approve")) {
    lines = lines.map((line) =>
      line.matchStatus === "matched" && (line.status === "库存充足" || line.status === "部分满足")
        ? { ...line, decision: "ship", approvedShipQty: line.suggestedShipQty, reason: "" }
        : line,
    );
    return json({ batch: currentBatch, updatedCount: 2 });
  }
  if (url.includes("/actions/submit-review")) {
    currentBatch = { ...currentBatch, status: "reviewed" };
    return json({ batch: currentBatch, pendingCount: 1, shipCount: 2, doNotShipCount: 0 });
  }
  if (url.endsWith("/exports") && method === "GET") return json(exportRows);
  if (url.endsWith("/exports") && method === "POST") {
    const body = JSON.parse(String(init?.body));
    const created: ExportDto = {
      id: "export-1",
      batchId: "batch-1",
      type: body.type,
      status: "ready",
      fileName: "batch-1-review.xlsx",
      downloadUrl: "/api/v1/exports/export-1/download",
      errorMessage: null,
      createdByUserId: "user-1",
      createdByUsername: "admin",
      createdAt: "2026-06-30T00:00:00.000Z",
    };
    exportRows = [created];
    return json(created, 201);
  }
  if (url.startsWith("/api/v1/product-mappings") && method === "GET") return json(mappingRows);
  if (url.startsWith("/api/v1/product-match-candidates") && method === "GET") return json(candidateRows);
  if (url === "/api/v1/product-mappings" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    const spec = specRows.find((item) => item.specNo === body.wdtSpecNo);
    const created = productMapping({
      externalBarcode: body.externalBarcode,
      externalGoodsCode: body.externalGoodsCode,
      externalGoodsName: body.externalGoodsName,
      wdtGoodsNo: spec?.goodsNo ?? "",
      wdtGoodsName: spec?.goodsName ?? "",
      wdtSpecNo: body.wdtSpecNo,
      wdtSpecName: spec?.specName ?? "",
      wdtBarcode: spec?.barcode ?? "",
      note: body.note,
      status: "confirmed",
    });
    mappingRows = [created];
    return json(created, 201);
  }
  if (url.includes("/api/v1/product-mappings/") && url.endsWith("/status") && method === "PATCH") {
    const body = JSON.parse(String(init?.body));
    mappingRows = mappingRows.map((item) => ({ ...item, status: body.status, note: body.note }));
    return json(mappingRows[0]);
  }
  if (url.startsWith("/api/v1/wdt/goods-specs/search")) return json(specRows);
  if (url.includes("/decision") && method === "PATCH") {
    const lineId = url.split("/review-lines/")[1]?.split("/")[0];
    const body = JSON.parse(String(init?.body));
    const line = lines.find((item) => item.id === lineId);
    if (!line) return json({ message: "Review line not found" }, 404);
    if (body.approvedShipQty < 0) return json({ message: "发货数量不能小于 0" }, 400);
    const updated = { ...line, ...body };
    lines = lines.map((item) => (item.id === lineId ? updated : item));
    return json(updated);
  }
  if (url.includes("/priority") && method === "PATCH") {
    const lineId = url.split("/review-lines/")[1]?.split("/")[0];
    const body = JSON.parse(String(init?.body));
    const line = lines.find((item) => item.id === lineId);
    if (!line) return json({ message: "Review line not found" }, 404);
    const updated = { ...line, priority: body.priority, priorityReason: body.priority ? body.reason : "" };
    lines = lines.map((item) => (item.id === lineId ? updated : item)).sort((left, right) => {
      if (left.priority !== right.priority) return left.priority ? -1 : 1;
      return left.excelRow - right.excelRow;
    });
    return json(updated);
  }
  return json({ message: `Unhandled ${method} ${url}` }, 500);
}

function productMapping(patch: Partial<ProductMappingDto> = {}): ProductMappingDto {
  return {
    id: "mapping-1",
    externalBarcode: "2153722460015",
    externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
    externalGoodsCode: "5372246",
    wdtGoodsNo: "3282770392869",
    wdtGoodsName: "雅漾专研保湿修护面膜",
    wdtSpecNo: "3282770392869",
    wdtSpecName: "25ml*5",
    wdtBarcode: "3282770392869",
    status: "confirmed",
    sourceBatchId: "",
    confirmedByUserId: "user-1",
    confirmedAt: "2026-07-03T00:00:00.000Z",
    note: "人工确认",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...patch,
  };
}

function productCandidate(patch: Partial<ProductMatchCandidateDto> = {}): ProductMatchCandidateDto {
  return {
    id: "candidate-1",
    batchId: "diagnosis-order",
    reviewLineId: "line-1",
    externalBarcode: "2153722460015",
    externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
    externalGoodsCode: "5372246",
    wdtSpecNo: "3282770392869",
    wdtGoodsNo: "3282770392869",
    wdtGoodsName: "雅漾专研保湿修护面膜",
    wdtSpecName: "25ml*5",
    wdtBarcode: "3282770392869",
    score: 82,
    basis: "contains_name",
    source: "goods",
    createdAt: "2026-07-03T00:00:00.000Z",
    ...patch,
  };
}

function wdtSpec(patch: Partial<WdtGoodsSpecSearchResultDto> = {}): WdtGoodsSpecSearchResultDto {
  return {
    id: "wdt-goods-spec-3282770392869",
    goodsNo: "3282770392869",
    goodsName: "雅漾专研保湿修护面膜",
    specNo: "3282770392869",
    specName: "25ml*5",
    specCode: "",
    barcode: "3282770392869",
    barcodes: ["3282770392869"],
    deleted: 0,
    modified: "2026-07-01 00:00:00",
    syncedAt: "2026-07-03T00:00:00.000Z",
    ...patch,
  };
}

function goodsSyncRun(patch: Partial<WdtGoodsSyncRunDto> = {}): WdtGoodsSyncRunDto {
  return {
    id: "sync-1",
    mode: "full",
    status: "success",
    startedAt: "2026-07-03T00:00:00.000Z",
    finishedAt: "2026-07-03T00:01:00.000Z",
    rangeStart: "2026-06-01T00:00:00.000Z",
    rangeEnd: "2026-07-03T00:00:00.000Z",
    windowCount: 2,
    pageCount: 8,
    fetchedCount: 3857,
    upsertedCount: 3788,
    errorMessage: "",
    ...patch,
  };
}

function json(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response);
}

function reviewLine(patch: Partial<ReviewLineDto>): ReviewLineDto {
  return {
    id: "line",
    batchId: "batch-1",
    orderNoticeNo: "ORDER-1",
    excelRow: 2,
    storeNo: "STORE",
    storeName: "测试门店",
    uploadTime: "2026-06-30 10:00:00",
    externalBarcode: "BARCODE",
    externalGoodsName: "商品",
    goodsName: "商品",
    specName: "规格",
    wdtSpecNo: "SPEC",
    matchStatus: "matched",
    matchMessage: "matched",
    orderQty: 5,
    mainAvailableBefore: 5,
    nearExpiryAvailableBefore: 0,
    suggestedShipQty: 5,
    status: "库存充足",
    decision: "pending",
    approvedShipQty: 0,
    reason: "",
    priority: false,
    priorityReason: "",
    ...patch,
  };
}
