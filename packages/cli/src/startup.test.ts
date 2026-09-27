import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Light commands must start without loading Playwright, the AI SDK, its provider
// packages or the engine (FIX-1: the CLI timed out on Windows because every
// command loaded all of them). A load hook in the child lists every module.

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const shop = fileURLToPath(new URL("../../../bench/fixtures/shop", import.meta.url));

const hook = `
import { registerHooks } from "node:module";
const loaded = [];
registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
process.on("exit", () => process.stderr.write("\\nLOADED " + JSON.stringify(loaded) + "\\n"));
`;

const HEAVY =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(playwright|playwright-core|ai|@ai-sdk\/[^/]+)\/|\/packages\/(browser|core|codegen)\/dist\//;

function loadedBy(args: string[]): string[] {
  const result = spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, bin, ...args],
    { cwd: shop, encoding: "utf8" },
  );
  const line = result.stderr.split("\n").find((l) => l.startsWith("LOADED "));
  if (!line) throw new Error(`no module list (exit ${result.status}):\n${result.stderr}`);
  return JSON.parse(line.slice("LOADED ".length)) as string[];
}

describe("startup", { timeout: 30_000 }, () => {
  it.each([
    ["--help"],
    ["--version"],
    ["config"],
    ["list"],
    ["show", "tests/create-project.test.md"],
    ["lint"],
  ])("%s loads no Playwright, AI SDK, provider package or engine", (...args) => {
    const loaded = loadedBy(args);
    expect(loaded.length).toBeGreaterThan(10);
    expect(loaded.filter((url) => HEAVY.test(url))).toEqual([]);
  });

  it("the check sees a heavy command's imports", () => {
    // `models` resolves providers, so it loads the AI SDK: proves the hook works.
    expect(loadedBy(["models", "--json"]).some((url) => HEAVY.test(url))).toBe(true);
  });
});
