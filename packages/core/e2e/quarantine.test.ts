import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import { exitCodeFor } from "@optestra/contract";
import { startShop } from "@optestra/fixture-shop";
import { afterAll, describe, expect, it } from "vitest";
import { runTests } from "../src/run/runner.js";

// Quarantine (DIA-5) on the real shop: a muted test runs, fails (broken-total
// charges $29.00 during a trial), keeps its evidence, and doesn't fail the run.
// An expired mute counts again, and the run says so.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(until: string): string {
  const dir = mkdtempSync(join(tmpdir(), "quarantine-e2e-"));
  dirs.push(dir);
  const file = join(dir, brand.configFileName);
  cpSync(join(SHOP, "tests"), join(dir, "tests"), { recursive: true });
  writeFileSync(
    file,
    `${readFileSync(join(SHOP, brand.configFileName), "utf8")}\nquarantine:\n  - test: tests/billing-zero-due.test.md\n    reason: trial billing bug (#7)\n    until: "${until}"\n`,
  );
  return dir;
}

async function run(dir: string) {
  const shop = await startShop({ variant: "broken-total", port: 0 });
  const logs: string[] = [];
  try {
    const result = await runTests({
      projectDir: dir,
      tests: [join(dir, "tests/billing-zero-due.test.md"), join(dir, "tests/login.test.md")],
      mode: "replay-only",
      retries: 0,
      video: false,
      generateSpecs: false,
      models: null,
      evidence: "full",
      onEvent: (event) => {
        if (event.type === "log") logs.push(event.message);
      },
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        SHOP_PASSWORD: "shop-demo-pass",
      },
    });
    return { result, logs };
  } finally {
    await shop.stop();
  }
}

describe("quarantine on the shop", () => {
  it("a muted failing test runs with evidence and doesn't fail the run", async () => {
    const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const { result, logs } = await run(project(inAMonth));
    const billing = result.tests.find((t) => t.file === "tests/billing-zero-due.test.md");
    const login = result.tests.find((t) => t.file === "tests/login.test.md");
    expect(billing?.verdict).toBe("failed");
    expect(billing?.muted).toMatchObject({ reason: "trial billing bug (#7)" });
    expect(billing?.attempts[0]?.artifacts.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["screenshot", "trace"]),
    );
    expect(login?.verdict).toBe("passed");
    expect(result.run.totals).toMatchObject({ failed: 1, passed: 1, muted: 1 });
    expect(result.run.tests.find((t) => t.file === billing?.file)?.muted).toBe(true);
    expect(exitCodeFor(result.run, { healedCountsAsPass: false })).toBe(0);
    expect(logs.join("\n")).toMatch(
      /is muted until .* \("trial billing bug \(#7\)"\): it ran \(failed\), and doesn't count/,
    );
  });

  it("an expired mute counts again, and the run says so", async () => {
    const { result, logs } = await run(project("2026-01-01"));
    const billing = result.tests.find((t) => t.file === "tests/billing-zero-due.test.md");
    expect(billing?.muted).toBeUndefined();
    expect(billing?.muteExpired).toMatchObject({ until: "2026-01-01" });
    expect(exitCodeFor(result.run, { healedCountsAsPass: false })).toBe(1);
    expect(logs.join("\n")).toMatch(
      /The mute of tests\/billing-zero-due\.test\.md ended on 2026-01-01 .*: it counts again/,
    );
  });
});
