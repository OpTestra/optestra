import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { diagnostic, type SpecDiagnostic } from "../diagnostics.js";
import type { TestSpec } from "../model.js";

// Datasets (AUT-9): `dataset: users.csv` (or .json), relative to the test file,
// runs the test once per row with every column bound as `{{data.<column>}}`.
// Every problem is a diagnostic with the row and what to do; nothing throws.

export interface DatasetRow {
  /** 1-based, in file order: the result id suffix `#<row>`. */
  row: number;
  /** Column → cell text (a template: a cell may use `{{unique.email}}`). */
  values: Record<string, string>;
}

export interface LoadedDataset {
  /** Project-relative path of the dataset file. */
  path: string;
  columns: string[];
  rows: DatasetRow[];
  diagnostics: SpecDiagnostic[];
}

/** Rows above this are refused: a dataset is for a handful of cases, not load testing. */
export const MAX_DATASET_ROWS = 200;

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** RFC 4180 CSV: commas, "quoted, fields", "" for a quote, newlines inside quotes. */
export function parseCsv(text: string): { rows: string[][]; error?: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < input.length) {
    const c = input[i] as string;
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && input[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) return { rows, error: "a quoted field is never closed" };
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines are not rows.
  return { rows: rows.filter((r) => !(r.length === 1 && r[0] === "")) };
}

const cell = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined;

/**
 * Reads a test's dataset. `dataset` is as written in the frontmatter (relative
 * to the test file); it must stay inside the project folder.
 */
