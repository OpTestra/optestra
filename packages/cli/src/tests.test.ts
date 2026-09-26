import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const shop = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env } });
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-tests-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("list", () => {
  it("lists every runnable shop test with zero problems; the login flow is not a test", () => {
    const result = run(shop, "list");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("11 tests, 1 flow in tests/.");
    expect(result.stdout).toContain("No problems found.");
    expect(result.stdout).toMatch(
      /tests__create-project\.test\s+A new project is saved\s+smoke, projects\s+13\s+0/,
    );
    expect(result.stdout).not.toContain("tests__flows__login");
  });

  it("filters by tag and prints JSON", () => {
    const result = run(shop, "list", "--tag", "payments", "--json");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.tests.map((t: { path: string }) => t.path)).toEqual([
      "tests/billing-zero-due.test.md",
      "tests/checkout-trial.test.md",
      "tests/declined-card.test.md",
    ]);
    expect(output.flows).toEqual([
      { id: "tests__flows__login.test", path: "tests/flows/login.test.md", name: "Log in" },
    ]);
  });
});

describe("show", () => {
  it("shows the login flow inlined with origins and the password unresolved", () => {
    const result = run(shop, "show", "tests/create-project.test.md", "--expanded");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /2\s+action\s+Fill "Email" with ada@example\.com\s+tests\/flows\/login\.test\.md:11 ← tests\/create-project\.test\.md:9/,
    );
    expect(result.stdout).toContain('Fill "Password" with {{secret.SHOP_PASSWORD}}');
    expect(result.stdout).toMatch(
      /6\s+action\s+Click "Create project"\s+tests\/create-project\.test\.md:10/,
    );
  });

  it("shows the file as written without --expanded, and JSON with --json", () => {
    const plain = run(shop, "show", "tests/checkout-trial.test.md");
    expect(plain.status).toBe(0);
    expect(plain.stdout).toMatch(
      /2\.\s+action\s+Sign up with \{\{data\.email\}\} and password \{\{secret\.SHOP_PASSWORD\}\}\s+line 12/,
    );
    expect(plain.stdout).toMatch(/-\s+guard\s+click "Delete account"/);
    const json = JSON.parse(
      run(shop, "show", "tests/checkout-trial.test.md", "--expanded", "--json", "--seed", "a")
        .stdout,
    );
    const again = JSON.parse(
      run(shop, "show", "tests/checkout-trial.test.md", "--expanded", "--json", "--seed", "a")
        .stdout,
    );
    const other = JSON.parse(
      run(shop, "show", "tests/checkout-trial.test.md", "--expanded", "--json", "--seed", "b")
        .stdout,
    );
    expect(json.expanded.data.email.display).toBe(again.expanded.data.email.display);
    expect(json.expanded.data.email.display).not.toBe(other.expanded.data.email.display);
    expect(json.expanded.steps[1].bound).toContainEqual({ kind: "secret", name: "SHOP_PASSWORD" });
  });

  it("gives three positioned problems and exit 2 for an unknown variable, a missing flow and a bad Exact: line", () => {
    const dir = project({
      "tests/bad.test.md": [
        "---",
        "name: Broken on purpose",
        "---",
        "",
        '1. Fill "Email" with {{data.nope}}',
        "2. Use: flows/missing.test.md",
        '3. Exact: click button="Save"',
        "",
      ].join("\n"),
    });
    const result = run(dir, "show", "tests/bad.test.md", "--json");
    expect(result.status).toBe(2);
    const { diagnostics } = JSON.parse(result.stdout);
    expect(diagnostics.map((d: { code: string; range: unknown }) => [d.code, d.range])).toEqual([
      ["VAR_UNDEFINED", { start: { line: 5, column: 22 }, end: { line: 5, column: 35 } }],
      ["FLOW_NOT_FOUND", { start: { line: 6, column: 9 }, end: { line: 6, column: 30 } }],
      ["EXACT_SYNTAX", { start: { line: 7, column: 17 }, end: { line: 7, column: 30 } }],
    ]);
    const human = run(dir, "show", "tests/bad.test.md");
    expect(human.status).toBe(2);
    expect(human.stdout).toContain("error   VAR_UNDEFINED  tests/bad.test.md:5:22");
    expect(run(dir, "list").status).toBe(2);
  });

  it("checks secrets against the project file when there is one", () => {
    const dir = project({
      [brand.configFileName]: [
        "version: 1",
        "project: { name: Demo, target: web }",
        "environments:",
        "  local:",
        "    baseUrl: http://localhost:3000",
        "    vars: { GREETING: hello }",
        "secrets:",
        "  SHOP_PASSWORD: { domains: [localhost] }",
      ].join("\n"),
      "tests/a.test.md":
        "---\nname: A\n---\n\n1. Type {{secret.SHOP_PASSWORD}} and {{secret.NOPE}}\n2. Say {{env.GREETING}}\n",
    });
    const result = run(dir, "show", "tests/a.test.md", "--expanded");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("SECRET_UNDECLARED  tests/a.test.md:5:38");
    expect(result.stdout).toContain("Say hello");
  });

  it("exits 2 for a file that does not exist or is outside the project", () => {
    expect(run(shop, "show", "tests/nope.test.md").status).toBe(2);
    expect(run(shop, "show", "../../../package.json").status).toBe(2);
  });

  it("leaves the fixture files untouched", () => {
    const before = readFileSync(join(shop, "tests/create-project.test.md"), "utf8");
    run(shop, "show", "tests/create-project.test.md", "--expanded");
    expect(readFileSync(join(shop, "tests/create-project.test.md"), "utf8")).toBe(before);
  });
});
