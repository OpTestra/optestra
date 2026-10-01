import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { afterAll, describe, expect, it } from "vitest";

// `generate` end to end on a copy of the demo shop with the codegen package's
// hand-written recordings: exit codes, --check and --force.

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const shop = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const recordings = fileURLToPath(
  new URL(`../../codegen/fixtures/shop/tests/${brand.dataDirName}/`, import.meta.url),
);
const project = mkdtempSync(join(tmpdir(), "cli-generate-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

cpSync(join(shop, brand.configFileName), join(project, brand.configFileName));
cpSync(join(shop, "tests"), join(project, "tests"), {
  recursive: true,
  filter: (source) => !source.includes(brand.dataDirName),
});
for (const name of readdirSync(recordings).filter(
  (n) => n === "tests__create-project.steps.json",
)) {
  cpSync(join(recordings, name), join(project, "tests", brand.dataDirName, name));
}

const run = (...args: string[]) =>
  spawnSync(process.execPath, [bin, "generate", ...args], { cwd: project, encoding: "utf8" });
const spec = join(project, "tests", brand.dataDirName, "tests__create-project.spec.ts");

describe("generate", { timeout: 30_000 }, () => {
  it("writes the spec, fixtures and config for recorded tests and lists the rest", () => {
    const first = run();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(
      `created  tests/${brand.dataDirName}/tests__create-project.spec.ts`,
    );
    expect(first.stdout).toContain(`created  tests/${brand.dataDirName}/playwright.config.ts`);
    expect(first.stdout).toContain("skipped  tests/login.test.md (not recorded yet)");
    expect(run("--check").status).toBe(0);
  });

  it("refuses to overwrite a hand edit (exit 1, names the file) until --force", () => {
    writeFileSync(spec, `${readFileSync(spec, "utf8")}// my note\n`);
    for (const args of [[], ["--check"]]) {
      const refused = run(...args);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain(
        `  tests/${brand.dataDirName}/tests__create-project.spec.ts\n`,
      );
      expect(refused.stdout).toContain("pass --force");
    }
    expect(readFileSync(spec, "utf8")).toContain("// my note");
    const forced = run("--force");
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("replaced");
    expect(readFileSync(spec, "utf8")).not.toContain("// my note");
  });

  it("exits 2 outside a project", () => {
    const empty = mkdtempSync(join(tmpdir(), "cli-generate-empty-"));
    try {
      const result = spawnSync(process.execPath, [bin, "generate"], {
        cwd: empty,
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
