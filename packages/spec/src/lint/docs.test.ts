import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULES_END, RULES_START, ruleReference } from "./docs.js";

describe("rule reference", () => {
  it("README.md matches the rule definitions (run `pnpm --filter ./packages/spec gen:rule-docs`)", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const start = readme.indexOf(RULES_START) + RULES_START.length;
    expect(readme.slice(start, readme.indexOf(RULES_END))).toBe(`\n${ruleReference()}\n`);
  });
});
