import { defineConfig } from "vitest/config";

// Generated specs run with plain Playwright against the real demo shop, from a
// temp project that has only @playwright/test. Not part of `pnpm check`; run by
// `pnpm bench:fixtures:test` and CI `fixtures`.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
