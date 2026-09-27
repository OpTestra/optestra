import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const sample = fileURLToPath(new URL("../../config/examples/sample-project/", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-config-"));
  dirs.push(dir);
  for (const name of readdirSync(sample)) {
    cpSync(
      join(sample, name),
      join(dir, name === "config.yaml" ? brand.configFileName : `.${name}`),
    );
  }
  return dir;
}

const clean = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith(ENV_PREFIX)),
);
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, "config", ...args], { cwd, encoding: "utf8", env: clean });

const SECRET_VALUES = ["st@ging", "pa55", "tok_shared", "c3RAZ2luZ"];

describe("config command", { timeout: 30_000 }, () => {
  it("shows staging values with provenance and hides secret values", () => {
    const result = run(project(), "--env", "staging");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("staging (chosen with --env)");
    expect(result.stdout).toMatch(/run\.retries\s+2\s+environment "staging", line 23/);
    expect(result.stdout).toMatch(/run\.timeoutSeconds\s+300\s+default/);
    expect(result.stdout).toContain("[secret:TEST_PASSWORD] (set, from .env.staging)");
    for (const value of SECRET_VALUES) expect(result.stdout).not.toContain(value);
  });

  it("exits 2 with SECRET_MISSING and the fix when a secret is removed", () => {
    const dir = project();
    writeFileSync(join(dir, ".env.staging"), "# emptied\n");
    const result = run(dir, "--env", "staging");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("SECRET_MISSING");
    expect(result.stdout).toContain("Fix: Add TEST_PASSWORD=<value> to .env.staging");
    for (const value of SECRET_VALUES) expect(result.stdout).not.toContain(value);
  });

  it("prints JSON with --json", () => {
    const result = run(project(), "--json", "--env", "local");
    const output = JSON.parse(result.stdout);
    expect(output.environment.name).toBe("local");
    expect(output.config.run.retries).toBe(1);
    expect(output.secrets.TEST_PASSWORD).toEqual({
      status: "set",
      origin: ".env.local",
      domains: ["localhost"],
    });
    for (const value of SECRET_VALUES) expect(result.stdout).not.toContain(value);
  });

  it("exits 2 outside a project", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-empty-"));
    dirs.push(dir);
    const result = run(dir);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("PROJECT_NOT_FOUND");
  });
});
