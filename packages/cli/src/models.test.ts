import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cli-models-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];
// PATH is emptied so a subscription CLI installed on this machine (claude, codex) can't make a role usable.
const baseEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !KEY_VARS.includes(key))),
  PATH: dir,
};
const run = (env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [bin, "models", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...baseEnv, ...env },
  });

describe("models command", { timeout: 30_000 }, () => {
  it("resolves planner and fixer from defaults with only ANTHROPIC_API_KEY set", () => {
    const result = run({ ANTHROPIC_API_KEY: "sk-ant-cli-test-9f8e7d" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /1\s+anthropic\s+claude-sonnet-5-5\s+ANTHROPIC_API_KEY set\s+-\s+ready/,
    );
    expect(result.stdout).toMatch(
      /1\s+anthropic\s+claude-sonnet-5-5\s+ANTHROPIC_API_KEY set\s+-\s+ready/,
    );
    expect(result.stdout).not.toContain("sk-ant-cli-test");
  });

  it("exits 2 with a clear fix when no key is set", () => {
    const result = run({});
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("No usable model for the planner role.");
    expect(result.stdout).toContain(
      "Fix: Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY",
    );
  });

  it("prints JSON with --json", () => {
    const output = JSON.parse(run({ GEMINI_API_KEY: "gm-test-123456" }, "--json").stdout);
    expect(output.roles.planner[2]).toMatchObject({
      provider: "google",
      model: "gemini-3.8-flash",
      usable: true,
    });
    expect(output.providers.google.keyStatus).toBe("set");
    expect(output.problems).toEqual([]);
  });
});
