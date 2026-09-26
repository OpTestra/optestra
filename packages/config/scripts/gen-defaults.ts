// Regenerates src/defaults.generated.ts from defaults.yaml, so the browser entry
// gets the defaults without reading files. Run: pnpm --filter ./packages/config gen:defaults
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const source = fileURLToPath(new URL("../defaults.yaml", import.meta.url));
const target = fileURLToPath(new URL("../src/defaults.generated.ts", import.meta.url));
const defaults = parse(readFileSync(source, "utf8"));
writeFileSync(
  target,
  `// Generated from defaults.yaml by scripts/gen-defaults.ts. Do not edit.\n` +
    `export const BUILT_IN_DEFAULTS: Readonly<Record<string, unknown>> = ${JSON.stringify(defaults, null, 2)};\n`,
);
spawnSync("pnpm", ["exec", "biome", "format", "--write", target], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
