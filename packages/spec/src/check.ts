import type { Config } from "@testament/config";
import type { SpecDiagnostic } from "./diagnostics.js";
import { sortDiagnostics } from "./diagnostics.js";
import { type ExpandContext, type ExpandedTest, expandTest } from "./expand.js";
import { lintTest } from "./lint/lint.js";
import type { Finding } from "./lint/types.js";
import type { LintWords } from "./lint/words.js";
import type { TestSpec } from "./model.js";
import { parseTest } from "./parse.js";

export interface CheckContext extends Omit<ExpandContext, "seed" | "config"> {
  /** Seed for generated values; findings never depend on it. Default `lint`. */
  seed?: string | undefined;
  config?: Config | undefined;
  words?: LintWords | undefined;
}

export interface CheckResult {
  spec: TestSpec;
  expanded: ExpandedTest;
  /** Parse, expansion and lint problems in one sorted list, without duplicates. */
  findings: Finding[];
}

const asFinding = (d: SpecDiagnostic): Finding => ({ ...d, fixes: [] });

/**
 * The one answer every caller (CLI, editors, MCP, cloud) gives for a file:
 * parse + expand + lint. Deterministic for the same text, flows and config.
 */
export async function checkTest(
  text: string,
  path: string,
  ctx: CheckContext,
): Promise<CheckResult> {
  const parsed = parseTest(text, path, { config: ctx.config, generators: ctx.generators });
  const expanded = await expandTest(parsed.spec, {
    ...ctx,
    seed: ctx.seed ?? "lint",
    config: ctx.config,
  });
  const lint = lintTest(parsed.spec, { expanded, text, config: ctx.config, words: ctx.words });
  const seen = new Set<string>();
  const findings = [
    ...parsed.diagnostics.map(asFinding),
    ...expanded.diagnostics.map(asFinding),
    ...lint,
  ].filter((f) => {
    const id = JSON.stringify([f.code, f.rule, f.file, f.range, f.message]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { spec: parsed.spec, expanded, findings: sortDiagnostics(findings) as Finding[] };
}

/** True when a finding is a parse/expansion problem, not a lint rule. */
export const isParseProblem = (f: Finding) => f.rule === undefined;
