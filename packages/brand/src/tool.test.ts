import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBrand } from "./resolve.js";
import { checkBrand, planBrandApply } from "./tool.js";

const brandFor = (productName: string) =>
  resolveBrand({
    productName,
    cliName: "{name}",
    npmScope: "@{name}",
    desktopAppName: "{Name}",
    webAppName: "{Name}",
    domain: "{name}.dev",
    configFileName: "{name}.config.ts",
    dataDirName: ".{name}",
  });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A tiny repo branded "Alpha". */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "brand-sync-"));
  dirs.push(root);
  write(root, "package.json", '{\n  "devDependencies": { "@alpha/brand": "workspace:*" }\n}\n');
  write(
    root,
    "cli/package.json",
    '{\n  "name": "@alpha/cli",\n  "bin": { "alpha": "bin/cli.js" },\n  "brand": { "bin": "cliName" }\n}\n',
  );
  write(
    root,
    "desktop/package.json",
    '{\n  "name": "@alpha/desktop",\n  "productName": "Alpha",\n  "brand": { "productName": "desktopAppName" }\n}\n',
  );
  write(root, "cli/src/index.ts", 'import { core } from "@alpha/core";\n');
  write(root, ".gitignore", "# brand:next {dataDirName}/\n.alpha/\n");
  write(root, "README.md", "Alpha is great.\n");
  write(root, "LICENSE", "Copyright Alpha\n");
  return root;
}

function apply(root: string, productName: string): void {
  for (const change of planBrandApply(root, brandFor(productName))) {
    writeFileSync(change.file, change.after);
  }
}

describe("brand-sync", () => {
  it("passes on a repo that matches the brand", () => {
    expect(checkBrand(fixture(), brandFor("Alpha"))).toEqual([]);
  });

  it("renames scope, bin, app name and marked lines", () => {
    const root = fixture();
    apply(root, "Beta");
    const read = (rel: string) => readFileSync(join(root, rel), "utf8");
    expect(read("package.json")).toContain('"@beta/brand"');
    expect(read("cli/package.json")).toContain('"name": "@beta/cli"');
    expect(read("cli/package.json")).toContain('"bin": { "beta": "bin/cli.js" }');
    expect(read("desktop/package.json")).toContain('"productName": "Beta"');
    expect(read("cli/src/index.ts")).toContain('"@beta/core"');
    expect(read(".gitignore")).toBe("# brand:next {dataDirName}/\n.beta/\n");
    expect(read("LICENSE")).toBe("Copyright Alpha\n");
    expect(checkBrand(root, brandFor("Beta"))).toEqual([]);
  });

  it("reports pending edits when brand.json changed but apply did not run", () => {
    const problems = checkBrand(fixture(), brandFor("Beta"));
    expect(problems.some((p) => p.message.includes("out of sync"))).toBe(true);
  });

  it("flags a stray product-name literal in code", () => {
    const root = fixture();
    write(root, "cli/src/banner.ts", 'export const banner = "Welcome to ALPHA";\n');
    expect(checkBrand(root, brandFor("Alpha"))).toEqual([
      { file: "cli/src/banner.ts", line: 1, message: expect.stringContaining('"alpha"') },
    ]);
  });
});
