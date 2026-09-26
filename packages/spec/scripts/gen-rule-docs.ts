// Rewrites the lint rule reference in README.md from the rule definitions.
// Run after building: pnpm --filter ./packages/spec gen:rule-docs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RULES_END, RULES_START, ruleReference } from "../dist/lint/docs.js";

const readme = fileURLToPath(new URL("../README.md", import.meta.url));
const text = readFileSync(readme, "utf8");
const start = text.indexOf(RULES_START);
const end = text.indexOf(RULES_END);
if (start < 0 || end < 0) throw new Error("README.md has no lint rule markers");
writeFileSync(
  readme,
  `${text.slice(0, start + RULES_START.length)}\n${ruleReference()}\n${text.slice(end)}`,
);
