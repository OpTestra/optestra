import { defineConfig } from "vitest/config";

// The HTML report in a real browser: axe, no network, JS disabled. Not part of
// `pnpm check`; run by `pnpm bench:fixtures:test` and CI `fixtures`.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
