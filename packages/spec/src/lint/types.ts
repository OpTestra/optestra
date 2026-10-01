import type { Config, Severity } from "@optestra/config";
import type { SpecDiagnostic } from "../diagnostics.js";
import type { ExpandedTest } from "../expand.js";
import type { Range, TestSpec } from "../model.js";
import type { CompiledWords } from "./words.js";

/** A text change. `range` is 1-based, end exclusive, in the (LF-normalized) file text. */
export interface TextEdit {
  range: Range;
  newText: string;
}

export interface Fix {
  title: string;
  edits: TextEdit[];
  /**
   * Safe fixes may be applied without asking (`lint --fix`). A fix that touches
   * an Expect:, Soft:, Never: or exact expect line is never safe (HEAL-3).
   */
  safe: boolean;
}

/** A diagnostic from parsing, expansion or a lint rule, with its quick fixes. */
export interface Finding extends SpecDiagnostic {
  /** The lint rule id; absent for parse and expansion problems. */
  rule?: RuleId;
  fixes: Fix[];
}

export const RULE_IDS = [
  "vague-step",
  "expect-not-observable",
  "no-expectations",
  "soft-only",
  "missing-start",
  "compound-expect",
  "literal-credential",
  "fixed-email",
  "destructive-undeclared",
  "vague-guard",
  "fixed-wait",
  "duplicate-test-name",
  "unused-flow",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type RuleLevel = "off" | Severity;

/** What a rule sees for one file. */
export interface RuleContext {
  spec: TestSpec;
  expanded: ExpandedTest;
  /** The file's lines (LF-normalized), for locating text and building edits. */
  lines: readonly string[];
  words: CompiledWords;
  config: Config | undefined;
  report(finding: { range: Range | undefined; message: string; fix: string; fixes?: Fix[] }): void;
}

/** One checked file, for project-level rules. */
export interface CheckedFile {
  path: string;
  spec: TestSpec;
  expanded: ExpandedTest;
}

export interface ProjectContext {
  files: readonly CheckedFile[];
  config: Config | undefined;
  report(finding: {
    file: string;
    range: Range | undefined;
    message: string;
    fix: string;
    fixes?: Fix[];
  }): void;
}

export interface LintRule {
  id: RuleId;
  severity: Severity;
  /** One line. */
  summary: string;
  /** Why it matters, in plain language. */
  why: string;
  bad: string;
  good: string;
  /** What the quick fix does, when there is one. */
  fixDescription?: string;
  check?(ctx: RuleContext): void;
  checkProject?(ctx: ProjectContext): void;
}
