import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const shop = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, "lint", ...args], { cwd, encoding: "utf8" });
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-lint-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const WEAK = [
  "---",
  "name: Weak test",
  "start: /login",
  "---",
  "",
  "1. Log in normally",
  '2. Fill "Password" with hunter2hunter2',
  "3. Expect: it works",
  "",
].join("\n");

const FIXABLE = [
  "---",
  "name: New user signs up",
  "start: /signup",
  "---",
  "",
  '1. Fill "Email" with ada@example.com',
  '2. Fill "Password" with {{secret.PW}}',
  '3. Click "Sign up"',
  '4. Expect: the page heading is "Check your email"',
  "5. Expect: the page mentions ada@example.com",
  '6. Click "Continue"',
  "7. Wait 3 seconds",
  "",
].join("\n");

describe("lint", { timeout: 30_000 }, () => {
  it("finds nothing in the demo shop", () => {
    const result = run(shop);
    expect(result.stdout).toBe("No problems found in 12 files.\n");
    expect(result.status).toBe(0);
  });

  it("reports weak tests grouped by file, one line each, and exits 1", () => {
    const dir = project({ "tests/weak.test.md": WEAK });
    const result = run(dir);
    expect(result.status).toBe(1);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("tests/weak.test.md");
    expect(
      lines.slice(1, 5).map((l) =>
        l
          .trim()
          .split(/\s{2,}/)
          .slice(0, 3),
      ),
    ).toEqual([
      ["tests/weak.test.md:2:1", "error", "no-expectations"],
      ["tests/weak.test.md:6:4", "warning", "vague-step"],
      ["tests/weak.test.md:7:25", "warning", "literal-credential"],
      ["tests/weak.test.md:8:12", "warning", "expect-not-observable"],
    ]);
    expect(result.stdout).toContain("4 problems (1 error, 3 warnings, 0 info) in 1 of 1 files.");
    const json = JSON.parse(run(dir, "--json").stdout);
    expect(json.exitCode).toBe(1);
    expect(json.files[0].findings.map((f: { rule: string }) => f.rule)).toEqual([
      "no-expectations",
      "vague-step",
      "literal-credential",
      "expect-not-observable",
    ]);
  });

  it("--fix changes only non-expectation lines, and a second run changes nothing", () => {
    const dir = project({ "tests/signup.test.md": FIXABLE });
    const file = join(dir, "tests/signup.test.md");
    const first = run(dir, "--fix");
    expect(first.stdout).toContain(
      "Fixed tests/signup.test.md:12  fixed-wait  Remove the fixed wait",
    );
    const after = readFileSync(file, "utf8");
    // The email also appears in an Expect: line, so its fix is not safe and is not applied.
    expect(after).toBe(FIXABLE.replace("7. Wait 3 seconds\n", ""));
    const checks = (text: string) =>
      text.split("\n").filter((l) => /^\d+\. (Expect|Soft|Never):|^Never:/.test(l));
    expect(checks(after)).toEqual(checks(FIXABLE));
    expect(first.stdout).toContain("fixed-email");
    const second = run(dir, "--fix");
    expect(second.stdout).not.toContain("Fixed ");
    expect(readFileSync(file, "utf8")).toBe(after);
  });

  it("--strict and lint.strict make warnings fail", () => {
    const text = WEAK.replace("3. Expect: it works", '3. Expect: the heading is "Hi"');
    const dir = project({ "tests/a.test.md": text });
    expect(run(dir).status).toBe(0);
    expect(run(dir, "--strict").status).toBe(1);
    const settings = (lint: string) =>
      project({
        "tests/a.test.md": text,
        [brand.configFileName]: `version: 1\nproject: { name: X, target: web }\nlint:\n${lint}\n`,
      });
    expect(run(settings("  strict: true")).status).toBe(1);
    const quiet = settings(
      "  strict: true\n  rules:\n    literal-credential: off\n    vague-step: info\n    no-such-rule: error",
    );
    const result = run(quiet);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lint.rules.no-such-rule is not a lint rule");
    expect(result.stdout).toMatch(/info\s+vague-step/);
  });

  it("exits 2 when a file can't be parsed or a path is missing", () => {
    const dir = project({ "tests/broken.test.md": 'no frontmatter\n1. Click "Go"\n' });
    expect(run(dir).status).toBe(2);
    expect(run(dir, "tests/nope.test.md").status).toBe(2);
  });

  it("reports project-level problems: duplicate names and unused flows", () => {
    const test = (name: string) =>
      `---\nname: ${name}\nstart: /x\n---\n\n1. Click "Go"\n2. Expect: the heading is "Hi"\n`;
    const dir = project({
      "tests/a.test.md": test("Same name"),
      "tests/b.test.md": test("Same name"),
      "tests/flows/old.test.md": "---\nname: Old\nkind: flow\n---\n\n1. Go to /old\n",
    });
    const json = JSON.parse(run(dir, "--json").stdout);
    const rules = json.files.flatMap((f: { findings: { rule: string; file: string }[] }) =>
      f.findings.map((x) => `${x.file} ${x.rule}`),
    );
    expect(rules).toEqual([
      "tests/a.test.md duplicate-test-name",
      "tests/b.test.md duplicate-test-name",
      "tests/flows/old.test.md unused-flow",
    ]);
    expect(json.exitCode).toBe(0);
  });
});
