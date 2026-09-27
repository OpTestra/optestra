import { defineConfig } from "vitest/config";

// Emulator tests against the Android fixture app. Not part of `pnpm check` (which
// needs no Android SDK); run by `pnpm --filter @testament/android test:android`
// and the CI `android` job.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
