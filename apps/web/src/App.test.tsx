import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type {
  BatchSummary,
  ExportDto,
  ExternalProductImportComponentPreview,
  ExternalProductDto,
  MakeOrderReadinessDto,
  ProductMappingDto,
  ProductMatchCandidateDto,
  ReviewLineDto,
  StoreAddressDto,
  WarehouseUsageSettingsDto,
  WdtSyncSettingsDto,
  WdtGoodsSpecSearchResultDto,
  WdtGoodsSyncRunDto,
  WdtSyncRunDto,
} from "@jy-trade/shared";
import { confirmedProductMappingMatchMessage } from "@jy-trade/shared";

const batch: BatchSummary = {
  id: "batch-1",
  fileName: "订货通知单 .xls",
  mode: "mock",
  sourceType: "order",
  status: "review_generated",
  orderLineCount: 3,
  uniqueBarcodeCount: 3,
  matchedBarcodeCount: 2,
  stockSnapshotRunId: "",
  stockSnapshotAt: "",
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
let latestCombinedSyncRun: WdtSyncRunDto | null;
let combinedSyncStatusReads: number;
let warehouseSettings: WarehouseUsageSettingsDto;
let wdtSyncSettings: WdtSyncSettingsDto;
let makeOrderReadiness: MakeOrderReadinessDto;
let storeAddressRows: StoreAddressDto[];
let externalProductRows: ExternalProductDto[];
let currentUser: { id: string; username: string; role: "admin" | "operator" | "reviewer"; createdAt: string };
let failReviewLines: boolean;
let batchDeleted: boolean;

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
    latestCombinedSyncRun = combinedSyncRun();
    combinedSyncStatusReads = 0;
    warehouseSettings = warehouseUsageSettings();
    wdtSyncSettings = { intervalHours: 1, autoSyncEnabled: true, updatedAt: "2026-07-06T00:00:00.000Z" };
    storeAddressRows = [];
    externalProductRows = [externalProduct()];
    makeOrderReadiness = {
      batchId: "batch-1",
      canExport: false,
      shippableLineCount: 2,
      missingAddressCount: 1,
      missingStores: [{ storeNo: "STORE", storeName: "测试门店", shippableLineCount: 2, orderNoticeNos: ["ORDER-1"] }],
      missingWarehouseCount: 0,
      missingWarehouseLines: [],
    };
    currentUser = { id: "user-1", username: "admin", role: "admin", createdAt: "2026-06-30T00:00:00.000Z" };
    failReviewLines = false;
    batchDeleted = false;
    vi.stubGlobal("fetch", vi.fn(handleFetch));
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads persisted batches and filters review lines", async () => {
    render(<App />);

    expect(await screen.findByText("订货通知单 .xls")).toBeInTheDocument();
    expect(await screen.findByText(/上传/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(screen.getByText("唯一条码")).toBeInTheDocument();
    expect(screen.getByText("初审模式")).toBeInTheDocument();
    expect(screen.queryByText("选择批次后查看")).not.toBeInTheDocument();
    expect(screen.queryByText("选择批次后统计")).not.toBeInTheDocument();
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

  it("allows admins to delete a batch from history", async () => {
    render(<App />);

    expect(await screen.findByText("订货通知单 .xls")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /删除批次/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/batches/batch-1", { method: "DELETE" }));
    await waitFor(() => expect(screen.queryByText("订货通知单 .xls")).not.toBeInTheDocument());
    expect(screen.getAllByText("批次已删除").length).toBeGreaterThan(0);
  });

  it("hides batch deletion from non-admin users", async () => {
    currentUser = { id: "operator-1", username: "operator", role: "operator", createdAt: "2026-06-30T00:00:00.000Z" };
    render(<App />);

    expect(await screen.findByText("订货通知单 .xls")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除批次/ })).not.toBeInTheDocument();
  });

  it("shows match and review exception statistics", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    expect(await statCardText("已匹配")).toContain("2");
    expect(await statCardText("需确认")).toContain("0");
    expect(await statCardText("未找到")).toContain("1");
    expect(await statCardText("库存异常")).toContain("0");
  });

  it("locates product mapping from an exception row", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const unmatchedRow = await rowFor("未匹配商品");
    fireEvent.click(within(unmatchedRow).getByRole("button", { name: "定位映射" }));

    expect(await screen.findByText("商品映射确认")).toBeInTheDocument();
    expect(screen.getByText("已打开商品映射，保存长期映射后会自动刷新当前批次")).toBeInTheDocument();
    expect(screen.getByLabelText("映射搜索")).toHaveValue("BARCODE");
    expect(screen.getByLabelText("外部条码")).toHaveValue("BARCODE");
  });

  it("marks manually mapped rows and filters them for review", async () => {
    lines = [
      reviewLine({
        id: "line-manual-mapping",
        externalGoodsName: "长期映射商品",
        matchMessage: confirmedProductMappingMatchMessage,
      }),
      reviewLine({
        id: "line-ordinary-match",
        externalGoodsName: "普通匹配商品",
        matchMessage: "Matched by barcode",
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const manualRow = await rowFor("长期映射商品");
    expect(within(manualRow).getByText("长期映射")).toBeInTheDocument();
    expect(within(manualRow).getByRole("button", { name: "复查映射" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("review-filter-manual_mapping"));
    expect(await rowFor("长期映射商品")).toBeInTheDocument();
    expect(screen.queryByText("普通匹配商品")).not.toBeInTheDocument();
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

    expect(await screen.findByText("开发者模式已开启：商品映射现在通过“长期映射库”或明细行按钮打开。")).toBeInTheDocument();
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
    expect(screen.getByText("本地商品档案可用后才能导入新订单；确定单可先导入，但商品匹配依赖已有商品档案和人工映射。库存建议统一读取本地快照。")).toBeInTheDocument();
  });

  it("requires selecting an order file before import", async () => {
    render(<App />);

    const importButton = await screen.findByRole("button", { name: "导入新订单" });
    expect(importButton).toBeDisabled();
    expect(screen.getByText("请先选择订货单文件，再开始导入。")).toBeInTheDocument();
    expect(screen.queryByText("可用仓库范围")).not.toBeInTheDocument();
  });

  it("lets admins save warehouse usage settings", async () => {
    render(<App />);

    expect((await screen.findAllByText(/库存快照/)).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(await screen.findByText("可用仓库范围")).toBeInTheDocument();
    expect(screen.getByText("商品与库存同步")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即同步" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/v1/wdt/sync-runs",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(await screen.findByText("同步任务已进入后台队列")).toBeInTheDocument();
    const nearExpiry = screen.getByRole("checkbox", { name: "临期仓" });
    const other = screen.getByRole("checkbox", { name: "其他仓" });

    expect(nearExpiry).toBeChecked();
    fireEvent.click(nearExpiry);
    fireEvent.click(other);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(warehouseSettings.includeNearExpiryWarehouse).toBe(false));
    expect(warehouseSettings.includeOtherWarehouses).toBe(true);
    expect(await screen.findByText("已保存，重新运行初审后生效")).toBeInTheDocument();
    expect(await screen.findByText(/当前快照未覆盖已启用的其他仓/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("自动同步"), { target: { value: "6" } });
    await waitFor(() => expect(wdtSyncSettings.intervalHours).toBe(6));
    expect(await screen.findByText("已改为每 6 小时自动同步")).toBeInTheDocument();
  });

  it("restores a running combined sync after refresh and polls its progress", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    latestCombinedSyncRun = combinedSyncRun({
      trigger: "manual",
      status: "running",
      stage: "stock",
      totalSpecCount: 100,
      processedSpecCount: 40,
      totalBatchCount: 3,
      completedBatchCount: 1,
      finishedAt: "",
      activeSnapshotRunId: "snapshot-previous",
      activeSnapshotAt: "2026-07-03T00:02:00.000Z",
    });
    render(<App />);

    await screen.findByText("更新中");
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(await screen.findByText(/阶段：同步分仓库存 · SKU 40\/100 · 批次 1\/3/)).toBeInTheDocument();
    expect(screen.getByLabelText("同步进度 40%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步中" })).toBeDisabled();
    const readsBeforePoll = combinedSyncStatusReads;

    latestCombinedSyncRun = combinedSyncRun({
      trigger: "manual",
      status: "running",
      stage: "stock",
      totalSpecCount: 100,
      processedSpecCount: 80,
      totalBatchCount: 3,
      completedBatchCount: 2,
      finishedAt: "",
      activeSnapshotRunId: "snapshot-previous",
      activeSnapshotAt: "2026-07-03T00:02:00.000Z",
    });
    await vi.advanceTimersByTimeAsync(2000);

    await waitFor(() => expect(combinedSyncStatusReads).toBeGreaterThan(readsBeforePoll));
    expect(await screen.findByText(/阶段：同步分仓库存 · SKU 80\/100 · 批次 2\/3/)).toBeInTheDocument();
    expect(screen.getByLabelText("同步进度 80%")).toBeInTheDocument();
  });

  it("shows a failed sync while keeping the previous snapshot and hides developer details by default", async () => {
    latestCombinedSyncRun = combinedSyncRun({
      trigger: "manual",
      status: "failed",
      stage: "complete",
      errorCode: "WDT_STOCK_ERROR",
      errorMessage: "旺店通库存同步失败",
      errorDetail: "status=100 raw response body",
      activeSnapshotRunId: "snapshot-previous",
      activeSnapshotAt: "2026-07-03T00:02:00.000Z",
      activeSnapshotTrigger: "hourly",
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(await screen.findByText(/旺店通库存同步失败，仍使用 .* 的成功快照/)).toBeInTheDocument();
    expect(screen.getAllByText(/来源：整点自动/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/status=100 raw response body/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "开发者模式" }));
    expect(await screen.findByText(/同步详情：WDT_STOCK_ERROR status=100 raw response body/)).toBeInTheDocument();
  });

  it("explains that business work can continue when no successful snapshot exists", async () => {
    latestCombinedSyncRun = null;
    render(<App />);

    expect((await screen.findAllByText(/尚无成功库存快照/)).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(await screen.findByText(/业务仍可继续，库存建议会标记为未验证/)).toBeInTheDocument();
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
    expect(screen.queryByTestId("create-export-review")).not.toBeInTheDocument();
    expect(screen.getByText("当前账号不能生成做单文件，请联系管理员或切换到运营账号。")).toBeInTheDocument();
  });

  it("disables review actions for operator accounts", async () => {
    currentUser = { id: "operator-1", username: "operator", role: "operator", createdAt: "2026-06-30T00:00:00.000Z" };
    render(<App />);

    expect(await screen.findByText("operator")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("checkbox", { name: "主仓" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "临期仓" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "立即同步" })).not.toBeDisabled();
    expect(screen.getByText("当前账号只能查看仓库范围，请联系管理员调整。")).toBeInTheDocument();
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
    expect(screen.queryByTestId("create-export-review")).not.toBeInTheDocument();
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

  it("colors review rows by shipping and inventory state", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const readyRow = await rowFor("可发商品");
    const partialRow = await rowFor("部分满足商品");
    const unmatchedRow = await rowFor("未匹配商品");

    expect(readyRow).toHaveAttribute("data-review-state", "ready");
    expect(partialRow).toHaveAttribute("data-review-state", "partial");
    expect(unmatchedRow).toHaveAttribute("data-review-state", "unmatched");

    fireEvent.click(within(readyRow).getByRole("button", { name: "不发" }));
    await waitFor(() => expect(readyRow).toHaveAttribute("data-review-state", "do_not_ship"));
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
    fireEvent.click(within(row).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(within(row).getByText("超系统建议")).toBeInTheDocument());
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

  it("shows a save button only after editing quantity or reason", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("可发商品");
    expect(within(row).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    const reasonInput = within(row).getByLabelText("审核原因 line-1");
    fireEvent.change(reasonInput, { target: { value: "门店备注" } });

    fireEvent.click(within(row).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(lines.find((line) => line.id === "line-1")?.reason).toBe("门店备注"));
    expect(within(row).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("preselects the suggested warehouse and saves manual warehouse changes", async () => {
    lines = lines.map((line) => line.id === "line-1"
      ? { ...line, decision: "ship", approvedShipQty: 5, fulfillmentWarehouseNo: "001", fulfillmentWarehouseName: "主仓" }
      : line);
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("可发商品");
    const warehouseSelect = within(row).getByRole("combobox", { name: "发货仓库 line-1" });
    expect(warehouseSelect).toHaveValue("001");
    fireEvent.change(warehouseSelect, { target: { value: "LINQI" } });
    expect(within(row).getByRole("button", { name: "保存" })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(lines.find((line) => line.id === "line-1")).toMatchObject({
      fulfillmentWarehouseNo: "LINQI",
      fulfillmentWarehouseName: "临期仓",
    }));
  });

  it("shows an inline error when shipping without a warehouse", async () => {
    lines = lines.map((line) => line.id === "line-1"
      ? { ...line, suggestedWarehouseNo: "", suggestedWarehouseName: "", fulfillmentWarehouseNo: "", fulfillmentWarehouseName: "" }
      : line);
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("可发商品");
    fireEvent.click(within(row).getByRole("button", { name: "发货" }));
    expect(await within(row).findByText("请选择发货仓库")).toBeInTheDocument();
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
    expect(screen.getByText("审核完成，当前批次可以进入做单")).toBeInTheDocument();
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
    expect(screen.getByText("订单导入成功，已生成初审结果")).toBeInTheDocument();
    expect(currentBatch.mode).toBe("production_api");
  });

  it("imports confirmed orders into review before make-order export", async () => {
    render(<App />);

    const file = new File(["confirmed"], "确定单.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.change(await screen.findByLabelText("选择文件"), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "导入确定单" }));

    expect(await screen.findByText("确定单导入成功，请确认系统建议并提交审核")).toBeInTheDocument();
    expect(screen.getByText(/确定单已导入/)).toBeInTheDocument();
    expect(screen.getByText("确定单校验")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交审核完成" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成做单表格" })).not.toBeInTheDocument();
    expect(currentBatch.status).toBe("review_generated");
    expect(currentBatch.sourceType).toBe("confirmed_order");
    expect(currentBatch.fileName).toBe("确定单.xlsx");
  });

  it("blocks real review when latest goods sync failed", async () => {
    latestGoodsSyncRun = goodsSyncRun({ status: "failed", errorMessage: "fetch failed" });
    latestCombinedSyncRun = combinedSyncRun({
      status: "failed",
      errorCode: "SYNC_FAILED",
      errorMessage: "商品与库存同步失败",
    });
    render(<App />);

    expect(await screen.findByText("建议刷新")).toBeInTheDocument();
    const importButton = await screen.findByRole("button", { name: "导入新订单" });

    expect(importButton).toBeDisabled();
    expect(screen.getByText("本地商品档案可用后才能导入新订单；确定单可先导入，但商品匹配依赖已有商品档案和人工映射。库存建议统一读取本地快照。")).toBeInTheDocument();
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

    fireEvent.click(screen.getByTestId("create-export-review"));

    expect(await screen.findByText("导出文件已生成")).toBeInTheDocument();
    expect(screen.getByTestId("export-type-export-1")).toHaveTextContent("初审单");
    expect(screen.getByTestId("export-file-export-1")).toHaveTextContent("batch-1-review.xlsx");
    expect(screen.getByText("已生成")).toBeInTheDocument();
  });

  it("shows make-order readiness before creating WDT import exports", async () => {
    currentBatch = { ...currentBatch, status: "reviewed" };
    render(<App />);
    await clickBatch();
    switchToExportTab();

    expect(await screen.findByText("做单预检查")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成做单表格" })).toBeDisabled();
    expect(screen.getByText("可做单 2 行 / 未选仓库 0 行 / 缺地址 1 个门店")).toBeInTheDocument();
    expect(screen.getByText("测试门店")).toBeInTheDocument();
    expect(screen.getByText("2 行待做单")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修正本批字段" })).toBeInTheDocument();
  });

  it("corrects store fields on the current batch from the export tab", async () => {
    currentBatch = { ...currentBatch, status: "reviewed" };
    render(<App />);
    await clickBatch();
    switchToExportTab();

    fireEvent.click(await screen.findByRole("button", { name: "修正本批字段" }));
    expect(screen.getByLabelText("本批收货地编码")).toHaveValue("STORE");
    expect(screen.getByLabelText("本批收货地名称")).toHaveValue("测试门店");
    fireEvent.change(screen.getByLabelText("本批收货地编码"), { target: { value: "STORE-FIXED" } });
    fireEvent.change(screen.getByLabelText("本批收货地名称"), { target: { value: "正确门店" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/v1/batches/batch-1/store-fields", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentStoreNo: "STORE",
          currentStoreName: "测试门店",
          nextStoreNo: "STORE-FIXED",
          nextStoreName: "正确门店",
        }),
      }),
    );
    expect(await screen.findByText("已修正本批门店字段")).toBeInTheDocument();
    expect(screen.getByText("门店字段已修正，可以继续生成做单")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成做单表格" })).not.toBeDisabled();
  });

  it("imports store addresses from the address maintenance tab", async () => {
    currentBatch = { ...currentBatch, status: "reviewed" };
    render(<App />);
    await clickBatch();
    switchToExportTab();

    fireEvent.click(screen.getByTestId("maintenance-tab-addresses"));
    expect(await screen.findByText("门店地址维护")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("门店地址查询"), { target: { value: "不匹配的旧查询" } });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(screen.getByText("暂无门店地址")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("导入地址 Excel"), {
      target: {
        files: [new File(["fake workbook"], "地址匹配表格.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })],
      },
    });

    expect(await screen.findByText("已解析 2 条地址，新增 1 个，更新 1 个")).toBeInTheDocument();
    expect(screen.getByText("地址导入预览")).toBeInTheDocument();
    expect(screen.getByText("新增 1")).toBeInTheDocument();
    expect(screen.getByText("更新 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认更新地址" }));

    expect(await screen.findByText("已确认导入 2 条来源记录，新增 1 个，更新 1 个")).toBeInTheDocument();
    expect(screen.getByLabelText("门店地址查询")).toHaveValue("");
    expect(await screen.findByText("导入门店")).toBeInTheDocument();
    expect(screen.getByText("经理表")).toBeInTheDocument();
    expect(screen.getByText("第 3 行")).toBeInTheDocument();
  });

  it("keeps missing address repair read-only for reviewers", async () => {
    currentUser = { ...currentUser, username: "reviewer", role: "reviewer" };
    currentBatch = { ...currentBatch, status: "reviewed" };
    render(<App />);
    await clickBatch();
    switchToExportTab();

    expect(await screen.findByRole("button", { name: "修正本批字段" })).toBeDisabled();
    expect(screen.getByText("当前账号不能生成做单文件，请联系管理员或切换到运营账号。")).toBeInTheDocument();
  });

  it("imports external product maintenance workbooks from the product maintenance tab", async () => {
    render(<App />);

    await screen.findByText("订单处理工作台");
    switchToExternalProductsTab();
    expect(await screen.findByText("小样和套盒维护")).toBeInTheDocument();
    expect(await screen.findByText("既有小样")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("商品维护查询"), { target: { value: "不匹配的旧查询" } });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(screen.getByText("暂无维护商品")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("导入商品维护 Excel"), {
      target: {
        files: [new File(["fake workbook"], "小样套盒统计.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })],
      },
    });

    expect(await screen.findByText("已解析 2 个维护商品，新增 1 个，更新 1 个，需复查 1 个")).toBeInTheDocument();
    expect(screen.getByText("商品维护导入预览")).toBeInTheDocument();
    expect(screen.getByText("导入套盒")).toBeInTheDocument();
    expect(screen.getByText("主件：690000000002")).toBeInTheDocument();
    expect(screen.getByText("替换：690000000003")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认导入维护表" }));

    expect(await screen.findByText("已导入 2 个维护商品、3 个组件，需复查 1 个")).toBeInTheDocument();
    expect(screen.getByLabelText("商品维护查询")).toHaveValue("");
    expect(await screen.findByText("导入小样")).toBeInTheDocument();
    expect(screen.getByText("导入套盒")).toBeInTheDocument();
    expect(screen.getByText("WDT：SPEC-SAMPLE-1 / 小样 WDT")).toBeInTheDocument();
  });

  it("keeps external product maintenance read-only for reviewers", async () => {
    currentUser = { ...currentUser, username: "reviewer", role: "reviewer" };
    render(<App />);

    await screen.findByText("订单处理工作台");
    switchToExternalProductsTab();
    expect(await screen.findByText("小样和套盒维护")).toBeInTheDocument();
    expect(screen.getByText("当前账号只能查看维护商品。")).toBeInTheDocument();
    expect(screen.getByLabelText("导入商品维护 Excel")).toBeDisabled();
  });

  it("shows failed export reasons clearly", async () => {
    currentBatch = { ...currentBatch, status: "reviewed" };
    exportRows = [
      {
        id: "export-failed",
        batchId: "batch-1",
        type: "wdt_import",
        status: "failed",
        fileName: "batch-1-wdt-import.xls",
        downloadUrl: undefined,
        errorMessage: "缺少发货地址：测试门店",
        createdByUserId: "user-1",
        createdByUsername: "admin",
        createdAt: "2026-06-30T00:00:00.000Z",
      },
    ];
    render(<App />);
    await clickBatch();
    switchToExportTab();

    expect(await screen.findByTestId("export-file-export-failed")).toHaveTextContent("batch-1-wdt-import.xls");
    expect(screen.getByTestId("export-type-export-failed")).toHaveTextContent("做单 Excel");
    expect(screen.getByText("失败原因：缺少发货地址：测试门店")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("keeps exports disabled until review is submitted", async () => {
    render(<App />);
    await clickBatch();
    switchToExportTab();

    expect(screen.getByText("等待审核完成")).toBeInTheDocument();
    expect(screen.getByText("当前批次还没有提交审核，确认发货数量后再生成做单文件。")).toBeInTheDocument();
    expect(screen.queryByTestId("create-export-review")).not.toBeInTheDocument();
  });

  it("confirms product mappings from searched WDT specs", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "长期映射库" }));
    expect(await screen.findByText("库存查询")).toBeInTheDocument();
    expect(await screen.findByText("商品映射确认")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "当前行映射" }));
    expect(await screen.findByText("智能候选")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新智能候选" }));
    await waitFor(() => expect(screen.getAllByText("雅漾专研保湿修护面膜25ml*5片").length).toBeGreaterThan(0));
    expect(screen.getByText("可发 15")).toBeInTheDocument();
    expect(screen.getByText("001 /主仓: 12")).toBeInTheDocument();
    expect(screen.getByText("LINQI /临期仓: 3")).toBeInTheDocument();
    expect(screen.queryByText(/CIPIN/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "搜索规格" }));
    await waitFor(() => expect(screen.getByText("3282770392869 / 25ml*5 / 3282770392869")).toBeInTheDocument());
    expect(screen.getAllByText("可发 15").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("001 /主仓: 12").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("LINQI /临期仓: 3").length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole("button", { name: /雅漾专研保湿修护面膜25ml/ }));
    expect(screen.getByLabelText("旺店通 spec_no")).toHaveValue("3282770392869");

    fireEvent.change(screen.getByLabelText("外部条码"), { target: { value: "2153722460015" } });
    fireEvent.change(screen.getByLabelText("外部编码"), { target: { value: "5372246" } });
    fireEvent.change(screen.getByLabelText("外部商品名"), { target: { value: "雅漾专研保湿修护面膜25ml*5片" } });
    fireEvent.click(screen.getByRole("button", { name: "保存长期映射" }));

    expect(await screen.findByText("长期商品映射已保存，正式订单重新初审后生效")).toBeInTheDocument();
    expect(mappingRows[0]).toMatchObject({
      externalBarcode: "2153722460015",
      externalGoodsCode: "5372246",
      wdtSpecNo: "3282770392869",
      status: "confirmed",
    });
  });

  it("does not show unrelated global candidates when locating a product mapping", async () => {
    lines = [
      reviewLine({
        id: "line-target-mapping",
        externalBarcode: "TARGET-BARCODE",
        externalGoodsCode: "TARGET-CODE",
        externalGoodsName: "当前要处理的商品",
        goodsName: "",
        wdtSpecNo: "",
        matchStatus: "ambiguous",
        matchMessage: "Name candidate needs human confirmation",
        status: "未匹配",
        suggestedShipQty: 0,
      }),
    ];
    candidateRows = [
      productCandidate({
        id: "candidate-unrelated-1",
        externalBarcode: "2153659120013",
        externalGoodsCode: "5365912",
        externalGoodsName: "肌肤之钥金致乳霜5ml",
      }),
      productCandidate({
        id: "candidate-unrelated-2",
        externalBarcode: "2153659160019",
        externalGoodsCode: "5365916",
        externalGoodsName: "肌肤未来光感透润美白面膜单片25ml",
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const targetRow = await rowFor("当前要处理的商品");
    fireEvent.click(within(targetRow).getByRole("button", { name: "定位映射" }));

    expect(await screen.findByText("商品映射确认")).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/product-match-candidates?query=TARGET-BARCODE"));
    expect(screen.queryByText("肌肤之钥金致乳霜5ml")).not.toBeInTheDocument();
    expect(screen.queryByText("肌肤未来光感透润美白面膜单片25ml")).not.toBeInTheDocument();
  });

  it("does not flash unrelated long-term mappings when locating a product mapping", async () => {
    lines = [
      reviewLine({
        id: "line-target-mapping",
        externalBarcode: "TARGET-BARCODE",
        externalGoodsCode: "TARGET-CODE",
        externalGoodsName: "当前要处理的商品",
        goodsName: "",
        wdtSpecNo: "",
        matchStatus: "ambiguous",
        matchMessage: "Name candidate needs human confirmation",
        status: "未匹配",
        suggestedShipQty: 0,
      }),
    ];
    mappingRows = [
      productMapping({
        id: "mapping-unrelated",
        externalBarcode: "2153659120013",
        externalGoodsCode: "5365912",
        externalGoodsName: "肌肤之钥金致乳霜5ml",
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const targetRow = await rowFor("当前要处理的商品");
    fireEvent.click(within(targetRow).getByRole("button", { name: "定位映射" }));

    expect(await screen.findByText("商品映射确认")).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/product-mappings?query=TARGET-BARCODE"));
    expect(fetch).not.toHaveBeenCalledWith("/api/v1/product-mappings?query=");
    expect(screen.queryByText("肌肤之钥金致乳霜5ml")).not.toBeInTheDocument();
  });

  it("uses the mapping dialog as a stock lookup tool", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "长期映射库" }));
    expect(await screen.findByText("库存查询")).toBeInTheDocument();
    expect(screen.getByText("输入名称、商品条码、组合装条码、商家编码或规格编码，结果按当前仓库范围显示可发库存。")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("库存查询"), { target: { value: "雅漾" } });
    fireEvent.click(screen.getByRole("button", { name: "查询库存" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/wdt/goods-specs/search?query=%E9%9B%85%E6%BC%BE"));
    await waitFor(() => expect(screen.getAllByText("3282770392869 / 25ml*5 / 3282770392869").length).toBeGreaterThan(0));
    expect(screen.getByText("可发 15")).toBeInTheDocument();
    expect(screen.getByText("001 /主仓: 12")).toBeInTheDocument();
    expect(screen.getByText("LINQI /临期仓: 3")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /用作映射目标/ })[0]);
    expect(await screen.findByText("已带入旺店通规格，请补充外部条码或编码后保存长期映射")).toBeInTheDocument();
    expect(screen.getByLabelText("旺店通 spec_no")).toHaveValue("3282770392869");
  });

  it("shows suite results and carries the make-order code from manual search", async () => {
    specRows = [
      wdtSpec({
        id: "wdt-suite-2150317560013",
        source: "suite",
        goodsNo: "2150317560013",
        goodsName: "lelabo护发素(33檀香系列)50ml",
        specNo: "021700004",
        specName: "50ml",
        specCode: "2150317560013",
        makeOrderCode: "2150317560013",
        barcode: "2150317560013",
        barcodes: ["2150317560013", "021700004"],
        stockTotalAvailable: 8,
        stockRows: [{ warehouseNo: "001", warehouseName: "主仓", availableSendStock: 8, included: true }],
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "长期映射库" }));
    expect(await screen.findByText("库存查询")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("库存查询"), { target: { value: "2150317560013" } });
    fireEvent.click(screen.getByRole("button", { name: "查询库存" }));

    expect(await screen.findByText("组合装")).toBeInTheDocument();
    expect(screen.getByText("做单码 2150317560013")).toBeInTheDocument();
    expect(screen.getByText("021700004 / 50ml / 2150317560013")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /用作映射目标/ }));
    expect(screen.getByLabelText("旺店通 spec_no")).toHaveValue("021700004");
    expect(screen.getByLabelText("做单码")).toHaveValue("2150317560013");
  });

  it("shows loading feedback while manual stock search is running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/v1/wdt/goods-specs/search")) return new Promise<Response>(() => {});
        return handleFetch(input, init);
      }),
    );
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "长期映射库" }));
    expect(await screen.findByText("库存查询")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("库存查询"), { target: { value: "雅漾" } });
    fireEvent.click(screen.getByRole("button", { name: "查询库存" }));

    expect(screen.getByRole("button", { name: "查询中..." })).toBeDisabled();
    expect(screen.getByText("正在查询库存...")).toBeInTheDocument();
  });

  it("shows loading feedback while smart candidates are running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/v1/product-match-candidates")) return new Promise<Response>(() => {});
        return handleFetch(input, init);
      }),
    );
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "长期映射库" }));
    expect(await screen.findByText("库存查询")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "当前行映射" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新智能候选" }));

    expect(screen.getByRole("button", { name: "查询中..." })).toBeDisabled();
    expect(screen.getByText("正在查询智能候选...")).toBeInTheDocument();
  });

  it("clears spec search results when locating another product mapping", async () => {
    lines = [
      reviewLine({
        id: "line-map-1",
        externalBarcode: "2153722460015",
        externalGoodsCode: "5372246",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        goodsName: "",
        wdtSpecNo: "",
        matchStatus: "ambiguous",
        matchMessage: "Name candidate needs human confirmation",
        status: "未匹配",
        suggestedShipQty: 0,
      }),
      reviewLine({
        id: "line-map-2",
        externalBarcode: "2153659220010",
        externalGoodsCode: "5365922",
        externalGoodsName: "爱马仕巴赫尼香水7.5ml",
        goodsName: "",
        wdtSpecNo: "",
        matchStatus: "ambiguous",
        matchMessage: "Name candidate needs human confirmation",
        status: "未匹配",
        suggestedShipQty: 0,
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const firstRow = await rowFor("雅漾专研保湿修护面膜25ml*5片");
    fireEvent.click(within(firstRow).getByRole("button", { name: "定位映射" }));
    fireEvent.click(await screen.findByRole("button", { name: "搜索规格" }));
    await waitFor(() => expect(screen.getByText("3282770392869 / 25ml*5 / 3282770392869")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /雅漾专研保湿修护面膜25ml/ }));
    expect(screen.getByLabelText("旺店通 spec_no")).toHaveValue("3282770392869");

    const secondRow = await rowFor("爱马仕巴赫尼香水7.5ml");
    fireEvent.click(within(secondRow).getByRole("button", { name: "定位映射" }));

    expect(screen.getByLabelText("旺店通商品搜索")).toHaveValue("爱马仕巴赫尼香水7.5ml");
    await waitFor(() => expect(screen.queryByText("3282770392869 / 25ml*5 / 3282770392869")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("旺店通 spec_no")).toHaveValue(""));
  });

  it("deletes long-term product mappings from the mapping panel", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "长期映射库" }));
    fireEvent.click(screen.getAllByRole("button", { name: "长期映射库" }).at(-1)!);
    expect(await screen.findByText("已确认/待处理映射")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("人工确认")).toBeInTheDocument());
    const mappingRow = [...document.querySelectorAll("tr")].find((row) => row.textContent?.includes("人工确认"));
    if (!mappingRow) throw new Error("Mapping row not found");
    fireEvent.click(within(mappingRow).getByRole("button", { name: "删除" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("确定删除长期映射"));
    expect(await screen.findByText("长期商品映射已删除，重新初审后生效")).toBeInTheDocument();
    expect(mappingRows).toHaveLength(0);
  });

  it("fills the mapping form when reviewing an existing product mapping", async () => {
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "长期映射库" }));
    fireEvent.click(screen.getAllByRole("button", { name: "长期映射库" }).at(-1)!);
    expect(await screen.findByText("已确认/待处理映射")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("人工确认")).toBeInTheDocument());
    const mappingRow = [...document.querySelectorAll("tr")].find((row) => row.textContent?.includes("人工确认"));
    if (!mappingRow) throw new Error("Mapping row not found");
    fireEvent.click(within(mappingRow).getByRole("button", { name: "复查" }));

    expect(screen.getByLabelText("外部条码")).toHaveValue("2153722460015");
    expect(screen.getByLabelText("外部编码")).toHaveValue("5372246");
    expect(screen.getByLabelText("外部商品名")).toHaveValue("雅漾专研保湿修护面膜25ml*5片");
    expect(screen.getByLabelText("旺店通 spec_no")).toHaveValue("3282770392869");
    expect(screen.getByLabelText("备注")).toHaveValue("人工确认");
    expect(screen.getByLabelText("旺店通商品搜索")).toHaveValue("雅漾专研保湿修护面膜");
    expect(await screen.findByText("商品映射已标记复查")).toBeInTheDocument();
    await waitFor(() => expect(mappingRows[0].status).toBe("needs_review"));
  });

  it("refreshes the active production batch after confirming a product mapping", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "order" };
    mappingRows = [];
    lines = [
      reviewLine({
        id: "line-mask-1",
        externalBarcode: "2153722460015",
        externalGoodsCode: "5372246",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        goodsName: "",
        wdtSpecNo: "",
        matchStatus: "ambiguous",
        matchMessage: "Name candidate needs human confirmation",
        status: "未匹配",
        suggestedShipQty: 0,
      }),
      reviewLine({
        id: "line-mask-2",
        excelRow: 3,
        externalBarcode: "2153722460015",
        externalGoodsCode: "5372246",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        goodsName: "",
        wdtSpecNo: "",
        matchStatus: "ambiguous",
        matchMessage: "Name candidate needs human confirmation",
        status: "未匹配",
        suggestedShipQty: 0,
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const mappingRow = await rowFor("雅漾专研保湿修护面膜25ml*5片");
    fireEvent.click(within(mappingRow).getAllByRole("button", { name: "定位映射" })[0]);
    expect(await screen.findByText("商品映射确认")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /雅漾专研保湿修护面膜25ml/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存长期映射" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/v1/batches/batch-1/actions/run-real-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowStaleCache: false }),
      }),
    );
    expect(await screen.findByText("映射已应用到当前批次")).toBeInTheDocument();
    await waitFor(() => expect(lines.every((line) => line.matchStatus === "matched")).toBe(true));
    expect(screen.queryByText("Name candidate needs human confirmation")).not.toBeInTheDocument();
  });

  it("rechecks confirmed-order batches after confirming a product mapping", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "reviewed" };
    mappingRows = [];
    lines = [
      reviewLine({
        id: "line-confirmed-order-1",
        externalBarcode: "2153722460015",
        externalGoodsCode: "5372246",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        goodsName: "",
        wdtSpecNo: "",
        matchStatus: "ambiguous",
        matchMessage: "Name candidate needs human confirmation",
        status: "未匹配",
        decision: "pending",
        suggestedShipQty: 0,
        approvedShipQty: 0,
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    expect(await screen.findByText("确定单校验")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交审核完成" })).toBeInTheDocument();
    const confirmedOrderRow = await rowFor("雅漾专研保湿修护面膜25ml*5片");
    expect(within(confirmedOrderRow).getByText("缺商家编码")).toBeInTheDocument();
    expect(within(confirmedOrderRow).getByText("需选择商家编码")).toBeInTheDocument();
    expect(within(confirmedOrderRow).queryByText("未匹配")).not.toBeInTheDocument();
    expect(within(confirmedOrderRow).queryByText("待确认")).not.toBeInTheDocument();
    fireEvent.click(within(confirmedOrderRow).getByRole("button", { name: "定位映射" }));
    fireEvent.click(await screen.findByRole("button", { name: /雅漾专研保湿修护面膜25ml/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存长期映射" }));
    expect(await screen.findByRole("dialog", { name: "重新校验确定单" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /保留当前审核结果/ }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/v1/batches/batch-1/actions/rebuild-confirmed-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "preserve" }),
      }),
    );
    expect(fetch).not.toHaveBeenCalledWith("/api/v1/batches/batch-1/actions/run-real-review", expect.anything());
    expect(await screen.findByText("系统建议已刷新，当前审核结果已保留；请重新提交审核")).toBeInTheDocument();
    await waitFor(() => expect(lines.every((line) => line.matchStatus === "matched" && line.decision === "ship")).toBe(true));
  });

  it("keeps a saved mapping without recalculating when the rebuild prompt is cancelled", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "review_generated" };
    mappingRows = [];
    lines = [
      reviewLine({
        id: "line-confirmed-mapping-cancel",
        externalBarcode: "2153722460015",
        externalGoodsCode: "5372246",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        goodsName: "",
        wdtSpecNo: "",
        matchStatus: "ambiguous",
        matchMessage: "Name candidate needs human confirmation",
        status: "未匹配",
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("雅漾专研保湿修护面膜25ml*5片");
    fireEvent.click(within(row).getByRole("button", { name: "定位映射" }));
    fireEvent.click(await screen.findByRole("button", { name: /雅漾专研保湿修护面膜25ml/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存长期映射" }));
    expect(await screen.findByRole("dialog", { name: "重新校验确定单" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(await screen.findByText("映射已保存，当前审核尚未重新校验")).toBeInTheDocument();
    expect(mappingRows).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/actions/rebuild-confirmed-order"), expect.anything());
  });

  it("shows confirmed-order stock warnings outside the editable remark field", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "reviewed" };
    lines = [
      reviewLine({
        id: "line-confirmed-stock-warning",
        externalGoodsName: "确定单缺货提示商品",
        matchStatus: "matched",
        matchMessage: "Matched by barcode；确定单库存可能不足：本批该商品需 40，可发 16。仅提示，不调整做单数量",
        status: "部分满足",
        decision: "ship",
        suggestedShipQty: 40,
        approvedShipQty: 40,
        reason: "",
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("确定单缺货提示商品");
    expect(within(row).getByText("确定单库存可能不足：本批该商品需 40，可发 16。仅提示，不调整做单数量")).toBeInTheDocument();
    expect(within(row).getByLabelText("审核原因 line-confirmed-stock-warning")).toHaveValue("");
    fireEvent.click(within(row).getByRole("button", { name: "查替代编码" }));
    expect(await screen.findByText("商品映射确认")).toBeInTheDocument();
    expect(screen.getByText("当前编码 SPEC")).toBeInTheDocument();
    expect(screen.getAllByText("可发 主 5 / 临 0").length).toBeGreaterThanOrEqual(1);
  });

  it("filters confirmed-order rows by fulfillment result", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "review_generated" };
    lines = [
      reviewLine({ id: "confirmed-ready", externalGoodsName: "全部发货商品", status: "库存充足" }),
      reviewLine({ id: "confirmed-partial", externalGoodsName: "部分发货商品", status: "部分满足" }),
      reviewLine({ id: "confirmed-blocked", externalGoodsName: "货品不足商品", status: "库存不足" }),
      reviewLine({ id: "confirmed-unverified", externalGoodsName: "库存未验证商品", status: "库存未验证" }),
      reviewLine({ id: "confirmed-zero", externalGoodsName: "零计划量商品", plannedShipQty: 0, status: "库存充足" }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    for (const [filterName, visibleProduct] of [
      ["全部发货", "全部发货商品"],
      ["部分发货", "部分发货商品"],
      ["货品不足", "货品不足商品"],
      ["库存未验证", "库存未验证商品"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: filterName }));
      const visibleRow = await rowFor(visibleProduct);
      expect(visibleRow).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    }
  });

  it("groups confirmed-order products that need mapping and keeps API errors separate", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "review_generated" };
    lines = [
      reviewLine({ id: "mapping-a-1", externalGoodsName: "待映射商品A", externalGoodsCode: "CODE-A", externalBarcode: "BAR-A", storeNo: "S-1", storeName: "门店一", matchStatus: "ambiguous", status: "未匹配" }),
      reviewLine({ id: "mapping-a-2", externalGoodsName: "待映射商品A第二单", externalGoodsCode: "CODE-A", externalBarcode: "BAR-A", storeNo: "S-2", storeName: "门店二", matchStatus: "not_found", status: "未匹配" }),
      reviewLine({ id: "mapping-b", externalGoodsName: "待映射商品B", externalGoodsCode: "CODE-B", externalBarcode: "BAR-B", storeNo: "S-1", storeName: "门店一", matchStatus: "not_found", status: "未匹配" }),
      reviewLine({ id: "mapping-empty-1", excelRow: 21, externalGoodsName: "无编码商品一", externalGoodsCode: "", externalBarcode: "", matchStatus: "not_found", status: "未匹配" }),
      reviewLine({ id: "mapping-empty-2", excelRow: 22, externalGoodsName: "无编码商品二", externalGoodsCode: "", externalBarcode: "", matchStatus: "not_found", status: "未匹配" }),
      reviewLine({ id: "mapping-api-error", externalGoodsName: "接口校验失败商品", externalGoodsCode: "CODE-ERROR", matchStatus: "api_error", status: "未匹配" }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const pendingMappingFilter = await screen.findByRole("button", { name: /待映射商品.*4 种.*5 条/ });
    const validationErrorStat = (await screen.findAllByText("校验异常"))
      .map((element) => element.parentElement)
      .find((element) => element?.textContent === "校验异常1");
    expect(validationErrorStat).toBeTruthy();
    fireEvent.click(pendingMappingFilter);
    expect(await screen.findByText("货品码 CODE-A · 2 条订单 · 2 个门店")).toBeInTheDocument();
    expect(screen.getByText("Excel 第 21 行 · 1 条订单 · 1 个门店")).toBeInTheDocument();
    expect(screen.getByText("Excel 第 22 行 · 1 条订单 · 1 个门店")).toBeInTheDocument();
    expect(screen.queryByText("待映射商品A第二单")).not.toBeInTheDocument();
    expect(screen.queryByText("接口校验失败商品")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "定位映射" })).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "展开 待映射商品A" }));
    expect(await screen.findByText("待映射商品A第二单")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "定位映射" })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "收起 待映射商品A" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "校验异常" }));
    await waitFor(() => expect(screen.getByTestId("review-filter-validation_error")).toHaveClass("bg-primary"));
    expect(await screen.findByText("接口校验失败商品")).toBeInTheDocument();
    expect(screen.queryByText("待映射商品A")).not.toBeInTheDocument();
  });

  it("shows confirmed-order stock error details only in developer mode", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "review_generated" };
    lines = [
      reviewLine({
        id: "line-confirmed-stock-error",
        externalGoodsName: "确定单库存查询失败商品",
        matchStatus: "matched",
        matchMessage: "Matched by barcode；确定单库存查询失败，系统未生成数量和仓库建议，请人工确认",
        stockErrorDetail: "status=100 message=超过每分钟最大调用频率限制，请稍后重试",
        status: "库存未验证",
        decision: "ship",
        suggestedShipQty: 2,
        approvedShipQty: 2,
        reason: "",
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("确定单库存查询失败商品");
    expect(within(row).getByText("确定单库存查询失败，系统未生成数量和仓库建议，请人工确认")).toBeInTheDocument();
    expect(within(row).getByText("库存待人工确认")).toBeInTheDocument();
    expect(screen.queryByText(/库存查询详情/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("超过每分钟最大调用频率限制");

    fireEvent.click(screen.getByRole("checkbox", { name: "开发者模式" }));

    expect(await screen.findByText("库存查询详情：status=100 message=超过每分钟最大调用频率限制，请稍后重试")).toBeInTheDocument();
  });

  it("lets users manually recheck confirmed-order batches", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "reviewed" };
    lines = [
      reviewLine({
        id: "line-confirmed-order-stock",
        externalGoodsName: "确定单库存商品",
        matchStatus: "matched",
        status: "库存充足",
        decision: "ship",
        suggestedShipQty: 2,
        approvedShipQty: 2,
        mainAvailableBefore: 0,
        nearExpiryAvailableBefore: 0,
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    expect(await screen.findByText("确定单校验")).toBeInTheDocument();
    const recheckButton = screen.getByRole("button", { name: "重新校验确定单" });
    fireEvent.click(recheckButton);
    expect(await screen.findByRole("dialog", { name: "重新校验确定单" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /按最新库存重新分配/ }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/v1/batches/batch-1/actions/rebuild-confirmed-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "replace" }),
      }),
    );
    expect(await screen.findByText("已按最新库存重新分配；请检查结果并重新提交审核")).toBeInTheDocument();
    expect(screen.getByText("确定单已重新校验：1 行，已匹配 1 行，待补字段 0 行")).toBeInTheDocument();
  });

  it("shows confirmed-order quantity semantics and non-blocking final-result warnings", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "review_generated" };
    lines = [
      reviewLine({
        id: "line-confirmed-quantity-semantics",
        externalGoodsName: "确定单数量语义商品",
        orderQty: 10,
        plannedShipQty: 3,
        suggestedShipQty: 2,
        decision: "ship",
        approvedShipQty: 2,
        suggestedWarehouseNo: "001",
        suggestedWarehouseName: "主仓",
        fulfillmentWarehouseNo: "001",
        fulfillmentWarehouseName: "主仓",
        status: "部分满足",
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    const row = await rowFor("确定单数量语义商品");
    expect(row.textContent).toContain("订货 10");
    expect(row.textContent).toContain("发货 3");
    expect(row.textContent).toContain("系统建议 2");
    expect(within(row).getByText("最终仓库")).toBeInTheDocument();
    expect(within(row).getByText("最终发货数量")).toBeInTheDocument();

    fireEvent.change(within(row).getByLabelText("审核发货数 line-confirmed-quantity-semantics"), { target: { value: "4" } });
    fireEvent.change(within(row).getByLabelText("发货仓库 line-confirmed-quantity-semantics"), { target: { value: "LINQI" } });

    expect(within(row).getByText("超系统建议")).toBeInTheDocument();
    expect(within(row).getByText("偏离原计划")).toBeInTheDocument();
    expect(within(row).getByText("非建议仓库")).toBeInTheDocument();
    expect(within(row).getByText("最终数量超过系统建议，可能存在库存风险。")).toBeInTheDocument();
    expect(within(row).getByText("最终数量超过确定单发货数量，已偏离原计划。")).toBeInTheDocument();
  });

  it("confirms unverified stock before submitting manually decided quantities", async () => {
    currentBatch = { ...currentBatch, mode: "production_api", sourceType: "confirmed_order", status: "review_generated" };
    lines = [
      reviewLine({
        id: "line-confirmed-unverified-submit",
        externalGoodsName: "人工库存确认商品",
        status: "库存未验证",
        stockErrorDetail: "status=100 raw=rate-limited",
        decision: "ship",
        approvedShipQty: 2,
        fulfillmentWarehouseNo: "001",
        fulfillmentWarehouseName: "主仓",
      }),
    ];
    render(<App />);
    await clickBatch();
    switchToReviewTab();

    fireEvent.click(screen.getByRole("button", { name: "提交审核完成" }));
    const confirmationDialog = await screen.findByRole("alertdialog", { name: "库存尚未完成核验" });
    expect(within(confirmationDialog).getByText(/有 1 条明细未完成库存校验/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认并提交 1 条" }));

    await waitFor(() => expect(currentBatch.status).toBe("reviewed"));
    expect(fetch).toHaveBeenCalledWith("/api/v1/batches/batch-1/actions/submit-review", expect.objectContaining({
      body: JSON.stringify({ confirmUnverifiedStock: false }),
    }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/batches/batch-1/actions/submit-review", expect.objectContaining({
      body: JSON.stringify({ confirmUnverifiedStock: true }),
    }));
  });
});

async function rowFor(productName: string) {
  await waitFor(() => expect(document.body.textContent).toContain(productName));
  const row = [...document.querySelectorAll("tr")].find((item) => item.textContent?.includes(productName));
  if (!row) throw new Error(`No row found for ${productName}`);
  return row;
}

async function statCardText(label: string) {
  const labelElement = await screen.findByText(label);
  const card = labelElement.parentElement;
  if (!card) throw new Error(`No stat card found for ${label}`);
  return card.textContent ?? "";
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

function switchToExternalProductsTab() {
  fireEvent.click(screen.getByTestId("maintenance-tab-external-products"));
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
  if (url === "/api/v1/wdt/sync-runs/latest") {
    combinedSyncStatusReads += 1;
    return latestCombinedSyncRun ? json(latestCombinedSyncRun) : json({ message: "WDT sync run not found" }, 404);
  }
  if (url === "/api/v1/wdt/sync-runs" && method === "POST") {
    if (!["admin", "operator"].includes(currentUser.role)) return json({ message: "Forbidden" }, 403);
    latestCombinedSyncRun = combinedSyncRun({ status: "queued", stage: "queued", activeSnapshotRunId: "snapshot-1" });
    return json({ run: latestCombinedSyncRun, alreadyRunning: false }, 202);
  }
  if (url === "/api/v1/wdt/goods-sync-runs" && method === "POST") {
    if (!["admin", "operator"].includes(currentUser.role)) return json({ message: "Forbidden" }, 403);
    latestGoodsSyncRun = goodsSyncRun({ startedAt: "2026-07-06T00:00:00.000Z", finishedAt: "2026-07-06T00:02:00.000Z" });
    return json(latestGoodsSyncRun, 201);
  }
  if (url === "/api/v1/settings/warehouse-usage" && method === "GET") return json(warehouseSettings);
  if (url === "/api/v1/settings/warehouse-usage" && method === "PATCH") {
    if (currentUser.role !== "admin") return json({ message: "Forbidden" }, 403);
    const body = JSON.parse(String(init?.body));
    warehouseSettings = {
      ...warehouseSettings,
      ...body,
      updatedByUserId: currentUser.id,
      updatedByUsername: currentUser.username,
      updatedAt: "2026-07-06T00:00:00.000Z",
    };
    if (latestCombinedSyncRun) {
      const enabledTypes = [
        warehouseSettings.includeMainWarehouse ? "main" : "",
        warehouseSettings.includeNearExpiryWarehouse ? "near_expiry" : "",
        warehouseSettings.includeDefectWarehouse ? "defect" : "",
        warehouseSettings.includeOtherWarehouses ? "other" : "",
      ].filter(Boolean) as Array<"main" | "near_expiry" | "defect" | "other">;
      latestCombinedSyncRun = {
        ...latestCombinedSyncRun,
        activeSnapshotMissingWarehouseTypes: enabledTypes.filter((type) => !latestCombinedSyncRun?.activeSnapshotWarehouseTypes.includes(type)),
      };
    }
    return json(warehouseSettings);
  }
  if (url === "/api/v1/settings/wdt-sync" && method === "GET") return json(wdtSyncSettings);
  if (url === "/api/v1/settings/wdt-sync" && method === "PATCH") {
    if (currentUser.role !== "admin") return json({ message: "Forbidden" }, 403);
    const body = JSON.parse(String(init?.body));
    wdtSyncSettings = {
      ...wdtSyncSettings,
      intervalHours: body.intervalHours,
      updatedByUserId: currentUser.id,
      updatedByUsername: currentUser.username,
      updatedAt: "2026-07-06T00:00:00.000Z",
    };
    return json(wdtSyncSettings);
  }
  if (url === "/api/v1/batches" && method === "GET") return json(batchDeleted ? [] : [currentBatch]);
  if (url === "/api/v1/batches" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    currentBatch = { ...currentBatch, fileName: body.fileName ?? currentBatch.fileName, mode: body.mode ?? currentBatch.mode, sourceType: "order" };
    batchDeleted = false;
    return json(currentBatch, 201);
  }
  if (url === "/api/v1/batches/batch-1" && method === "DELETE") {
    if (currentUser.role !== "admin") return json({ message: "Forbidden" }, 403);
    batchDeleted = true;
    return json({ batchId: "batch-1", deleted: true });
  }
  if (url === "/api/v1/order-files" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    return json({ filePath: `inputs/uploads/${body.fileName}`, fileName: body.fileName }, 201);
  }
  if (url === "/api/v1/confirmed-orders/import" && method === "POST") {
    if (!["admin", "operator"].includes(currentUser.role)) return json({ message: "Forbidden" }, 403);
    const body = JSON.parse(String(init?.body));
    currentBatch = {
      ...currentBatch,
      fileName: body.fileName,
      mode: "production_api",
      sourceType: "confirmed_order",
      status: "review_generated",
      orderLineCount: lines.length,
      matchedBarcodeCount: lines.filter((line) => line.matchStatus === "matched").length,
      uniqueBarcodeCount: new Set(lines.map((line) => line.externalBarcode)).size,
    };
    batchDeleted = false;
    return json({
      batch: currentBatch,
      fileName: body.fileName,
      sheetName: "确定单",
      parsedRowCount: lines.length,
      matchedRowCount: lines.length,
      unmatchedRowCount: 0,
      skippedRowCount: 0,
    }, 201);
  }
  if (url.includes("/review-lines") && method === "GET") {
    return failReviewLines ? json({ message: "审核明细读取失败" }, 500) : json(lines);
  }
  if (url.includes("/make-order-readiness") && method === "GET") return json(makeOrderReadiness);
  if (url.includes("/store-fields") && method === "PATCH") {
    const body = JSON.parse(String(init?.body));
    let updatedLineCount = 0;
    lines = lines.map((line) => {
      const matches = body.currentStoreNo ? line.storeNo === body.currentStoreNo : line.storeName === body.currentStoreName;
      if (!matches) return line;
      updatedLineCount += 1;
      return { ...line, storeNo: body.nextStoreNo, storeName: body.nextStoreName };
    });
    currentBatch = { ...currentBatch, updatedAt: "2026-07-07T00:00:00.000Z" };
    makeOrderReadiness = { ...makeOrderReadiness, canExport: true, missingAddressCount: 0, missingStores: [] };
    return json({ batch: currentBatch, updatedLineCount, makeOrderReadiness });
  }
  if (url.startsWith("/api/v1/external-products") && method === "GET") {
    const query = decodeURIComponent(url.split("query=")[1] ?? "").trim();
    const rows = query
      ? externalProductRows.filter((row) => [row.externalBarcode, row.externalGoodsCode, row.externalGoodsName].some((value) => value.includes(query)))
      : externalProductRows;
    return json(rows);
  }
  if (url === "/api/v1/external-products/import-preview" && method === "POST") {
    if (!["admin", "operator"].includes(currentUser.role)) return json({ message: "Forbidden" }, 403);
    return json({
      fileName: "小样套盒统计.xlsx",
      sheetCount: 2,
      parsedProductCount: 2,
      parsedComponentCount: 3,
      skippedRowCount: 0,
      createCount: 1,
      updateCount: 1,
      unchangedCount: 0,
      needsReviewCount: 1,
      items: [
        {
          action: "create",
          type: "sample",
          externalBarcode: "690000000001",
          externalGoodsCode: "SAMPLE-001",
          externalGoodsName: "导入小样",
          status: "confirmed",
          sourceSheet: "小样价格",
          sourceRow: 2,
          note: "标签价格:19.9",
          rawJson: "{}",
          componentCount: 1,
          resolvedComponentCount: 1,
          needsReviewComponentCount: 0,
          existing: null,
          components: [
            externalProductComponentPreview({
              componentBarcode: "690000000001",
              componentGoodsCode: "SAMPLE-001",
              componentName: "导入小样",
              wdtSpecNo: "SPEC-SAMPLE-1",
              wdtGoodsName: "小样 WDT",
            }),
          ],
        },
        {
          action: "update",
          type: "bundle",
          externalBarcode: "BUNDLE001",
          externalGoodsCode: "",
          externalGoodsName: "导入套盒",
          status: "needs_review",
          sourceSheet: "套盒",
          sourceRow: 2,
          note: "合同价:99",
          rawJson: "{}",
          componentCount: 2,
          resolvedComponentCount: 1,
          needsReviewComponentCount: 1,
          existing: {
            id: "external-product-existing",
            status: "needs_review",
            componentCount: 1,
            updatedAt: "2026-07-07T00:00:00.000Z",
          },
          components: [
            externalProductComponentPreview({
              componentBarcode: "690000000002",
              role: "primary",
              wdtSpecNo: "SPEC-BUNDLE-PRIMARY",
              wdtGoodsName: "套盒主件 WDT",
            }),
            externalProductComponentPreview({
              componentBarcode: "690000000003",
              role: "replacement",
              matchStatus: "needs_review",
              wdtSpecNo: "",
              wdtGoodsName: "",
            }),
          ],
        },
      ],
    });
  }
  if (url === "/api/v1/external-products/import" && method === "POST") {
    if (!["admin", "operator"].includes(currentUser.role)) return json({ message: "Forbidden" }, 403);
    externalProductRows = [
      externalProduct({
        id: "external-product-imported-sample",
        type: "sample",
        externalBarcode: "690000000001",
        externalGoodsCode: "SAMPLE-001",
        externalGoodsName: "导入小样",
        status: "confirmed",
        sourceFileName: "小样套盒统计.xlsx",
        sourceSheet: "小样价格",
        sourceRow: 2,
        note: "标签价格:19.9",
        components: [
          externalProductComponent({
            id: "external-product-component-sample",
            externalProductId: "external-product-imported-sample",
            componentBarcode: "690000000001",
            componentGoodsCode: "SAMPLE-001",
            componentName: "导入小样",
            wdtSpecNo: "SPEC-SAMPLE-1",
            wdtGoodsName: "小样 WDT",
          }),
        ],
      }),
      externalProduct({
        id: "external-product-imported-bundle",
        type: "bundle",
        externalBarcode: "BUNDLE001",
        externalGoodsName: "导入套盒",
        status: "needs_review",
        sourceFileName: "小样套盒统计.xlsx",
        sourceSheet: "套盒",
        sourceRow: 2,
        note: "合同价:99",
        components: [
          externalProductComponent({
            id: "external-product-component-bundle-primary",
            externalProductId: "external-product-imported-bundle",
            componentBarcode: "690000000002",
            wdtSpecNo: "SPEC-BUNDLE-PRIMARY",
            wdtGoodsName: "套盒主件 WDT",
          }),
          externalProductComponent({
            id: "external-product-component-bundle-replacement",
            externalProductId: "external-product-imported-bundle",
            role: "replacement",
            componentBarcode: "690000000003",
            matchStatus: "needs_review",
            wdtSpecNo: "",
            wdtGoodsName: "",
          }),
        ],
      }),
    ];
    return json({
      fileName: "小样套盒统计.xlsx",
      sheetCount: 2,
      parsedProductCount: 2,
      parsedComponentCount: 3,
      importedProductCount: 2,
      importedComponentCount: 3,
      skippedRowCount: 0,
      needsReviewCount: 1,
    }, 201);
  }
  if (url.startsWith("/api/v1/store-addresses") && method === "GET") {
    const query = decodeURIComponent(url.split("query=")[1] ?? "").trim();
    const rows = query
      ? storeAddressRows.filter((row) => [row.storeNo, row.storeName, row.receiver, row.phone, row.address].some((value) => value.includes(query)))
      : storeAddressRows;
    return json(rows);
  }
  if (url === "/api/v1/store-addresses/import-preview" && method === "POST") {
    if (!["admin", "operator"].includes(currentUser.role)) return json({ message: "Forbidden" }, 403);
    return json({
      fileName: "地址匹配表格.xlsx",
      sheetCount: 2,
      parsedRowCount: 2,
      skippedRowCount: 0,
      affectedStoreCount: 2,
      createCount: 1,
      updateCount: 1,
      unchangedCount: 0,
      items: [
        {
          action: "create",
          storeNo: "IMPORT-1",
          storeName: "导入门店",
          receiver: "李四",
          phone: "18800003333",
          address: "广州市天河区导入地址",
          sourceSheet: "经理表",
          sourceRow: 3,
          existing: null,
        },
        {
          action: "update",
          storeNo: "IMPORT-2",
          storeName: "兼职门店",
          receiver: "王五",
          phone: "18800004444",
          address: "佛山市禅城区导入地址",
          sourceSheet: "兼职表",
          sourceRow: 2,
          existing: {
            storeNo: "IMPORT-2",
            storeName: "兼职门店",
            receiver: "旧收件人",
            phone: "18800000000",
          address: "旧地址",
          isVip: false,
        },
        },
      ],
    });
  }
  if (url === "/api/v1/store-addresses/import" && method === "POST") {
    if (!["admin", "operator"].includes(currentUser.role)) return json({ message: "Forbidden" }, 403);
    storeAddressRows = [
      {
        id: "store-address-imported-1",
        storeNo: "IMPORT-1",
        storeName: "导入门店",
        receiver: "李四",
        phone: "18800003333",
        address: "广州市天河区导入地址",
        isVip: false,
        note: "",
        sourceSheet: "经理表",
        sourceRow: 3,
        importedAt: "2026-07-07T00:00:00.000Z",
        rawJson: "{}",
        updatedByUserId: currentUser.id,
        updatedByUsername: currentUser.username,
        createdAt: "2026-07-07T00:00:00.000Z",
        updatedAt: "2026-07-07T00:00:00.000Z",
      },
      {
        id: "store-address-imported-2",
        storeNo: "IMPORT-2",
        storeName: "兼职门店",
        receiver: "王五",
        phone: "18800004444",
        address: "佛山市禅城区导入地址",
        isVip: false,
        note: "",
        sourceSheet: "兼职表",
        sourceRow: 2,
        importedAt: "2026-07-07T00:00:00.000Z",
        rawJson: "{}",
        updatedByUserId: currentUser.id,
        updatedByUsername: currentUser.username,
        createdAt: "2026-07-07T00:00:00.000Z",
        updatedAt: "2026-07-07T00:00:00.000Z",
      },
    ];
    makeOrderReadiness = { ...makeOrderReadiness, canExport: true, missingAddressCount: 0, missingStores: [] };
    return json({ fileName: "地址匹配表格.xlsx", sheetCount: 2, parsedRowCount: 2, importedAddressCount: 2, skippedRowCount: 0 }, 201);
  }
  if (url === "/api/v1/store-addresses" && method === "POST") {
    if (!["admin", "operator"].includes(currentUser.role)) return json({ message: "Forbidden" }, 403);
    const body = JSON.parse(String(init?.body));
    const existing = storeAddressRows.find((row) => row.storeNo === body.storeNo || row.storeName === body.storeName);
    const saved: StoreAddressDto = {
      id: existing?.id ?? "store-address-1",
      storeNo: body.storeNo ?? "",
      storeName: body.storeName,
      receiver: body.receiver,
      phone: body.phone,
      address: body.address,
      isVip: Boolean(body.isVip),
      note: body.note ?? "",
      sourceSheet: "手工维护",
      sourceRow: 0,
      importedAt: "",
      rawJson: "{}",
      updatedByUserId: currentUser.id,
      updatedByUsername: currentUser.username,
      createdAt: existing?.createdAt ?? "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    };
    storeAddressRows = existing ? storeAddressRows.map((row) => (row.id === existing.id ? saved : row)) : [saved, ...storeAddressRows];
    makeOrderReadiness = { ...makeOrderReadiness, canExport: true, missingAddressCount: 0, missingStores: [] };
    return json(saved, 201);
  }
  if (url.includes("/actions/run-mock-review")) return json({ batch: currentBatch });
  if (url.includes("/actions/rebuild-confirmed-order")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { strategy?: "preserve" | "replace" };
    const confirmed = mappingRows.find((mapping) => mapping.status === "confirmed");
    if (confirmed) {
      lines = lines.map((line) =>
        reviewLineMatchesMapping(line, confirmed)
          ? {
              ...line,
              goodsName: confirmed.wdtGoodsName,
              specName: confirmed.wdtSpecName,
              wdtSpecNo: confirmed.wdtSpecNo,
              wdtMakeOrderCode: confirmed.wdtMakeOrderCode || confirmed.wdtSpecNo,
              matchStatus: "matched",
              matchMessage: confirmedProductMappingMatchMessage,
              suggestedShipQty: line.plannedShipQty,
              suggestedWarehouseNo: "001",
              suggestedWarehouseName: "主仓",
              status: "库存充足",
              decision: "ship",
              approvedShipQty: line.plannedShipQty,
              fulfillmentWarehouseNo: "001",
              fulfillmentWarehouseName: "主仓",
              reason: "",
            }
          : line,
      );
    }
    if (body.strategy === "replace") {
      lines = lines.map((line) => ({
        ...line,
        decision: line.plannedShipQty === 0 ? "do_not_ship" : line.suggestedShipQty > 0 ? "ship" : "pending",
        approvedShipQty: line.plannedShipQty === 0 ? 0 : line.suggestedShipQty,
        fulfillmentWarehouseNo: line.plannedShipQty === 0 ? "" : line.suggestedWarehouseNo,
        fulfillmentWarehouseName: line.plannedShipQty === 0 ? "" : line.suggestedWarehouseName,
      }));
    }
    currentBatch = { ...currentBatch, status: "review_generated" };
    return json({
      batch: currentBatch,
      fileName: currentBatch.fileName,
      sheetName: "确定单",
      parsedRowCount: lines.length,
      matchedRowCount: lines.filter((line) => line.matchStatus === "matched").length,
      unmatchedRowCount: lines.filter((line) => line.matchStatus !== "matched").length,
      skippedRowCount: 0,
    });
  }
  if (url.includes("/actions/run-real-review")) {
    const confirmed = mappingRows.find((mapping) => mapping.status === "confirmed");
    if (confirmed) {
      lines = lines.map((line) =>
        reviewLineMatchesMapping(line, confirmed)
          ? {
              ...line,
              goodsName: confirmed.wdtGoodsName,
              specName: confirmed.wdtSpecName,
              wdtSpecNo: confirmed.wdtSpecNo,
              matchStatus: "matched",
              matchMessage: confirmedProductMappingMatchMessage,
              mainAvailableBefore: 20,
              suggestedShipQty: line.orderQty,
              status: "库存充足",
            }
          : line,
      );
    }
    return json({ batch: currentBatch, stockQueriedCount: 1 });
  }
  if (url.includes("/actions/bulk-approve")) {
    lines = lines.map((line) =>
      line.matchStatus === "matched" && (line.status === "库存充足" || line.status === "部分满足")
        ? { ...line, decision: "ship", approvedShipQty: line.suggestedShipQty, reason: "" }
        : line,
    );
    return json({ batch: currentBatch, updatedCount: 2 });
  }
  if (url.includes("/actions/submit-review")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { confirmUnverifiedStock?: boolean };
    const unverifiedStockCount = lines.filter(
      (line) => line.decision === "ship" && line.approvedShipQty > 0 && Boolean(line.stockErrorDetail?.trim()),
    ).length;
    if (unverifiedStockCount > 0 && !body.confirmUnverifiedStock) {
      return json({
        requiresConfirmation: true,
        code: "UNVERIFIED_STOCK",
        affectedCount: unverifiedStockCount,
        message: `有 ${unverifiedStockCount} 条明细未完成库存校验，当前结果依赖人工决定`,
      }, 409);
    }
    currentBatch = { ...currentBatch, status: "reviewed" };
    return json({ requiresConfirmation: false, batch: currentBatch, pendingCount: 1, shipCount: 2, doNotShipCount: 0 });
  }
  if (url.endsWith("/exports") && method === "GET") return json(exportRows);
  if (url.endsWith("/exports") && method === "POST") {
    const body = JSON.parse(String(init?.body));
    const type = (body.type ?? "review") as ExportDto["type"];
    const created: ExportDto = {
      id: "export-1",
      batchId: "batch-1",
      type,
      status: "ready",
      fileName: `batch-1-${type}.${type === "wdt_import" ? "xls" : "xlsx"}`,
      downloadUrl: "/api/v1/exports/export-1/download",
      errorMessage: null,
      createdByUserId: "user-1",
      createdByUsername: "admin",
      createdAt: "2026-06-30T00:00:00.000Z",
    };
    exportRows = [created];
    return json(created, 201);
  }
  if (url.startsWith("/api/v1/product-mappings") && method === "GET") return json(filterProductMappings(url));
  if (url.startsWith("/api/v1/product-match-candidates") && method === "GET") return json(filterProductCandidates(url));
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
      wdtMakeOrderCode: body.wdtMakeOrderCode || body.wdtSpecNo,
      note: body.note,
      status: "confirmed",
    });
    mappingRows = [created];
    candidateRows = candidateRows.filter((candidate) => !candidateMatchesMapping(candidate, created));
    return json(created, 201);
  }
  if (url.includes("/api/v1/product-mappings/") && method === "DELETE") {
    const mappingId = url.split("/api/v1/product-mappings/")[1];
    const existing = mappingRows.find((item) => item.id === mappingId);
    if (!existing) return json({ message: "Product mapping not found" }, 404);
    mappingRows = mappingRows.filter((item) => item.id !== mappingId);
    return json({ mappingId, deleted: true });
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
    wdtMakeOrderCode: "3282770392869",
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

function filterProductMappings(url: string) {
  const query = decodeURIComponent(url.split("query=")[1] ?? "").trim().toLowerCase();
  if (!query) return mappingRows;
  return mappingRows.filter((mapping) =>
    [
      mapping.externalBarcode,
      mapping.externalGoodsCode,
      mapping.externalGoodsName,
      mapping.wdtSpecNo,
      mapping.wdtGoodsName,
    ].some((value) => value.toLowerCase().includes(query)),
  );
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
    stockTotalAvailable: 15,
    stockRows: [
      { warehouseNo: "001", warehouseName: "主仓", availableSendStock: 12, included: true },
      { warehouseNo: "LINQI", warehouseName: "临期仓", availableSendStock: 3, included: true },
      { warehouseNo: "CIPIN", warehouseName: "次品仓", availableSendStock: 99, included: false },
    ],
    createdAt: "2026-07-03T00:00:00.000Z",
    ...patch,
  };
}

function filterProductCandidates(url: string) {
  const query = decodeURIComponent(url.split("query=")[1] ?? "").trim().toLowerCase();
  if (!query) return candidateRows;
  return candidateRows.filter((candidate) =>
    [
      candidate.externalBarcode,
      candidate.externalGoodsCode,
      candidate.externalGoodsName,
      candidate.wdtSpecNo,
      candidate.wdtGoodsName,
    ].some((value) => value.toLowerCase().includes(query)),
  );
}

function externalProduct(patch: Partial<ExternalProductDto> = {}): ExternalProductDto {
  const id = patch.id ?? "external-product-1";
  const components = patch.components ?? [
    externalProductComponent({
      id: "external-product-component-1",
      externalProductId: id,
    }),
  ];
  return {
    id,
    type: "sample",
    externalBarcode: "690000000009",
    externalGoodsCode: "SAMPLE-OLD",
    externalGoodsName: "既有小样",
    status: "confirmed",
    sourceFileName: "旧维护表.xlsx",
    sourceSheet: "小样价格",
    sourceRow: 2,
    importedAt: "2026-07-07T00:00:00.000Z",
    rawJson: "{}",
    note: "",
    updatedByUserId: "user-1",
    updatedByUsername: "admin",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    components,
    ...patch,
  };
}

function externalProductComponent(
  patch: Partial<ExternalProductDto["components"][number]> = {},
): ExternalProductDto["components"][number] {
  return {
    id: "external-product-component-1",
    externalProductId: "external-product-1",
    sortOrder: 1,
    role: "primary",
    componentBarcode: "690000000009",
    componentGoodsCode: "SAMPLE-OLD",
    componentName: "既有小样",
    componentSpec: "",
    quantityMultiplier: 1,
    wdtSpecNo: "SPEC-OLD",
    wdtGoodsNo: "GOODS-OLD",
    wdtGoodsName: "既有小样 WDT",
    wdtSpecName: "1ml",
    wdtBarcode: "690000000009",
    matchStatus: "unique_wdt_hit",
    matchMessage: "唯一命中 WDT 规格",
    note: "",
    sourceSheet: "小样价格",
    sourceRow: 2,
    rawJson: "{}",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...patch,
  };
}

function externalProductComponentPreview(
  patch: Partial<ExternalProductImportComponentPreview> = {},
): ExternalProductImportComponentPreview {
  return {
    role: "primary",
    componentBarcode: "690000000001",
    componentGoodsCode: "",
    componentName: "",
    componentSpec: "",
    quantityMultiplier: 1,
    wdtSpecNo: "SPEC-SAMPLE-1",
    wdtGoodsNo: "GOODS-SAMPLE-1",
    wdtGoodsName: "小样 WDT",
    wdtSpecName: "1ml",
    wdtBarcode: "690000000001",
    matchStatus: "unique_wdt_hit",
    matchMessage: "唯一命中 WDT 规格",
    note: "",
    sourceSheet: "小样价格",
    sourceRow: 2,
    rawJson: "{}",
    ...patch,
  };
}

function candidateMatchesMapping(candidate: ProductMatchCandidateDto, mapping: ProductMappingDto) {
  return (
    sameIdentifier(candidate.externalBarcode, mapping.externalBarcode) ||
    sameIdentifier(candidate.externalGoodsCode, mapping.externalGoodsCode) ||
    (!mapping.externalBarcode && !mapping.externalGoodsCode && sameIdentifier(candidate.externalGoodsName, mapping.externalGoodsName))
  );
}

function reviewLineMatchesMapping(line: ReviewLineDto, mapping: ProductMappingDto) {
  return (
    sameIdentifier(line.externalBarcode, mapping.externalBarcode) ||
    sameIdentifier(line.externalGoodsCode, mapping.externalGoodsCode) ||
    (!mapping.externalBarcode && !mapping.externalGoodsCode && sameIdentifier(line.externalGoodsName, mapping.externalGoodsName))
  );
}

function sameIdentifier(left: string, right: string) {
  return Boolean(left.trim() && right.trim() && left.trim().toLowerCase() === right.trim().toLowerCase());
}

function wdtSpec(patch: Partial<WdtGoodsSpecSearchResultDto> = {}): WdtGoodsSpecSearchResultDto {
  return {
    id: "wdt-goods-spec-3282770392869",
    source: "goods",
    goodsNo: "3282770392869",
    goodsName: "雅漾专研保湿修护面膜",
    specNo: "3282770392869",
    specName: "25ml*5",
    specCode: "",
    makeOrderCode: "3282770392869",
    barcode: "3282770392869",
    barcodes: ["3282770392869"],
    deleted: 0,
    modified: "2026-07-01 00:00:00",
    stockTotalAvailable: 15,
    stockRows: [
      { warehouseNo: "001", warehouseName: "主仓", availableSendStock: 12, included: true },
      { warehouseNo: "LINQI", warehouseName: "临期仓", availableSendStock: 3, included: true },
      { warehouseNo: "CIPIN", warehouseName: "次品仓", availableSendStock: 99, included: false },
    ],
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

function combinedSyncRun(patch: Partial<WdtSyncRunDto> = {}): WdtSyncRunDto {
  return {
    id: "wdt-sync-1",
    trigger: "hourly",
    status: "success",
    stage: "complete",
    goodsSyncRunId: "sync-1",
    totalSpecCount: 3829,
    processedSpecCount: 3829,
    totalBatchCount: 96,
    completedBatchCount: 96,
    stockRowCount: 5000,
    startedAt: "2026-07-03T00:00:00.000Z",
    finishedAt: "2026-07-03T00:02:00.000Z",
    lastProgressAt: "2026-07-03T00:02:00.000Z",
    activeSnapshotRunId: "wdt-sync-1",
    activeSnapshotAt: "2026-07-03T00:02:00.000Z",
    activeSnapshotTrigger: "hourly",
    activeSnapshotWarehouseTypes: ["main", "near_expiry"],
    activeSnapshotMissingWarehouseTypes: [],
    errorCode: "",
    errorMessage: "",
    errorDetail: "",
    ...patch,
  };
}

function warehouseUsageSettings(patch: Partial<WarehouseUsageSettingsDto> = {}): WarehouseUsageSettingsDto {
  return {
    includeMainWarehouse: true,
    includeNearExpiryWarehouse: true,
    includeDefectWarehouse: false,
    includeOtherWarehouses: false,
    updatedAt: "2026-07-03T00:00:00.000Z",
    updatedByUserId: null,
    updatedByUsername: null,
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
    orderApprovalNo: "",
    readingStatus: "",
    deliveryMode: "",
    orderStatus: "",
    deliveryTarget: "",
    category: "",
    orderDate: "",
    deadlineDate: "",
    salesperson: "",
    maker: "",
    madeAt: "",
    sourceReviewer: "",
    externalGoodsCode: "",
    externalBarcode: "BARCODE",
    externalGoodsName: "商品",
    originalSpec: "",
    transportSpec: "",
    orderBoxQty: "",
    taxExcludedUnitPrice: "",
    contractPrice: "",
    taxIncludedUnitPrice: "",
    discountRate: "",
    shelfLifeDays: "",
    receivedQty: "",
    giftRate: "",
    td: "",
    da: "",
    pd: "",
    spd: "",
    rebate: "",
    orderRawJson: "{}",
    goodsName: "商品",
    specName: "规格",
    wdtSpecNo: "SPEC",
    wdtMakeOrderCode: "SPEC",
    matchStatus: "matched",
    matchMessage: "matched",
    orderQty: 5,
    plannedShipQty: 5,
    mainAvailableBefore: 5,
    nearExpiryAvailableBefore: 0,
    suggestedShipQty: 5,
    suggestedWarehouseNo: "001",
    suggestedWarehouseName: "主仓",
    status: "库存充足",
    decision: "pending",
    approvedShipQty: 0,
    fulfillmentWarehouseNo: "",
    fulfillmentWarehouseName: "",
    reason: "",
    priority: false,
    priorityReason: "",
    ...patch,
  };
}
