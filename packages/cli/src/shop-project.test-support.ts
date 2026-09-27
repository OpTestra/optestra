import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";

// The demo shop as a project for the init/doctor/export tests: its project file
// and tests, plus codegen's hand-written recordings of the shop tests (not the
// extra allowed-hosts test, whose lint error is deliberate).

export const SHOP_DIR = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const RECORDINGS = fileURLToPath(
  new URL(`../../codegen/fixtures/shop/tests/${brand.dataDirName}/`, import.meta.url),
);
export const SHOP_PASSWORD = "shop-demo-pass";

/** Copies the shop project (with recordings) into a new temp folder. */
export function shopProject(prefix = "cli-shop-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(SHOP_DIR, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP_DIR, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !source.includes(brand.dataDirName),
  });
  for (const name of readdirSync(RECORDINGS)) {
    if (name.endsWith(".steps.json") && !name.startsWith("tests__allowed-hosts")) {
      cpSync(join(RECORDINGS, name), join(dir, "tests", brand.dataDirName, name));
    }
  }
  return dir;
}
