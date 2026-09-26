import { type Document, isMap, isScalar, LineCounter, parseDocument } from "yaml";
import type { Diagnostic } from "../diagnostics.js";
import { formatPath, type Path } from "../paths.js";

export interface ParsedYaml {
  doc: Document;
  /** Plain JS value; undefined when the YAML has syntax errors. */
  value: unknown;
  lineOf: (path: Path) => number | undefined;
  diagnostics: Diagnostic[];
}

const isSecretsMap = (path: Path) =>
  (path.length === 1 && path[0] === "secrets") ||
  (path.length === 3 && path[0] === "environments" && path[2] === "secrets");

/** Parses YAML text (pure data: no custom tags, bounded aliases) and maps paths to lines. */
export function parseYaml(text: string, file: string): ParsedYaml {
  const fileName = file.split(/[\\/]/).pop() ?? file;
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: false, prettyErrors: true });
  const diagnostics: Diagnostic[] = [];
  for (const error of doc.errors) {
    const line = error.linePos?.[0]?.line;
    diagnostics.push({
      code: "YAML_SYNTAX",
      severity: "error",
      file,
      ...(line && { line }),
      message: `${fileName} is not valid YAML: ${error.message.split("\n")[0]}`,
      fix: `Fix the YAML ${line ? `on line ${line} ` : ""}of ${fileName} (check indentation, colons and quotes).`,
    });
  }

  const lines = new Map<string, number>();
  const walk = (node: unknown, path: Path) => {
    if (!isMap(node)) return;
    const seen = new Set<string>();
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const keyPath = [...path, key];
      const offset = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
      const line = offset === undefined ? undefined : lineCounter.linePos(offset).line;
      if (seen.has(key)) {
        const secret = isSecretsMap(path);
        diagnostics.push({
          code: secret ? "SECRET_DUPLICATE" : "YAML_DUPLICATE_KEY",
          severity: "error",
          file,
          ...(line && { line }),
          path: formatPath(keyPath),
          message: secret
            ? `Secret ${key} is declared more than once; names must be unique.`
            : `"${formatPath(keyPath)}" appears more than once; the last one wins.`,
          fix: `Keep one "${key}" under ${formatPath(path) || "the top level"} in ${fileName} and delete the other${line ? ` (line ${line})` : ""}.`,
        });
      }
      seen.add(key);
      if (line !== undefined && !lines.has(formatPath(keyPath)))
        lines.set(formatPath(keyPath), line);
      walk(pair.value, keyPath);
    }
  };
  walk(doc.contents, []);

  return {
    doc,
    value: doc.errors.length > 0 ? undefined : doc.toJS({ maxAliasCount: 100 }),
    lineOf: (path) => lines.get(formatPath(path)),
    diagnostics,
  };
}
