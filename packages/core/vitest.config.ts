import { defineConfig } from "vitest/config";

// The author against the real demo shop in a real browser, with a scripted model
// (no AI). Not part of `pnpm check`; run by `pnpm bench:fixtures:test` and CI `fixtures`.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
