import type { Diagnostic } from "@testament/config";
import type { Range } from "./model.js";

/** Stable codes. The editors and SPEC-1 key off these; never rename one. */
export const SPEC_DIAGNOSTIC_CODES = [
  // File and frontmatter
  "FRONTMATTER_MISSING",
  "FRONTMATTER_UNCLOSED",
  "YAML_SYNTAX",
  "YAML_DUPLICATE_KEY",
  "FRONTMATTER_NOT_OBJECT",
  "UNKNOWN_KEY",
  "REQUIRED_MISSING",
  "INVALID_VALUE",
  "HOOK_INVALID",
  "PARAMS_OUTSIDE_FLOW",
  // Body
  "NO_STEPS",
  "TEXT_OUTSIDE_STEPS",
  "STEP_NUMBER_ORDER",
  "STEP_EMPTY",
  "USE_SYNTAX",
  "EXACT_SYNTAX",
  "EXACT_CODE_LANG",
  "FENCE_UNCLOSED",
  // Variables
  "TEMPLATE_UNCLOSED",
  "TEMPLATE_SYNTAX",
  "VAR_NAMESPACE_UNKNOWN",
  "VAR_MEMBER_UNKNOWN",
  "VAR_UNDEFINED",
  "SECRET_NAME_INVALID",
  "SECRET_UNDECLARED",
  "DATA_CYCLE",
  "ENV_UNDEFINED",
  // Flows (found by expandTest)
  "FLOW_NOT_FOUND",
  "FLOW_NOT_A_FLOW",
  "FLOW_CYCLE",
  "FLOW_DEPTH",
  "FLOW_PARAM_MISSING",
  "FLOW_PARAM_UNKNOWN",
  // Project
  "TESTS_DIR_MISSING",
  // Datasets (AUT-9, found when a dataset is loaded)
  "DATASET_NOT_FOUND",
  "DATASET_INVALID",
  "DATASET_EMPTY",
  // Lint (SPEC-1): every rule finding has code LINT and its `rule` id
  "LINT",
  "LINT_RULE_UNKNOWN",
] as const;

export type SpecDiagnosticCode = (typeof SPEC_DIAGNOSTIC_CODES)[number];

/**
 * The config Diagnostic shape (code, severity, message, fix, file, line, path)
 * with this package's codes and the exact range the editor underlines.
 * `path` is the frontmatter field path when the problem is in frontmatter.
 */
export interface SpecDiagnostic extends Omit<Diagnostic, "code"> {
  code: SpecDiagnosticCode;
  range?: Range;
}

export function diagnostic(
  code: SpecDiagnosticCode,
  severity: SpecDiagnostic["severity"],
  file: string,
  range: Range | undefined,
  message: string,
  fix: string,
  path?: string,
): SpecDiagnostic {
  return {
    code,
    severity,
    message,
    fix,
    file,
    ...(range && { line: range.start.line, range }),
    ...(path !== undefined && { path }),
  };
}

export function hasSpecErrors(diagnostics: readonly SpecDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** Stable order: file, then position, then code. */
export function sortDiagnostics(diagnostics: SpecDiagnostic[]): SpecDiagnostic[] {
  const pos = (d: SpecDiagnostic) => [
    d.range?.start.line ?? 0,
    d.range?.start.column ?? 0,
    d.range?.end.line ?? 0,
    d.range?.end.column ?? 0,
  ];
  return diagnostics.sort((a, b) => {
    if ((a.file ?? "") !== (b.file ?? "")) return (a.file ?? "") < (b.file ?? "") ? -1 : 1;
    const pa = pos(a);
    const pb = pos(b);
    for (let i = 0; i < 4; i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}