export function loadDataset(projectDir: string, testPath: string, dataset: string): LoadedDataset {
  const root = resolve(projectDir);
  const absolute = resolve(root, dirname(testPath), dataset);
  const rel = relative(root, absolute).split(sep).join("/");
  const out: LoadedDataset = { path: rel, columns: [], rows: [], diagnostics: [] };
  const problem = (
    code: "DATASET_NOT_FOUND" | "DATASET_INVALID" | "DATASET_EMPTY",
    message: string,
    fix: string,
  ) => {
    out.diagnostics.push(diagnostic(code, "error", testPath, undefined, message, fix, "dataset"));
    return out;
  };
  if (rel.startsWith("..") || isAbsolute(rel))
    return problem(
      "DATASET_INVALID",
      `The dataset ${dataset} is outside the project folder.`,
      "Put the file next to the test (e.g. tests/data/users.csv) and point to it relatively.",
    );
  const lower = absolute.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".json"))
    return problem(
      "DATASET_INVALID",
      `The dataset ${dataset} is neither .csv nor .json.`,
      "Use a CSV file with a header row, or a JSON array of objects.",
    );
  let text: string;
  try {
    text = readFileSync(join(absolute), "utf8");
  } catch {
    return problem(
      "DATASET_NOT_FOUND",
      `The dataset ${rel} does not exist.`,
      `Create it, or fix the path (it is relative to ${testPath}).`,
    );
  }

  const records: Record<string, string>[] = [];
  if (lower.endsWith(".csv")) {
    const parsed = parseCsv(text);
    if (parsed.error)
      return problem("DATASET_INVALID", `${rel}: ${parsed.error}.`, 'Close every "quoted" field.');
    const [header, ...body] = parsed.rows;
    if (!header)
      return problem(
        "DATASET_EMPTY",
        `${rel} is empty.`,
        "Add a header row with the column names, then one row per case.",
      );
    out.columns = header.map((h) => h.trim());
    for (const [index, line] of body.entries()) {
      if (line.length !== out.columns.length)
        return problem(
          "DATASET_INVALID",
          `${rel} row ${index + 1} has ${line.length} values; the header has ${out.columns.length} columns.`,
          'Give every row one value per column (quote a value that contains a comma: "a, b").',
        );
      records.push(Object.fromEntries(out.columns.map((c, i) => [c, line[i] as string])));
    }
  } else {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return problem(
        "DATASET_INVALID",
        `${rel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        'Write an array of objects, e.g. [{ "email": "ada@example.com" }].',
      );
    }
    if (!Array.isArray(json))
      return problem(
        "DATASET_INVALID",
        `${rel} must be a JSON array of objects (one per row).`,
        'Write e.g. [{ "email": "ada@example.com", "plan": "pro" }].',
      );
    const columns = new Set<string>();
    for (const [index, item] of json.entries()) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        return problem(
          "DATASET_INVALID",
          `${rel} row ${index + 1} is not an object.`,
          "Every row is an object of column → value.",
        );
      const record: Record<string, string> = {};
      for (const [key, value] of Object.entries(item)) {
        const text = cell(value);
        if (text === undefined)
          return problem(
            "DATASET_INVALID",
            `${rel} row ${index + 1}: "${key}" is not text, a number or true/false.`,
            "Use one plain value per column; nested objects and lists aren't supported.",
          );
        record[key] = text;
        columns.add(key);
      }
      records.push(record);
    }
    out.columns = [...columns];
    for (const [index, record] of records.entries()) {
      const missing = out.columns.filter((c) => !(c in record));
      if (missing.length)
        return problem(
          "DATASET_INVALID",
          `${rel} row ${index + 1} has no ${missing.map((m) => `"${m}"`).join(", ")}.`,
          "Give every row the same keys.",
        );
    }
  }

  const bad = out.columns.find((c) => !COLUMN.test(c));
  if (bad !== undefined)
    return problem(
      "DATASET_INVALID",
      `${rel}: the column "${bad}" can't be used as {{data.${bad}}}.`,
      "Name columns with letters, digits and _ (starting with a letter), e.g. email or plan_name.",
    );
  const duplicate = out.columns.find((c, i) => out.columns.indexOf(c) !== i);
  if (duplicate)
    return problem(
      "DATASET_INVALID",
      `${rel}: the column "${duplicate}" appears twice.`,
      "Rename one.",
    );
  if (records.length === 0)
    return problem(
      "DATASET_EMPTY",
      `${rel} has no rows.`,
      "Add at least one row under the header (or one object in the array).",
    );
  if (records.length > MAX_DATASET_ROWS)
    return problem(
      "DATASET_INVALID",
      `${rel} has ${records.length} rows; the limit is ${MAX_DATASET_ROWS}.`,
      "Keep a dataset to the cases that matter; split it into several tests if needed.",
    );
  out.rows = records.map((values, i) => ({ row: i + 1, values }));
  return out;
}

/**
 * The `{{data.x}}` a dataset test uses that neither its data nor the dataset's
 * columns define (the parser can't know the columns: it reads no files).
 */
export function datasetColumnProblems(spec: TestSpec, dataset: LoadedDataset): SpecDiagnostic[] {
  const known = new Set([...Object.keys(spec.frontmatter.data), ...dataset.columns]);
  const used = new Set<string>();
  const templates = [
    ...spec.body.flatMap((item) =>
      item.type === "step" && "text" in item
        ? [item.text]
        : item.type === "step" && item.kind === "flow"
          ? Object.values(item.params)
          : [],
    ),
    ...Object.values(spec.frontmatter.data),
    ...(spec.frontmatter.start ? [spec.frontmatter.start] : []),
  ];
  for (const template of templates)
    for (const segment of template.segments)
      if (segment.kind === "var" && segment.ns === "data" && !known.has(segment.name))
        used.add(segment.name);
  return [...used].map((name) =>
    diagnostic(
      "DATASET_INVALID",
      "error",
      spec.path,
      undefined,
      `The test uses {{data.${name}}}, but ${dataset.path} has no "${name}" column (columns: ${dataset.columns.join(", ") || "none"}).`,
      `Add a "${name}" column to ${dataset.path}, or add ${name} to the test's data.`,
      "dataset",
    ),
  );
}
