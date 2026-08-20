import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // jsdom only exposes Web Storage for a non-opaque origin.  makepkg runs
    // checks as an unprivileged builder with a different HOME, so do not rely
    // on Vitest's implicit URL or localStorage becomes undefined there.
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
    setupFiles: "./src/test/setup.ts",
    exclude: ["**/.next/**", "**/node_modules/**"],
    css: true,
    // Next-compatible modules and jsdom can take longer to boot on CI runners. Avoid turning
    // a slow interaction test into a flaky failure under the default five-second budget.
    testTimeout: 15_000,
  },
});
