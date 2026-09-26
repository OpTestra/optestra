import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const fixtures = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, "decisions", ...args], { cwd, encoding: "utf8" });

describe("decisions command", () => {
  it("lists page_is_error with its threshold and time limit, rules only by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-decisions-"));
    dirs.push(dir);
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Backend    none (rules only; unclear cases escalate)");
    expect(result.stdout).toMatch(/page_is_error\s+v1\s+during\s+0\.80\s+100 ms\s+on\s+fixer/);
  });

  it("applies project overrides and warns about unknown task names", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-decisions-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, brand.configFileName),
      [
        "version: 1",
        "project: { name: demo }",
        "environments: { local: { baseUrl: 'http://localhost:3000' } }",
        "decisions:",
        "  threshold: 0.7",
        "  tasks:",
        "    page_is_error: { threshold: 0.9, timeLimitMs: 250 }",
        "    typo_task: { enabled: false }",
        "",
      ].join("\n"),
    );
    const output = JSON.parse(run(dir, "--json").stdout);
    expect(output.threshold).toBe(0.7);
    expect(output.tasks[0]).toMatchObject({
      name: "page_is_error",
      threshold: 0.9,
      timeLimitMs: 250,
    });
    expect(output.problems[0].message).toContain("typo_task");
  });

  it("prints per-task metrics from a run folder with --stats", () => {
    const result = run(fixtures, "--stats", "flaky");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/failure_cause\s+1\s+100%\s+0%\s+0%/);
    const json = JSON.parse(run(fixtures, "--stats", "flaky", "--json").stdout);
    expect(json.tasks.flaky_or_real).toMatchObject({ total: 1, rules: 1, cacheHits: null });
    expect(run(fixtures, "--stats", "no-such-run").status).toBe(2);
  });
});
