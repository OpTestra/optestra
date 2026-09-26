import type { Config, Severity } from "@testament/config";
import { diagnostic, type SpecDiagnostic, sortDiagnostics } from "../diagnostics.js";
import type { ExpandedTest } from "../expand.js";
import type { TestSpec } from "../model.js";
import { LINT_RULES } from "./rules.js";
import { applyEdits, editsOverlap, linesOf, protectedLines, touchesLines } from "./source.js";
import {
  type CheckedFile,
  type Finding,
  type Fix,
  type LintRule,
  RULE_IDS,
  type RuleId,
  type RuleLevel,
} from "./types.js";
import { compileWords, type LintWords } from "./words.js";

export interface LintContext {
  /** The expanded form of `spec` (rules look at flows through it). */
  expanded: ExpandedTest;
  /** The file text `spec` was parsed from; fixes are edits to it. */
  text: string;
  /** The project config: rule levels (`lint.rules`), declared secrets, base URLs. */
  config?: Config | undefined;
  /** Word lists; default: lint-words.yaml. */
  words?: LintWords | undefined;
}

export function ruleById(id: string): LintRule | undefined {
  return LINT_RULES.find((rule) => rule.id === id);
}

/** The level a rule runs at: its default, or the project's `lint.rules` override. */
export function ruleLevel(rule: LintRule, config: Config | undefined): RuleLevel {
  return config?.lint?.rules?.[rule.id] ?? rule.severity;
}

/** Guarantee: a fix that edits an expectation line is never safe (HEAL-3). */
function guardFixes(fixes: Fix[], spec: TestSpec): Fix[] {
  const lines = protectedLines(spec);
  return fixes.map((fix) =>
    fix.safe && fix.edits.some((edit) => touchesLines(edit, lines)) ? { ...fix, safe: false } : fix,
  );
}

function finding(
  rule: LintRule,
  severity: Severity,
  file: string,
  f: { range: Finding["range"]; message: string; fix: string; fixes?: Fix[] },
): Finding {
  return {
    ...diagnostic("LINT", severity, file, f.range, f.message, f.fix),
    rule: rule.id,
    fixes: f.fixes ?? [],
  };
}

/** Runs the per-file rules. Deterministic; no model calls. */
export function lintTest(spec: TestSpec, ctx: LintContext): Finding[] {
  const words = compileWords(ctx.words);
  const lines = linesOf(ctx.text);
  const out: Finding[] = [];
  for (const rule of LINT_RULES) {
    const level = ruleLevel(rule, ctx.config);
    if (level === "off" || !rule.check) continue;
    rule.check({
      spec,
      expanded: ctx.expanded,
      lines,
      words,
      config: ctx.config,
      report: (f) => {
        const made = finding(rule, level, spec.path, f);
        out.push({ ...made, fixes: guardFixes(made.fixes, spec) });
      },
    });
  }
  return sortDiagnostics(out) as Finding[];
}

/** Runs the project-level rules (duplicate names, unused flows) over checked files. */
export function lintProject(files: readonly CheckedFile[], config: Config | undefined): Finding[] {
  const out: Finding[] = [];
  for (const rule of LINT_RULES) {
    const level = ruleLevel(rule, config);
    if (level === "off" || !rule.checkProject) continue;
    rule.checkProject({
      files,
      config,
      report: (f) => out.push(finding(rule, level, f.file, f)),
    });
  }
  return sortDiagnostics(out) as Finding[];
}

/** Problems in the `lint` config section itself (unknown rule ids). */
export function lintConfigDiagnostics(config: Config | undefined, file = ""): SpecDiagnostic[] {
  return Object.keys(config?.lint?.rules ?? {})
    .filter((id) => !(RULE_IDS as readonly string[]).includes(id))
    .map((id) =>
      diagnostic(
        "LINT_RULE_UNKNOWN",
        "warning",
        file,
        undefined,
        `lint.rules.${id} is not a lint rule, so it has no effect.`,
        `Use one of: ${RULE_IDS.join(", ")}.`,
        `lint.rules.${id}`,
      ),
    );
}

/**
 * Applies every safe fix, repeating until none is left (so a second run changes
 * nothing). Overlapping fixes wait for the next pass. Returns the new text and
 * what was applied.
 */
export function applySafeFixes(
  text: string,
  check: (text: string) => Finding[] | Promise<Finding[]>,
): Promise<{ text: string; applied: { rule: RuleId | undefined; title: string; line: number }[] }> {
  return (async () => {
    let current = text;
    const applied: { rule: RuleId | undefined; title: string; line: number }[] = [];
    for (let pass = 0; pass < 10; pass++) {
      const findings = await check(current);
      const chosen: { finding: Finding; fix: Fix }[] = [];
      for (const f of findings) {
        const fix = f.fixes.find((x) => x.safe);
        if (!fix || chosen.some((c) => editsOverlap(c.fix.edits, fix.edits))) continue;
        chosen.push({ finding: f, fix });
      }
      if (chosen.length === 0) break;
      current = applyEdits(
        current,
        chosen.flatMap((c) => c.fix.edits),
      );
      for (const { finding: f, fix } of chosen) {
        applied.push({ rule: f.rule, title: fix.title, line: f.range?.start.line ?? 0 });
      }
    }
    return { text: current, applied };
  })();
}
