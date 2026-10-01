import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { afterAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const fixtures = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const report = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, "report", ...args], { cwd, encoding: "utf8" });
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-report-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("report command", { timeout: 30_000 }, () => {
  it("writes index.html into the run folder", () => {
    const run = join(temp(), "run");
    cpSync(join(fixtures, "failed-product-bug"), run, { recursive: true });
    const result = report(run, ".");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Report written to index.html");
    const html = readFileSync(join(run, "index.html"), "utf8");
    expect(html).toContain("Expected order total &#39;$90.00&#39;, found &#39;$100.00&#39;");
    expect(html).toContain('src="tests/tests__checkout__discount-code/2/steps/2-after.png"');
  });

  it("writes to --out with links back to the run folder", () => {
    const out = join(temp(), "site");
    const result = report(fixtures, "failed-product-bug", "--out", out);
    expect(result.status).toBe(0);
    expect(existsSync(join(fixtures, "failed-product-bug", "index.html"))).toBe(false);
    expect(readFileSync(join(out, "index.html"), "utf8")).toMatch(
      // Relative when both folders share a drive; a file: URL when they don't (Windows CI).
      /src="(?:(\.\.\/)+|file:\/\/\/)[^"]*failed-product-bug\/tests\/tests__checkout__discount-code\/2\/steps\/2-after\.png"/,
    );
  });

  it("defaults to the project's latest run", () => {
    const project = temp();
    writeFileSync(join(project, brand.configFileName), "project: demo\n");
    const runs = join(project, brand.dataDirName, "runs");
    mkdirSync(runs, { recursive: true });
    cpSync(join(fixtures, "healed"), join(runs, "01M3EFN0J0FQBKEWDYW4JQ19PW"), { recursive: true });
    cpSync(join(fixtures, "flaky"), join(runs, "01M3EGSME0Y0HFX5XMJ3B771ER"), { recursive: true });
    const result = report(project);
    expect(result.status).toBe(0);
    const html = readFileSync(join(runs, "01M3EGSME0Y0HFX5XMJ3B771ER", "index.html"), "utf8");
    expect(html).toContain("Search finds products");
    expect(existsSync(join(runs, "01M3EFN0J0FQBKEWDYW4JQ19PW", "index.html"))).toBe(false);
  });

  it("exits 2 when there is no run", () => {
    const empty = temp();
    writeFileSync(join(empty, brand.configFileName), "project: demo\n");
    const result = report(empty);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("No finished runs");
    const broken = join(temp(), "run");
    mkdirSync(broken);
    expect(report(broken, ".").status).toBe(2);
  });
});
