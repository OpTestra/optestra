import { defineConfig, devices, type Project } from "@playwright/test";
import { VARIANTS } from "./src/index.js";

// One shop server per variant (plus two for the brittle suite), so suites never
// share state. Tests inside a project run in order; projects run in parallel.
// Ports start at SHOP_BASE_PORT (default 4300).

const basePort = Number(process.env.SHOP_BASE_PORT ?? 4300);
const servers = [
  ...VARIANTS.map((variant) => ({ suite: "semantic", variant })),
  { suite: "brittle", variant: "correct" },
  { suite: "brittle", variant: "cosmetic" },
].map((server, index) => ({ ...server, url: `http://127.0.0.1:${basePort + index}` }));

const projects: Project[] = servers.map(({ suite, variant, url }) => ({
  name: `${suite}:${variant}`,
  testMatch: suite === "semantic" ? "semantic.spec.ts" : "brittle.spec.ts",
  retries: suite === "semantic" ? 1 : 0,
  metadata: { suite, variant },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: url,
    ...(suite === "brittle" ? { actionTimeout: 3000 } : {}),
  },
}));

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 5000 },
  forbidOnly: Boolean(process.env.CI),
  workers: process.env.CI ? 4 : 6,
  reporter: [["list"], ["./e2e/verdict-reporter.ts"]],
  use: { trace: "retain-on-failure" },
  projects,
  webServer: servers.map(({ variant, url }) => ({
    command: `node dist/cli.js --variant ${variant} --port ${new URL(url).port}`,
    url: `${url}/pricing`,
    reuseExistingServer: false,
    stdout: "ignore" as const,
    stderr: "pipe" as const,
  })),
});
