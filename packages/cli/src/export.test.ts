import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { afterAll, describe, expect, it } from "vitest";
import { playwrightVersion } from "./commands/export.js";
import { SHOP_PASSWORD, shopProject } from "./shop-project.test-support.js";

// `export` (EXP-2) of the shop: the folder tree, only @playwright/test, no
// secret value and nothing of ours. Running it with plain npm and Playwright is
// in e2e/doctor-export.test.ts.

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const project = shopProject("cli-export-");
const outRoot = mkdtempSync(join(tmpdir(), "cli-export-out-"));
afterAll(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(outRoot, { recursive: true, force: true });
});
// The secret's value is in the project's .env, as it would be for a real user.
writeFileSync(join(project, ".env"), `SHOP_PASSWORD=${SHOP_PASSWORD}\n`);

const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, "export", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SHOP_PASSWORD },
    encoding: "utf8",
  });

function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

describe("export", { timeout: 30_000 }, () => {
  const out = join(outRoot, "shop-playwright");

  it("writes a standalone Playwright project of the recorded tests", () => {
    const result = run(project, "--out", out);
    expect(result.status).toBe(0);
    expect(tree(out)).toEqual(
      [
        ".env.example",
        ".gitignore",
        "README.md",
        "files/avatar.png",
        "package.json",
        "playwright.config.ts",
        `tests/${brand.cliName}.fixtures.ts`,
        `tests/${brand.cliName}.reporter.ts`,
        `tests/${brand.cliName}.teardown.ts`,
        "tests/tests__avatar-upload.spec.ts",
        "tests/tests__billing-zero-due.spec.ts",
        "tests/tests__checkout-trial.spec.ts",
        "tests/tests__create-project.spec.ts",
        "tests/tests__delete-account-guard.spec.ts",
        "tests/tests__settings-profile.spec.ts",
        "tests/tests__sort-orders.spec.ts",
      ].sort(),
    );
    // Tests without a recording are listed, in the output and the README.
    for (const test of ["declined-card", "login", "signup-email-code", "signup-validation"]) {
      expect(result.stdout).toContain(`skipped  tests/${test}.test.md (not recorded yet)`);
      expect(readFileSync(join(out, "README.md"), "utf8")).toContain(`\`tests/${test}.test.md\``);
    }
  });

  it("depends on @playwright/test only, pinned to the engine's version", () => {
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.devDependencies).toEqual({ "@playwright/test": playwrightVersion() });
    expect(pkg.dependencies).toBeUndefined();
    expect(playwrightVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("contains no import or dependency of ours and no secret value", () => {
    for (const file of tree(out)) {
      const text = readFileSync(join(out, file), "latin1");
      expect(text, file).not.toContain(brand.npmScope);
      expect(text, file).not.toContain(SHOP_PASSWORD);
    }
    expect(readFileSync(join(out, ".env.example"), "utf8")).toContain("SHOP_PASSWORD=\n");
    expect(existsSync(join(out, ".env"))).toBe(false);
  });

  it("the root config points into tests/ and loads .env", () => {
    const config = readFileSync(join(out, "playwright.config.ts"), "utf8");
    expect(config).toContain('testDir: "./tests"');
    expect(config).toContain(`"./tests/${brand.cliName}.reporter.ts"`);
    expect(config).toContain(`globalTeardown: "./tests/${brand.cliName}.teardown.ts"`);
    expect(config).toContain("process.loadEnvFile(envFile)");
    expect(existsSync(join(out, "tests", "playwright.config.ts"))).toBe(false);
  });

  it("refuses a folder that isn't empty unless --force", () => {
    const busy = join(outRoot, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "notes.txt"), "mine\n");
    const refused = run(project, "--out", busy);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain("is not empty");
    expect(tree(busy)).toEqual(["notes.txt"]);
    expect(run(project, "--out", busy, "--force").status).toBe(0);
    expect(readFileSync(join(busy, "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(busy, "playwright.config.ts"))).toBe(true);
  });

  it("exits 1 with nothing recorded, and 2 outside a project", () => {
    const bare = shopProject("cli-export-bare-");
    try {
      rmSync(join(bare, "tests", brand.dataDirName), { recursive: true, force: true });
      const none = run(bare, "--out", join(outRoot, "none"));
      expect(none.status).toBe(1);
      expect(none.stdout).toContain("No recorded tests to export");
      expect(existsSync(join(outRoot, "none", "package.json"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    expect(run(outRoot, "--out", join(outRoot, "x")).status).toBe(2);
  });
});
