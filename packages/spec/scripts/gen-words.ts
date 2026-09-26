// Regenerates src/lint/words.generated.ts from lint-words.yaml, so the browser
// entry gets the word lists without reading files. Run: pnpm --filter ./packages/spec gen:words
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const source = fileURLToPath(new URL("../lint-words.yaml", import.meta.url));
const target = fileURLToPath(new URL("../src/lint/words.generated.ts", import.meta.url));
const words = parse(readFileSync(source, "utf8"));
writeFileSync(
  target,
  `// Generated from lint-words.yaml by scripts/gen-words.ts. Do not edit.\n` +
    `import type { LintWords } from "./words.js";\n\n` +
    `export const BUILT_IN_WORDS: LintWords = ${JSON.stringify(words, null, 2)};\n`,
);
spawnSync("pnpm", ["exec", "biome", "format", "--write", target], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
