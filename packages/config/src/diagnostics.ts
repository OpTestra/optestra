export type Severity = "error" | "warning" | "info";

/** Stable codes. The Setup check screen and `doctor` key off these; never rename one. */
export const DIAGNOSTIC_CODES = [
  "PROJECT_NOT_FOUND",
  "YAML_SYNTAX",
  "YAML_DUPLICATE_KEY",
  "CONFIG_NOT_OBJECT",
  "VERSION_MISSING",
  "VERSION_UNSUPPORTED",
  "UNKNOWN_KEY",
  "REQUIRED_MISSING",
  "INVALID_VALUE",
  "ENV_NONE_DEFINED",
  "ENV_NOT_SELECTED",
  "ENV_NOT_FOUND",
  "ENV_DEFAULT_UNKNOWN",
  "ENV_BASE_URL_MISSING",
  "ENV_APP_MISSING",
  "SECRET_NAME_INVALID",
  "SECRET_DUPLICATE",
  "SECRET_NO_DOMAINS",
  "SECRET_UNDECLARED",
  "SECRET_MISSING",
  "SECRET_INVALID",
  "ENV_VAR_INVALID",
  "ENV_VAR_UNKNOWN",
  "RUN_OPTION_INVALID",
  "ENV_FILE_SYNTAX",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface Diagnostic {
  /** Stable machine code. */
  code: DiagnosticCode;
  severity: Severity;
  /** What is wrong, in plain language. */
  message: string;
  /** The exact change that fixes it. */
  fix: string;
  /** File the problem is in, when it comes from a file. */
  file?: string;
  /** 1-based line in `file`, when known. */
  line?: number;
  /** Config path, e.g. `run.retries` or `environments.staging.baseUrl`. */
  path?: string;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
