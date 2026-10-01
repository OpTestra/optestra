import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";

// The fixture project the goldens and the plain-Playwright runs use: the demo
// shop's project file and tests, plus this package's extra test and the
// hand-written recordings (fixtures/shop/tests/<data dir>/*.steps.json).

export const SHOP_DIR = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/shop/", import.meta.url));
/** Where the goldens live: next to the recordings, as in a real project. */
export const GOLDEN_DIR = join(FIXTURE_DIR, "tests", brand.dataDirName);

/** Copies the fixture project into a new temp folder and returns its path. */
export function composeProject(into?: string): string {
  const dir = into ?? mkdtempSync(join(tmpdir(), "codegen-project-"));
  cpSync(join(SHOP_DIR, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP_DIR, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !source.includes(brand.dataDirName),
  });
  for (const name of readdirSync(join(FIXTURE_DIR, "tests"))) {
    if (name.endsWith(".test.md"))
      cpSync(join(FIXTURE_DIR, "tests", name), join(dir, "tests", name));
  }
  const data = join(dir, "tests", brand.dataDirName);
  cpSync(GOLDEN_DIR, data, { recursive: true, filter: (source) => !/\.ts$/.test(source) });
  return dir;
}
