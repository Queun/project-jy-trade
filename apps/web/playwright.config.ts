import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "npm run dev -w @jy-trade/api",
      env: {
        WDT_AUTO_SYNC_ENABLED: "false",
      },
      port: 3001,
      reuseExistingServer: true,
    },
    {
      command: "npm run dev -w @jy-trade/web",
      port: 5173,
      reuseExistingServer: true,
    },
  ],
});
