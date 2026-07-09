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
let warehouseSettings: WarehouseUsageSettingsDto;
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
    warehouseSettings = warehouseUsageSettings();
    storeAddressRows = [];
    externalProductRows = [externalProduct()];
    makeOrderReadiness = {
      batchId: "batch-1",
      canExport: false,
      shippableLineCount: 2,
      missingAddressCount: 1,
      missingStores: [{ storeNo: "STORE", storeName: "测试门店", shippableLineCount: 2, orderNoticeNos: ["ORDER-1"] }],
    };
    currentUser = { id: "user-1", username: "admin", role: "admin", createdAt: "2026-06-30T00:00:00.000Z" };
    failReviewLines = false;
    batchDeleted = false;
    vi.stubGlobal("fetch", vi.fn(handleFetch));
    vi.stubGlobal("confirm", vi.fn(() => true));
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
    expect(screen.getByText("已定位到商品映射面板，保存长期映射后会自动刷新当前正式批次")).toBeInTheDocument();
    expect(screen.getByLabelText("映射搜索")).toHaveValue("BARCODE");
    expect(screen.getByLabelText("外部条码")).toHaveValue("BARCODE");
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
    expect(screen.getByText("商品档案同步可用后才能导入新订单；确定单可先导入，但商品匹配依赖本地已有商品档案和人工映射。")).toBeInTheDocument();
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

    expect(await screen.findByText(/商品档案/)).toBeInTheDocument();
    expect(screen.getByText(/上次更新：/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(await screen.findByText("可用仓库范围")).toBeInTheDocument();
    expect(screen.getByText("商品档案同步")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "手动同步" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/v1/wdt/goods-sync-runs",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "incremental" }) }),
    ));
    expect(await screen.findByText("商品档案同步完成")).toBeInTheDocument();
    const nearExpiry = screen.getByRole("checkbox", { name: "临期仓" });
    const other = screen.getByRole("checkbox", { name: "其他仓" });

    expect(nearExpiry).toBeChecked();
    fireEvent.click(nearExpiry);
    fireEvent.click(other);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(warehouseSettings.includeNearExpiryWarehouse).toBe(false));
    expect(warehouseSettings.includeOtherWarehouses).toBe(true);
    expect(await screen.findByText("已保存，重新运行初审后生效")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "手动同步" })).not.toBeDisabled();
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

  it("imports confirmed orders directly into make-order flow", async () => {
    render(<App />);

    const file = new File(["confirmed"], "确定单.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.change(await screen.findByLabelText("选择文件"), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "导入确定单" }));

    expect(await screen.findByText("确定单导入成功，可以直接进入做单")).toBeInTheDocument();
    expect(screen.getByText(/确定单已导入/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成做单表格" })).toBeInTheDocument();
    expect(currentBatch.status).toBe("reviewed");
    expect(currentBatch.fileName).toBe("确定单.xlsx");
  });

  it("blocks real review when latest goods sync failed", async () => {
    latestGoodsSyncRun = goodsSyncRun({ status: "failed", errorMessage: "fetch failed" });
    render(<App />);

    expect(await screen.findByText("需刷新")).toBeInTheDocument();
    const importButton = await screen.findByRole("button", { name: "导入新订单" });

    expect(importButton).toBeDisabled();
    expect(screen.getByText("商品档案同步可用后才能导入新订单；确定单可先导入，但商品匹配依赖本地已有商品档案和人工映射。")).toBeInTheDocument();
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
    expect(screen.getByText("可做单 2 行 / 缺地址 1 个门店")).toBeInTheDocument();
    expect(screen.getByText("测试门店")).toBeInTheDocument();
    expect(screen.getByText("2 行待做单")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去地址维护" })).toBeInTheDocument();
  });

  it("saves store addresses from the address maintenance tab opened by the export tab", async () => {
    currentBatch = { ...currentBatch, status: "reviewed" };
    render(<App />);
    await clickBatch();
    switchToExportTab();

    fireEvent.click(await screen.findByRole("button", { name: "去地址维护" }));
    expect(screen.getByTestId("maintenance-tab-addresses")).toHaveTextContent("地址维护");
    expect(await screen.findByText("门店地址维护")).toBeInTheDocument();
    expect(screen.getByText("历史批次")).toBeInTheDocument();
    expect(screen.getAllByText("订货通知单 .xls").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: "测试门店" }));
    fireEvent.change(screen.getByLabelText("收件人"), { target: { value: "张三" } });
    fireEvent.change(screen.getByLabelText("手机"), { target: { value: "18800000000" } });
    fireEvent.change(screen.getByLabelText("地址"), { target: { value: "深圳市南山区测试地址" } });
    fireEvent.click(screen.getByRole("button", { name: "保存地址" }));

    expect(await screen.findByText("门店地址已保存")).toBeInTheDocument();
    expect(await screen.findByText("张三 / 18800000000")).toBeInTheDocument();
    expect(screen.getByText("深圳市南山区测试地址")).toBeInTheDocument();
  });

  it("imports store addresses from the address maintenance tab", async () => {
    currentBatch = { ...currentBatch, status: "reviewed" };
    render(<App />);
    await clickBatch();
    switchToExportTab();

    fireEvent.click(await screen.findByRole("button", { name: "去地址维护" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "去地址维护" }));
    expect(await screen.findByText("门店地址维护")).toBeInTheDocument();
    expect(screen.getByText("当前账号只能查看门店地址。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存地址" })).toBeDisabled();
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
    fireEvent.click(screen.getByRole("button", { name: "保存长期映射" }));

    expect(await screen.findByText("长期商品映射已保存，正式订单重新初审后生效")).toBeInTheDocument();
    expect(mappingRows[0]).toMatchObject({
      externalBarcode: "2153722460015",
      externalGoodsCode: "5372246",
      wdtSpecNo: "3282770392869",
      status: "confirmed",
    });
  });

  it("refreshes the active production batch after confirming a product mapping", async () => {
    currentBatch = { ...currentBatch, mode: "production_api" };
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
    fireEvent.click(screen.getByRole("checkbox", { name: "开发者模式" }));
    switchToReviewTab();

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
    return json(warehouseSettings);
  }
  if (url === "/api/v1/batches" && method === "GET") return json(batchDeleted ? [] : [currentBatch]);
  if (url === "/api/v1/batches" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    currentBatch = { ...currentBatch, fileName: body.fileName ?? currentBatch.fileName, mode: body.mode ?? currentBatch.mode };
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
      status: "reviewed",
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
              matchMessage: "Matched by confirmed product mapping",
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
    currentBatch = { ...currentBatch, status: "reviewed" };
    return json({ batch: currentBatch, pendingCount: 1, shipCount: 2, doNotShipCount: 0 });
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
    candidateRows = candidateRows.filter((candidate) => !candidateMatchesMapping(candidate, created));
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
