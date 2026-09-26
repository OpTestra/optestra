import { diagnostic, type SpecDiagnostic, type SpecDiagnosticCode } from "./diagnostics.js";
import type { Position, Range } from "./model.js";

/** Maps offsets in a string built from pieces of the file back to file positions. */
export class SourceMap {
  readonly #pieces: { offset: number; line: number; column: number }[] = [];
  #end: Position | undefined;

  /** The piece of the string starting at `offset` begins at `line:column` in the file. */
  add(offset: number, line: number, column: number): this {
    this.#pieces.push({ offset, line, column });
    return this;
  }

  /** Position just after the last character, when it is not simply the last piece + length. */
  end(position: Position): this {
    this.#end = position;
    return this;
  }

  at(offset: number): Position {
    let piece = this.#pieces[0] ?? { offset: 0, line: 1, column: 1 };
    for (const candidate of this.#pieces) {
      if (candidate.offset <= offset) piece = candidate;
      else break;
    }
    return { line: piece.line, column: piece.column + (offset - piece.offset) };
  }

  range(start: number, end: number): Range {
    return { start: this.at(start), end: this.at(end) };
  }

  /** The map of the substring starting at `offset`. */
  from(offset: number): SourceMap {
    const out = new SourceMap().add(0, this.at(offset).line, this.at(offset).column);
    for (const piece of this.#pieces) {
      if (piece.offset > offset) out.add(piece.offset - offset, piece.line, piece.column);
    }
    if (this.#end) out.end(this.#end);
    return out;
  }

  static at(line: number, column: number): SourceMap {
    return new SourceMap().add(0, line, column);
  }

  /** Whole-string range, honouring an explicit end. */
  whole(length: number): Range {
    return { start: this.at(0), end: this.#end ?? this.at(length) };
  }
}

export function lineRange(line: number, startColumn: number, endColumn: number): Range {
  return { start: { line, column: startColumn }, end: { line, column: endColumn } };
}

/** Collects diagnostics for one file. */
export class Reporter {
  readonly diagnostics: SpecDiagnostic[] = [];
  constructor(readonly file: string) {}

  error(
    code: SpecDiagnosticCode,
    range: Range | undefined,
    message: string,
    fix: string,
    path?: string,
  ) {
    this.diagnostics.push(diagnostic(code, "error", this.file, range, message, fix, path));
  }

  warn(
    code: SpecDiagnosticCode,
    range: Range | undefined,
    message: string,
    fix: string,
    path?: string,
  ) {
    this.diagnostics.push(diagnostic(code, "warning", this.file, range, message, fix, path));
  }
}
