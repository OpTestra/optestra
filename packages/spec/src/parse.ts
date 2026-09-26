import type { Config } from "@testament/config";
import { parseBody } from "./body.js";
import { type SpecDiagnostic, sortDiagnostics } from "./diagnostics.js";
import { parseFrontmatterYaml, validateFrontmatter } from "./frontmatter.js";
import { defaultGenerators, type GeneratorRegistry } from "./generators.js";
import { type Range, specSteps, type TestSpec } from "./model.js";
import { checkSpecRefs } from "./refs.js";
import { lineRange, Reporter } from "./text.js";

export interface ParseOptions {
  /** The resolved project config. When given, `{{secret.X}}` must be declared in it. */
  config?: Pick<Config, "secrets" | "environments"> | undefined;
  /** Generators `{{unique.*}}` and `{{faker.*}}` may name. Default: the built-in set. */
  generators?: GeneratorRegistry | undefined;
}

export interface ParseResult {
  spec: TestSpec;
  diagnostics: SpecDiagnostic[];
}

/** Every secret name declared at the top level or in any environment. */
export function declaredSecrets(config: ParseOptions["config"]): Set<string> | undefined {
  if (!config) return undefined;
  const names = new Set(Object.keys(config.secrets ?? {}));
  for (const env of Object.values(config.environments ?? {})) {
    for (const name of Object.keys(env.secrets ?? {})) names.add(name);
  }
  return names;
}

/** Normalizes line endings and drops a byte-order mark. Positions refer to the result. */
export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * Parses a `.test.md` file into the typed model. Deterministic, no AI, no I/O,
 * never throws on user mistakes: every problem is a diagnostic with a range.
 * `path` is the project-relative path (used for diagnostics and flow lookup).
 */
export function parseTest(text: string, path: string, options: ParseOptions = {}): ParseResult {
  const report = new Reporter(path);
  const lines = normalizeText(text).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  let bodyStart = 0;
  let yamlText: string | undefined;
  let whole: Range = lineRange(1, 1, (lines[0] ?? "").length + 1);
  if ((lines[0] ?? "").trim() === "---") {
    const close = lines.findIndex(
      (line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."),
    );
    if (close < 0) {
      report.error(
        "FRONTMATTER_UNCLOSED",
        lineRange(1, 1, 4),
        "The frontmatter starts with --- but never ends.",
        "Add a line with just --- after the last frontmatter field.",
      );
      yamlText = lines.slice(1).join("\n");
      bodyStart = lines.length;
    } else {
      yamlText = lines.slice(1, close).join("\n");
      bodyStart = close + 1;
      whole = { start: { line: 1, column: 1 }, end: { line: close + 1, column: 4 } };
    }
  } else {
    report.error(
      "FRONTMATTER_MISSING",
      lineRange(1, 1, (lines[0] ?? "").length + 1),
      "The file has no frontmatter, so the test has no name.",
      "Start the file with:\n---\nname: What this test checks\n---",
    );
  }

  const parsed =
    yamlText === undefined
      ? {
          value: undefined,
          index: { ranges: new Map(), keys: new Map(), scalars: new Map(), whole },
        }
      : parseFrontmatterYaml(yamlText, 2, whole, report);
  const frontmatter = validateFrontmatter(parsed.value, parsed.index, report);
  const body = parseBody(lines.slice(bodyStart), bodyStart + 1, report);

  const spec: TestSpec = {
    path,
    frontmatter,
    body,
    fields: Object.fromEntries(parsed.index.ranges),
  };

  const envData = Object.values(frontmatter.environments).flatMap((env) =>
    Object.keys(env.data ?? {}),
  );
  checkSpecRefs(
    spec,
    {
      kind: frontmatter.kind,
      data: new Set([...Object.keys(frontmatter.data), ...envData]),
      params: new Set(Object.keys(frontmatter.params)),
      generators: options.generators ?? defaultGenerators,
      secrets: declaredSecrets(options.config),
    },
    report,
  );

  if (specSteps(spec).filter((s) => s.kind !== "guard").length === 0) {
    report.warn(
      "NO_STEPS",
      whole,
      `This ${frontmatter.kind} has no steps.`,
      'Add numbered steps after the frontmatter, e.g. "1. Click \\"Sign up\\"".',
    );
  }
  return { spec, diagnostics: sortDiagnostics(report.diagnostics) };
}
