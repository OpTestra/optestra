import { defineConfig, devices } from "@playwright/test";

// Runs the generated specs with plain Playwright, no __NAME__ needed:
//   npx playwright test -c __SPEC_DIR__
// Point them at another site with __ENV_PREFIX__BASE_URL (and __ENV_PREFIX__ALLOWED_DOMAINS).
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: __TIMEOUT__,
  retries: __RETRIES__,
  use: {
    baseURL: process.env.__ENV_PREFIX__BASE_URL ?? __BASE_URL__,
    actionTimeout: 5_000,
    navigationTimeout: 30_000,
    serviceWorkers: "block",
    acceptDownloads: false,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
