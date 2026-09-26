import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { checkBrand, loadBrand, planBrandApply } from "./tool.js";

const USAGE = "usage: brand-sync <apply [--no-install] | check>";
const [command, ...flags] = process.argv.slice(2);
const root = process.cwd();
const brand = loadBrand();

if (command === "apply") {
  const changes = planBrandApply(root, brand);
  for (const change of changes) {
    writeFileSync(change.file, change.after);
    console.log(`updated ${relative(root, change.file)}`);
  }
  console.log(`brand-sync: ${changes.length} file(s) updated for "${brand.productName}"`);
  if (changes.length > 0 && !flags.includes("--no-install")) {
    const result = spawnSync("pnpm", ["install"], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    process.exitCode = result.status ?? 1;
  }
} else if (command === "check") {
  const problems = checkBrand(root, brand);
  for (const problem of problems) {
    const where = problem.line > 0 ? `${problem.file}:${problem.line}` : problem.file;
    console.error(`${where}  ${problem.message}`);
  }
  if (problems.length > 0) {
    console.error(`brand-sync: ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log("brand-sync: ok");
  }
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
