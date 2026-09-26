import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BUILT_IN_DEFAULTS } from "./defaults.generated.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const ALLOWED_PACKAGES = new Set(["zod", "@testament/brand"]);

/** Every module reachable from `entry` through relative imports, plus the bare imports they make. */
function importGraph(entry: string) {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g,
    )) {
      const specifier = match[1] ?? match[2] ?? "";
      if (specifier.startsWith(".")) visit(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
      else bare.add(specifier);
    }
  };
  visit(join(SRC, entry));
  return { files, bare };
}

describe("browser entry", () => {
  it("imports nothing from node: or other Node-only packages", () => {
    const { bare } = importGraph("index.ts");
    expect([...bare].filter((s) => s.startsWith("node:"))).toEqual([]);
    expect([...bare].filter((s) => !ALLOWED_PACKAGES.has(s))).toEqual([]);
  });

  it("does not reach the node entry", () => {
    const { files } = importGraph("index.ts");
    expect([...files].filter((f) => f.includes(`${join(SRC, "node")}`))).toEqual([]);
  });
});

describe("defaults", () => {
  it("defaults.generated.ts matches defaults.yaml (run `pnpm --filter ./packages/config gen:defaults`)", () => {
    const yaml = parse(readFileSync(new URL("../defaults.yaml", import.meta.url), "utf8"));
    expect(BUILT_IN_DEFAULTS).toEqual(yaml);
  });
});
