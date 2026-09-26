import type { Position, Range, Step, TestSpec } from "../model.js";
import { specSteps } from "../model.js";
import type { TextEdit } from "./types.js";

/** Lines of normalized text; positions in the spec model refer to these. */
export function linesOf(text: string): string[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Finds `needle` inside a step's source lines (the `occurrence`-th match). */
export function rangeInStep(
  lines: readonly string[],
  step: Step,
  needle: string,
  occurrence = 0,
): Range | undefined {
  const range = step.at?.range;
  if (!range || needle === "") return range;
  let seen = 0;
  for (let line = range.start.line; line <= range.end.line; line++) {
    const text = lines[line - 1] ?? "";
    let from = line === range.start.line ? range.start.column - 1 : 0;
    for (;;) {
      const index = text.indexOf(needle, from);
      if (index < 0) break;
      if (seen === occurrence) {
        return {
          start: { line, column: index + 1 },
          end: { line, column: index + 1 + needle.length },
        };
      }
      seen++;
      from = index + needle.length;
    }
  }
  return undefined;
}

/** The line range a step covers (for "protected line" checks). */
export function stepLines(step: Step): [number, number] | undefined {
  const range = step.at?.range;
  return range ? [range.start.line, range.end.line] : undefined;
}

/** Expectation lines: Expect:, Soft:, Never: and exact expect ops. Fixes there are never safe. */
export function isCheckStep(step: Step): boolean {
  if (step.kind === "expect" || step.kind === "soft" || step.kind === "guard") return true;
  return step.kind === "exact" && step.exact.form === "op" && step.exact.op.op.startsWith("expect");
}

export function protectedLines(spec: TestSpec): Set<number> {
  const out = new Set<number>();
  for (const step of specSteps(spec)) {
    const span = isCheckStep(step) ? stepLines(step) : undefined;
    if (span) for (let line = span[0]; line <= span[1]; line++) out.add(line);
  }
  return out;
}

/** Does an edit touch any of these lines? An insertion at column 1 touches none. */
export function touchesLines(edit: TextEdit, lines: ReadonlySet<number>): boolean {
  const { start, end } = edit.range;
  const insertion = start.line === end.line && start.column === end.column;
  if (insertion && start.column === 1) return false;
  const last = end.column === 1 && end.line > start.line ? end.line - 1 : end.line;
  for (let line = start.line; line <= last; line++) if (lines.has(line)) return true;
  return false;
}

const compare = (a: Position, b: Position) => a.line - b.line || a.column - b.column;

function offsetOf(lineStarts: readonly number[], position: Position, length: number): number {
  const start = lineStarts[position.line - 1];
  if (start === undefined) return length;
  return Math.min(start + position.column - 1, length);
}

/**
 * Applies non-overlapping edits to text (LF-normalized positions). Keeps a BOM
 * and CRLF line endings if the text had them.
 */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const crlf = text.includes("\r\n");
  let body = text.slice(bom.length).replace(/\r\n?/g, "\n");
  const lineStarts = [0];
  for (let i = 0; i < body.length; i++) if (body[i] === "\n") lineStarts.push(i + 1);
  const sorted = [...edits].sort((a, b) => compare(b.range.start, a.range.start));
  for (const edit of sorted) {
    const from = offsetOf(lineStarts, edit.range.start, body.length);
    const to = offsetOf(lineStarts, edit.range.end, body.length);
    body = body.slice(0, from) + edit.newText + body.slice(to);
  }
  return bom + (crlf ? body.replace(/\n/g, "\r\n") : body);
}

export function editsOverlap(a: readonly TextEdit[], b: readonly TextEdit[]): boolean {
  return a.some((x) =>
    b.some(
      (y) =>
        (compare(x.range.start, y.range.end) < 0 && compare(y.range.start, x.range.end) < 0) ||
        compare(x.range.start, y.range.start) === 0,
    ),
  );
}

/** The line of the closing `---` of the frontmatter, if any. */
export function frontmatterEnd(lines: readonly string[]): number | undefined {
  if ((lines[0] ?? "").trim() !== "---") return undefined;
  const index = lines.findIndex(
    (line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  return index < 0 ? undefined : index + 1;
}

/** An edit inserting whole lines before file line `line`. */
export function insertLines(line: number, newLines: readonly string[]): TextEdit {
  const at = { line, column: 1 };
  return { range: { start: at, end: at }, newText: `${newLines.join("\n")}\n` };
}

/** Replaces the whole of file lines `from`…`to` with `newLines`. */
export function replaceLines(
  lines: readonly string[],
  from: number,
  to: number,
  newLines: readonly string[],
): TextEdit {
  return {
    range: {
      start: { line: from, column: 1 },
      end: { line: to, column: (lines[to - 1] ?? "").length + 1 },
    },
    newText: newLines.join("\n"),
  };
}
