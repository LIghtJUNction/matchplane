import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    // Next-compatible modules and jsdom can take longer to boot on CI runners. Avoid turning
    // a slow interaction test into a flaky failure under the default five-second budget.
    testTimeout: 15_000,
  },
});
