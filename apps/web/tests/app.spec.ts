import { expect, test } from "@playwright/test";

test("logs in, runs review workflow, exports, and logs out", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin123");
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("heading", { name: "批次审核工作台" })).toBeVisible();
  await page.getByRole("button", { name: "创建批次并初审" }).click();
  await expect(page.getByText("mock 初审已完成")).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await page.getByRole("button", { name: "批量通过可发项" }).click();
  await expect(page.getByText(/已批量通过/)).toBeVisible();

  const firstRow = page.locator("tbody tr").first();
  await firstRow.getByLabel(/审核发货数/).fill("999");
  await firstRow.getByLabel(/审核原因/).fill("人工确认额外库存");
  await firstRow.getByRole("button", { name: "保存" }).click();
  await expect(firstRow.getByText("超建议数")).toBeVisible();

  const secondRow = page.locator("tbody tr").nth(1);
  await secondRow.getByRole("button", { name: "不发" }).click();
  await expect(secondRow.getByText("不发货必须填写原因")).toBeVisible();
  await secondRow.getByLabel(/审核原因/).fill("负责人确认暂不发货");
  await secondRow.getByRole("button", { name: "保存" }).click();
  await expect(secondRow).toContainText("不发");

  await page.getByRole("button", { name: "提交审核完成" }).click();
  await expect(page.getByText(/审核已提交/)).toBeVisible();
  await expect(page.getByText("reviewed").first()).toBeVisible();

  await page.getByRole("button", { name: "生成导出" }).click();
  await expect(page.getByText("导出文件已生成")).toBeVisible();
  await expect(page.getByText("ready").first()).toBeVisible();

  await page.reload();
  await page.getByText("订货通知单 .xls").first().click();
  await expect(page.getByText("ready").first()).toBeVisible();

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
});
