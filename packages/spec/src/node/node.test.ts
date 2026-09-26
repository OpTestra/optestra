import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "@testament/config";
import { afterAll, describe, expect, it } from "vitest";
import { matchGlob } from "../glob.js";
import { file } from "../spec.test-support.js";
import { findTestFiles, loadTests, nodeFileReader } from "./index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-node-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("tests config section", () => {
  it("is registered with defaults", () => {
    const { config, diagnostics } = resolveConfig({
      project: { version: 1, project: { name: "x", target: "web" } },
    });
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(config.tests).toEqual({ dir: "tests", include: ["**/*.test.md"] });
  });

  it("validates its values", () => {
    const { diagnostics } = resolveConfig({
      project: {
        version: 1,
        project: { name: "x", target: "web" },
        tests: { dir: "../elsewhere" },
      },
    });
    expect(diagnostics.map((d) => [d.code, d.path])).toContainEqual(["INVALID_VALUE", "tests.dir"]);
  });
});

describe("globs", () => {
  it("matches ** * ? and {a,b}", () => {
    expect(matchGlob("**/*.test.md", "a.test.md")).toBe(true);
    expect(matchGlob("**/*.test.md", "flows/deep/a.test.md")).toBe(true);
    expect(matchGlob("**/*.test.md", "a.md")).toBe(false);
    expect(matchGlob("*.test.md", "flows/a.test.md")).toBe(false);
    expect(matchGlob("{smoke,auth}/?.md", "auth/x.md")).toBe(true);
    expect(matchGlob("{smoke,auth}/?.md", "other/x.md")).toBe(false);
  });
});

describe("loadTests", () => {
  it("finds tests under tests.dir, separates flows, and reports secrets against the config", async () => {
    const dir = project({
      "suite/login.test.md": file("name: Login", [
        "1. Use: flows/login.test.md",
        "2. Type {{secret.OTHER}}",
      ]),
      "suite/flows/login.test.md": file(
        ["name: Log in", "kind: flow"],
        "1. Type {{secret.SHOP_PASSWORD}}",
      ),
      "suite/notes.md": "not a test",
      "suite/node_modules/x.test.md": file("name: ignored"),
      "tests/elsewhere.test.md": file("name: not in dir"),
    });
    const { config } = resolveConfig({
      project: {
        version: 1,
        project: { name: "x", target: "web" },
        tests: { dir: "suite" },
        secrets: { SHOP_PASSWORD: { domains: ["shop.test"] } },
      },
    });
    const loaded = await loadTests(dir, config);
    expect(loaded.dir).toBe("suite");
    expect(loaded.tests.map((t) => [t.id, t.path])).toEqual([
      ["suite__login.test", "suite/login.test.md"],
    ]);
    expect(loaded.flows.map((t) => t.path)).toEqual(["suite/flows/login.test.md"]);
    expect(loaded.tests[0]?.diagnostics.map((d) => d.code)).toEqual(["SECRET_UNDECLARED"]);
    expect(loaded.tests[0]?.expanded.steps).toHaveLength(2);
  });

  it("warns when there is no tests folder", async () => {
    const loaded = await loadTests(project({ "README.md": "hi" }), undefined);
    expect(loaded.tests).toEqual([]);
    expect(loaded.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["TESTS_DIR_MISSING", "warning"],
    ]);
  });

  it("lists files deterministically and never reads outside the project", async () => {
    const dir = project({
      "tests/b.test.md": "x",
      "tests/a/z.test.md": "x",
      "tests/a.test.md": "x",
    });
    expect(findTestFiles(dir)).toEqual(["tests/a.test.md", "tests/a/z.test.md", "tests/b.test.md"]);
    const read = nodeFileReader(join(dir, "tests"));
    expect(await read("a.test.md")).toBe("x");
    expect(await read("../tests/a.test.md")).toBeUndefined();
    expect(await read("missing.test.md")).toBeUndefined();
  });
});
