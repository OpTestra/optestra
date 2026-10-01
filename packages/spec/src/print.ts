import { stringify } from "yaml";
import { printExactOp } from "./exact.js";
import { formatDuration } from "./frontmatter.js";
import type { BodyItem, Frontmatter, Hook, Step, Template, TestSpec } from "./model.js";

/*
 * Canonical text. `parseTest(printTest(spec))` gives `spec` back (ignoring source
 * positions), and printing a canonical file gives it back byte for byte.
 * Canonical form: frontmatter keys in FRONTMATTER_KEYS order, lists of words as
 * [a, b], maps inside hooks as { k: v }, one blank line after the frontmatter,
 * steps on one line each (continuation lines are joined), prefixes written
 * Expect:/Soft:/Never:/Use:/Exact:, runs of blank lines collapsed to one,
 * comments and stray text kept as written, LF line endings, final newline.
 */

const OPTIONS = { lineWidth: 0 } as const;

function scalar(value: unknown): string {
  if (typeof value === "string" && value.includes("\n")) return JSON.stringify(value);
  return stringify(value, OPTIONS).trimEnd();
}

const flowSeq = (items: readonly unknown[]) =>
  stringify(items, { ...OPTIONS, collectionStyle: "flow", flowCollectionPadding: false }).trimEnd();
const flowMap = (value: unknown) =>
  stringify(value, { ...OPTIONS, collectionStyle: "flow" }).trimEnd();

const raws = (map: Readonly<Record<string, Template | null>>) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === null ? null : v.raw]));

function block(
  key: string,
  map: Readonly<Record<string, Template | null>>,
  indent: string,
): string[] {
  if (Object.keys(map).length === 0) return [];
  return [
    `${indent}${scalar(key)}:`,
    ...Object.entries(map).map(([k, v]) =>
      v === null ? `${indent}  ${scalar(k)}:` : `${indent}  ${scalar(k)}: ${scalar(v.raw)}`,
    ),
  ];
}

function hookLines(hook: Hook): string[] {
  switch (hook.type) {
    case "run":
      return [`  - run: ${scalar(hook.script)}`];
    case "sql":
      return [
        `  - sql: ${scalar(hook.statement)}`,
        ...(hook.production ? ["    production: true"] : []),
      ];
    default: {
      const lines = [`  - request: ${scalar(`${hook.method} ${hook.target}`)}`];
      if (hook.body !== undefined) {
        const body =
          typeof hook.body === "object" && hook.body !== null
            ? flowMap(hook.body)
            : scalar(hook.body);
        lines.push(`    body: ${body}`);
      }
      if (hook.headers !== undefined) lines.push(`    headers: ${flowMap(hook.headers)}`);
      return lines;
    }
  }
}

export function printFrontmatter(fm: Frontmatter): string[] {
  const lines: string[] = [];
  if (fm.name !== "") lines.push(`name: ${scalar(fm.name)}`);
  if (fm.kind === "flow") lines.push("kind: flow");
  lines.push(...block("params", fm.params, ""));
  if (fm.tags.length > 0) lines.push(`tags: ${flowSeq(fm.tags)}`);
  if (fm.start) lines.push(`start: ${scalar(fm.start.raw)}`);
  if (fm.auth !== undefined) lines.push(`auth: ${scalar(fm.auth)}`);
  lines.push(...block("data", fm.data, ""));
  for (const key of ["setup", "teardown"] as const) {
    if (fm[key].length > 0) lines.push(`${key}:`, ...fm[key].flatMap(hookLines));
  }
  if (fm.timeout !== undefined) lines.push(`timeout: ${formatDuration(fm.timeout)}`);
  if (fm.heal !== undefined) lines.push(`heal: ${fm.heal}`);
  if (fm.allowDestructive.length > 0)
    lines.push(`allowDestructive: ${flowSeq(fm.allowDestructive)}`);
  if (fm.dataset !== undefined) lines.push(`dataset: ${scalar(fm.dataset)}`);
  const envs = Object.entries(fm.environments);
  if (envs.length > 0) {
    lines.push("environments:");
    for (const [name, env] of envs) {
      const inner: string[] = [];
      if (env.start) inner.push(`    start: ${scalar(env.start.raw)}`);
      if (env.data) inner.push(...block("data", env.data, "    "));
      if (env.timeout !== undefined) inner.push(`    timeout: ${formatDuration(env.timeout)}`);
      lines.push(inner.length > 0 ? `  ${scalar(name)}:` : `  ${scalar(name)}: {}`, ...inner);
    }
  }
  if (Object.keys(fm.extra).length > 0) {
    lines.push(...stringify(fm.extra, OPTIONS).trimEnd().split("\n"));
  }
  return lines;
}

const PREFIX: Record<Exclude<Step["kind"], "action">, string> = {
  expect: "Expect: ",
  soft: "Soft: ",
  guard: "Never: ",
  flow: "Use: ",
  exact: "Exact: ",
};

function fenceFor(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function printStep(step: Step): string[] {
  const number = step.number === null ? "" : `${step.number}. `;
  if (step.kind === "exact" && step.exact.form === "code") {
    const pad = " ".repeat(number.length || 2);
    const fence = fenceFor(step.exact.code);
    const code = step.exact.code.split("\n").map((line) => (line === "" ? "" : pad + line));
    const open = `${fence}${step.exact.lang}`;
    return step.exact.label
      ? [`${number}${step.exact.label}`, pad + open, ...code, pad + fence]
      : [`${number}${open}`, ...code, pad + fence];
  }
  const prefix = step.kind === "action" ? "" : PREFIX[step.kind];
  switch (step.kind) {
    case "flow": {
      const params = Object.keys(step.params).length > 0 ? ` ${flowMap(raws(step.params))}` : "";
      return [`${number}${prefix}${step.path}${params}`];
    }
    case "exact":
      if (step.exact.form !== "op") return [];
      // Mock: has its own prefix (printExactOp includes it).
      return step.exact.op.op === "mock"
        ? [`${number}${printExactOp(step.exact.op, (t) => t.raw)}`]
        : [`${number}${prefix}${printExactOp(step.exact.op, (t) => t.raw)}`];
    default:
      return [`${number}${prefix}${step.text.raw}`];
  }
}

function printItem(item: BodyItem): string[] {
  switch (item.type) {
    case "blank":
      return [""];
    case "comment":
    case "text":
      return item.text.split("\n");
    default:
      return printStep(item);
  }
}

/** Canonical file text for a spec. */
export function printTest(spec: TestSpec): string {
  const body: string[] = [];
  for (const item of spec.body) {
    if (item.type === "blank" && (body.length === 0 || body[body.length - 1] === "")) continue;
    body.push(...printItem(item));
  }
  while (body[body.length - 1] === "") body.pop();
  const head = ["---", ...printFrontmatter(spec.frontmatter), "---"].join("\n");
  return body.length > 0 ? `${head}\n\n${body.join("\n")}\n` : `${head}\n`;
}

/** A deep copy without source positions (`at` on nodes, `fields` on the spec): what printing keeps. */
export function withoutSource<T>(value: T): T {
  const strip = (v: unknown, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((item) => strip(item, false));
    if (typeof v !== "object" || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) {
      const isPosition =
        key === "at" && typeof item === "object" && item !== null && "range" in item;
      if (isPosition || (top && key === "fields")) continue;
      out[key] = strip(item, false);
    }
    return out;
  };
  return strip(value, true) as T;
}
