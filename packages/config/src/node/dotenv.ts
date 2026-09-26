import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "../diagnostics.js";

export interface DotenvResult {
  values: Record<string, string>;
  diagnostics: Diagnostic[];
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/**
 * Parses `.env` content: `KEY=value`, optional `export `, `#` comments, single
 * quotes (literal), double quotes (with \n, \t, \" escapes, may span lines) and
 * inline ` # comments` after unquoted values. Never throws.
 */
export function parseDotenv(text: string, file = ".env"): DotenvResult {
  const result: DotenvResult = { values: {}, diagnostics: [] };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match?.[1]) {
      result.diagnostics.push({
        code: "ENV_FILE_SYNTAX",
        severity: "warning",
        file,
        line: lineNumber,
        message: `Line ${lineNumber} of ${file} is not "NAME=value" and is ignored.`,
        fix: `Change line ${lineNumber} of ${file} to NAME=value, or start it with # to make it a comment.`,
      });
      continue;
    }
    const key = match[1];
    let rest = match[2] ?? "";
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let body = rest.slice(1);
      let end = quote === '"' ? findClosingDouble(body) : body.indexOf("'");
      while (end === -1 && index + 1 < lines.length) {
        index++;
        body += `\n${lines[index]}`;
        end = quote === '"' ? findClosingDouble(body) : body.indexOf("'");
      }
      if (end === -1) {
        result.diagnostics.push({
          code: "ENV_FILE_SYNTAX",
          severity: "warning",
          file,
          line: lineNumber,
          message: `The value of ${key} on line ${lineNumber} of ${file} has no closing ${quote}.`,
          fix: `Add the closing ${quote} to the value of ${key} in ${file}.`,
        });
        continue;
      }
      rest = body.slice(0, end);
      result.values[key] =
        quote === '"' ? rest.replace(/\\([nrt"\\])/g, (_, c: string) => ESCAPES[c] ?? c) : rest;
    } else {
      result.values[key] = rest.replace(/\s+#.*$/, "").trim();
    }
  }
  return result;
}

function findClosingDouble(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") i++;
    else if (body[i] === '"') return i;
  }
  return -1;
}

/** Reads and parses a `.env` file; a missing file is empty. */
export function readDotenvFile(dir: string, name: string): DotenvResult {
  const path = join(dir, name);
  if (!existsSync(path)) return { values: {}, diagnostics: [] };
  return parseDotenv(readFileSync(path, "utf8"), name);
}
