import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { type RunningShop, startShop } from "@testament/fixture-shop";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runExportCommand } from "../src/commands/export.js";
import { runGenerateCommand } from "../src/commands/generate.js";
import { SHOP_PASSWORD, shopProject } from "../src/shop-project.test-support.js";

// For real, against the demo shop: doctor through the browser harness (Chromium,
// allowlisted requests), and an export that runs with `npm install` and plain
// `npx playwright test`, with nothing of ours installed.

let shop: RunningShop;
let models: Server;
let modelsUrl = "";
const project = shopProject("cli-e2e-");
const temps: string[] = [project];

beforeAll(async () => {
  shop = await startShop({ variant: "correct", port: 0 });
  models = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"object":"list","data":[]}');
  });
  await new Promise<void>((resolve) => models.listen(0, "127.0.0.1", resolve));
  modelsUrl = `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`;
  appendFileSync(
    join(project, brand.configFileName),
    `\nmodels:\n  providers:\n    local:\n      kind: openai-compatible\n      baseUrl: ${modelsUrl}\n  roles:\n    planner:\n      - { provider: local, model: m }\n    fixer:\n      - { provider: local, model: m }\n`,
  );
  const generated = await runGenerateCommand(
    [],
    { dir: project },
    { cwd: project, env: {}, stdout: () => {} },
  );
  expect(generated).toBe(0);
});

afterAll(async () => {
  await shop?.stop();
  await new Promise((resolve) => models?.close(resolve));
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const env = () => ({
  SHOP_PASSWORD,
  [`${ENV_PREFIX}BASE_URL`]: shop.url,
  [`${ENV_PREFIX}INBOX_PROVIDER`]: "none",
});

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("doctor with a real browser", () => {
  it("the healthy shop: Chromium starts and the base URL answers; exit 0", async () => {
    const report = await runDoctor({ dir: project, env: env() });
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.checks.find((c) => c.id === "browsers")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "base-url:local")).toMatchObject({
      status: "ok",
      message: `${shop.url} answers (HTTP 200).`,
    });
    expect(report.exitCode).toBe(0);
  });

  it("a base URL nothing listens on: fails with the fix", async () => {
    const dead = "http://127.0.0.1:9";
    const report = await runDoctor({
      dir: project,
      env: { ...env(), [`${ENV_PREFIX}BASE_URL`]: dead },
    });
    expect(report.checks.find((c) => c.id === "base-url:local")).toMatchObject({
      status: "fail",
      fix: `Start your app so it answers at ${dead}, or change environments.local.baseUrl in ${brand.configFileName}.`,
    });
  });
});

describe("export with plain Playwright", () => {
  it("npm install && npx playwright test runs green against the shop", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "cli-e2e-export-")), "tests");
    temps.push(join(out, ".."));
    let printed = "";
    const code = await runExportCommand(
      { out },
      { cwd: project, env: {}, stdout: (text) => (printed += text) },
    );
    expect(code, printed).toBe(0);

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const base = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH
        ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
        : {}),
    };
    const install = await run(npm, ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
      cwd: out,
      env: base,
    });
    expect(install.code, install.stderr).toBe(0);

    const report = join(out, "report.json");
    const tests = await run(
      npx,
      ["playwright", "test", "--project=chromium", "--workers=1", "--retries=0", "--reporter=json"],
      {
        cwd: out,
        env: {
          ...base,
          PLAYWRIGHT_JSON_OUTPUT_NAME: report,
          [`${ENV_PREFIX}BASE_URL`]: shop.url,
          SHOP_PASSWORD,
        },
      },
    );
    const json = JSON.parse(readFileSync(report, "utf8")) as {
      stats: { expected: number; unexpected: number; skipped: number; flaky: number };
    };
    expect(json.stats, `${tests.stdout}\n${tests.stderr}`).toEqual(
      expect.objectContaining({ unexpected: 0, flaky: 0 }),
    );
    // Seven recorded tests: the sign-up-with-email one skips without a Mailpit inbox.
    expect(json.stats.expected).toBe(6);
    expect(json.stats.skipped).toBe(1);
    expect(tests.code).toBe(0);
  });
});
