import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { afterAll, describe, expect, it } from "vitest";
import { composeProject } from "./fixture-project.test-support.js";
import { generateProject } from "./node/index.js";
import { importLine, relativeModule } from "./page-objects.js";

// Page objects (EXP-4): with `pageObjects`, locators become getters of a class
// per page and flows become shared helpers. The specs still run as plain
// Playwright (the export e2e runs them against the shop).

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function generate(pageObjects: boolean): Promise<Record<string, string>> {
  const project = composeProject();
  const out = mkdtempSync(join(tmpdir(), "codegen-po-"));
  temps.push(project, out);
  const result = await generateProject({
    projectDir: project,
    env: {},
    out: { dir: out, label: "tests" },
    pageObjects,
  });
  expect(result.problems).toEqual([]);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(out, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = relative(out, join(entry.parentPath, entry.name)).split("\\").join("/");
      files[path] = readFileSync(join(out, path), "utf8");
    }
  return files;
}

describe("page objects", async () => {
  const files = await generate(true);
  const plain = await generate(false);

  it("adds a class per page and a module per flow, only when asked", () => {
    const extra = Object.keys(files).filter((name) => !(name in plain));
    expect(extra.some((name) => /^pages\/[a-z-]+\.page\.ts$/.test(name))).toBe(true);
    expect(extra).toContain("flows/login.flow.ts");
    expect(Object.keys(plain).some((name) => name.includes("/"))).toBe(false);
    // The same specs, no more.
    expect(Object.keys(files).filter((n) => n.endsWith(".spec.ts"))).toEqual(
      Object.keys(plain).filter((n) => n.endsWith(".spec.ts")),
    );
  });

  it("uses getters instead of locators, one getter per element across tests", () => {
    const settings = files["pages/settings.page.ts"] as string;
    expect(settings).toContain("export class SettingsPage {");
    expect(settings).toContain("constructor(readonly page: Page) {}");
    const spec = files["tests__settings-profile.spec.ts"] as string;
    expect(spec).toContain('import { SettingsPage } from "./pages/settings.page";');
    expect(spec).toContain("const settingsPage = new SettingsPage(page);");
    expect(spec).toContain("await settingsPage.saveChangesButton.click();");
    // Each element is one getter, however many tests use it.
    const getters = [...settings.matchAll(/get (\w+)\(\)/g)].map((m) => m[1]);
    expect(new Set(getters).size).toBe(getters.length);
    const bodies = [...settings.matchAll(/return (this\.page\.[^;]+);/gs)].map((m) => m[1]);
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it("calls the login flow's helper from every test that logs in", () => {
    const login = files["flows/login.flow.ts"] as string;
    expect(login).toMatch(/export async function logIn\(/);
    expect(login).toContain('import { LoginPage } from "../pages/login.page";');
    const callers = Object.entries(files).filter(
      ([name, text]) => name.endsWith(".spec.ts") && /await logIn\d*\(/.test(text),
    );
    expect(callers.length).toBeGreaterThan(1);
    for (const [, text] of callers) expect(text).toMatch(/from "\.\/flows\/login\.flow";/);
  });

  it("is byte-identical when generated again", async () => {
    expect(await generate(true)).toEqual(files);
  });

  it("type-checks as plain Playwright code under strict settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-po-tsc-"));
    temps.push(dir);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "@types"), { recursive: true });
    const here = fileURLToPath(new URL("..", import.meta.url));
    symlinkSync(
      realpathSync(join(here, "node_modules", "@playwright", "test")),
      join(dir, "node_modules", "@playwright", "test"),
      "junction",
    );
    symlinkSync(
      realpathSync(join(root, "node_modules", "@types", "node")),
      join(dir, "node_modules", "@types", "node"),
      "junction",
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          types: ["node"],
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["*.ts", "pages/*.ts", "flows/*.ts"],
      }),
    );
    const tsc = spawnSync(
      process.execPath,
      [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", dir],
      { encoding: "utf8" },
    );
    expect(`${tsc.stdout}${tsc.stderr}`).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);
});

describe("imports between the generated modules", () => {
  it("are relative to the importing file, type-only when they only bring types", () => {
    expect(relativeModule("spec", "pages/home.page")).toBe("./pages/home.page");
    expect(relativeModule("flows/login.flow", "pages/home.page")).toBe("../pages/home.page");
    expect(importLine(["type Page"], "@playwright/test", "flows/x")).toBe(
      'import type { Page } from "@playwright/test";',
    );
    const fixtures = `${brand.cliName}.fixtures`;
    expect(importLine(["test", "type Fixtures", "expect"], fixtures, "flows/x")).toBe(
      `import { expect, type Fixtures, test } from "../${fixtures}";`,
    );
  });
});
