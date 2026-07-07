import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/.vite/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "outputs/**",
      "data/**",
      "inputs/**",
      "apps/api/inputs/**",
      "ole案例文件——发货前/**",
    ],
  },
});
