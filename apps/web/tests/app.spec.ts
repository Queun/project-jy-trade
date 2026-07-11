import { expect, test, type Page } from "@playwright/test";

test("checks the stock snapshot sync UI without starting a real sync", async ({ page }) => {
  const syncStartRequests: string[] = [];
  const activeSnapshotAt = new Date().toISOString();
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/wdt/sync-runs") {
      syncStartRequests.push(request.url());
    }
  });
  await page.route("**/api/v1/wdt/sync-runs/latest", async (route) => {
    await route.fulfill({
      json: {
        id: "e2e-hourly-sync",
        trigger: "hourly",
        status: "success",
        stage: "complete",
        goodsSyncRunId: "e2e-goods-sync",
        totalSpecCount: 100,
        processedSpecCount: 100,
        totalBatchCount: 3,
        completedBatchCount: 3,
        stockRowCount: 200,
        startedAt: activeSnapshotAt,
        finishedAt: activeSnapshotAt,
        lastProgressAt: activeSnapshotAt,
        activeSnapshotRunId: "e2e-hourly-sync",
        activeSnapshotAt,
        activeSnapshotTrigger: "hourly",
        errorCode: "",
        errorMessage: "",
        errorDetail: "",
      },
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("yjmy");
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("heading", { name: "订单处理工作台" })).toBeVisible();

  const header = page.locator("header");
  await expect(header.getByText("库存快照", { exact: true })).toBeVisible();
  await expect(header.getByText("可用", { exact: true })).toBeVisible();
  await expect(header.getByText("来源：整点自动", { exact: true })).toBeVisible();

  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "设置" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置" });
  await expect(settingsDialog).toBeVisible();

  const syncHeading = settingsDialog.getByRole("heading", { name: "商品与库存同步" });
  await expect(syncHeading).toBeVisible();
  const syncSection = syncHeading.locator("xpath=ancestor::section[1]");
  await expect(syncSection.getByText(/每小时整点自动更新/)).toBeVisible();

  const snapshotSummary = syncSection.getByText(/^当前库存快照：/);
  await expect(snapshotSummary).toBeVisible();
  await expect(snapshotSummary).toHaveText(/^当前库存快照：.+ · 来源：整点自动$/);

  const syncButton = syncSection.getByRole("button", { name: "立即同步" });
  await expect(syncButton).toBeVisible();
  await expect(syncButton).toBeEnabled();
  await expectNoHorizontalOverflow(page);

  await settingsDialog.getByRole("button", { name: "关闭" }).click();
  await expect(settingsDialog).toBeHidden();
  expect(syncStartRequests).toEqual([]);

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
  expect(syncStartRequests).toEqual([]);
});

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
}
