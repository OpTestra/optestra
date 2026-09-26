import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const fixtures = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [bin, "results", ...args], { cwd: fixtures, encoding: "utf8" });
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("results command", () => {
  it("prints the failed test's headline and exits 1", () => {
    const result = run("failed-product-bug");
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAILED\s+12\.7s\s+\$0\.00\s+Discount code takes 10% off/);
    expect(result.stdout).toContain("Expected order total '$90.00', found '$100.00'");
    expect(result.stdout).toContain("1 passed, 1 failed");
  });

  it("exits 0 when all passed and 2 when blocked", () => {
    expect(run("all-passed").status).toBe(0);
    expect(run("android").status).toBe(0);
    expect(run("blocked-missing-secret").status).toBe(2);
    expect(run("blocked-budget-exceeded").stdout).toContain("$1.08");
  });

  it("applies the healed and flaky policy flags", () => {
    expect(run("healed").status).toBe(1);
    expect(run("healed", "--healed-passes").status).toBe(0);
    expect(run("flaky").status).toBe(1);
    expect(run("flaky", "--flaky-passes").status).toBe(0);
  });

  it("prints JSON with --json", () => {
    const output = JSON.parse(run("flaky", "--json").stdout);
    expect(output.exitCode).toBe(1);
    expect(output.summary.line).toBe("1 flaky");
    expect(output.run.tests[0].headline).toContain("503");
  });

  it("exits 2 with the problems when the run folder is unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-results-"));
    dirs.push(dir);
    cpSync(join(fixtures, "all-passed"), dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), "{ not json");
    const result = run(dir);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("run.json  not valid JSON");
  });
});
