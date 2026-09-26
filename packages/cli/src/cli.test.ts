import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { version } from "@testament/core";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

describe("cli", () => {
  it("--version prints the engine version", () => {
    const result = run("--version");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version());
  });

  it("--help shows usage under the branded name", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Usage: ${brand.cliName}`);
    expect(result.stdout).toContain("--version");
  });
});
