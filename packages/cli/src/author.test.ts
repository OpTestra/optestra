import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Browser-free checks of `author`: it refuses before opening a browser when it
// can't possibly work. The real run is covered by the core browser tests and the
// manual real-model acceptance.

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const shop = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const noKeys = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/_API_KEY$/.test(name)),
);
const run = (...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], { cwd: shop, encoding: "utf8", env: noKeys });

describe("author", () => {
  it("exits 2 with a fix when no model key is available", () => {
    const result = run("author", "tests/login.test.md");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("No AI model is available for authoring");
    expect(result.stdout).toContain("Fix:");
  });

  it("exits 2 for a missing file, a flow, and an unknown environment", () => {
    expect(run("author", "tests/nope.test.md").status).toBe(2);
    const flow = run("author", "tests/flows/login.test.md");
    expect(flow.status).toBe(2);
    expect(flow.stdout).toContain("is a flow");
    expect(run("author", "tests/login.test.md", "--env", "staging").status).toBe(2);
  });
});
