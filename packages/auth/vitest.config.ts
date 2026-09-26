import { defineConfig } from "vitest/config";

// Real-browser and Mailpit tests. Not part of `pnpm check` (which stays browser-free);
// run by `pnpm bench:fixtures:test` and the CI `fixtures` job.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
