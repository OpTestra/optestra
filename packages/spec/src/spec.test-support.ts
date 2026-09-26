import type { SpecDiagnostic } from "./diagnostics.js";

/** A test file from frontmatter lines and body lines. */
export function file(front: string | string[], body: string | string[] = '1. Click "Go"'): string {
  const head = Array.isArray(front) ? front.join("\n") : front;
  const text = Array.isArray(body) ? body.join("\n") : body;
  return `---\n${head}\n---\n\n${text}\n`;
}

/** `code@line:column-endLine:endColumn` for compact assertions. */
export function at(d: SpecDiagnostic): string {
  const r = d.range;
  return r
    ? `${d.code}@${r.start.line}:${r.start.column}-${r.end.line}:${r.end.column}`
    : `${d.code}@-`;
}

export const codes = (diagnostics: readonly SpecDiagnostic[]) => diagnostics.map((d) => d.code);
