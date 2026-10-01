import type { Config } from "@optestra/config";
import { type CheckContext, checkTest } from "../check.js";
import { printExactOp } from "../exact.js";
import { type FileReader, flowCandidates, normalizePath } from "../expand.js";
import { FRONTMATTER_KEYS } from "../frontmatter.js";
import { defaultGenerators, type GeneratorRegistry } from "../generators.js";
import { ruleById } from "../lint/lint.js";
import { linesOf } from "../lint/source.js";
import type { Finding, TextEdit } from "../lint/types.js";
import type { LintWords } from "../lint/words.js";
import {
  DESTRUCTIVE_ACTIONS,
  HTTP_METHODS,
  INBOX_MEMBERS,
  type Position,
  type Range,
  type Step,
  specSteps,
  type Template,
  type TestSpec,
} from "../model.js";
import { type ParseResult, parseTest } from "../parse.js";
import { printTest } from "../print.js";
import {
  FIELD_DOCS,
  INBOX_MEMBER_DOCS,
  KEYS,
  LOCATORS,
  NAMESPACE_DOCS,
  OP_DOCS,
  PREFIX_DOCS,
  ROLES,
} from "./docs.js";

/*
 * The editor language service (APP-5): plain functions over (text, path,
 * position), LSP-like shapes, 1-based positions matching the spec model.
 * Browser-safe; files come through `readFile` / `listFiles`. No AI.
 */

export interface LanguageServiceOptions {
  config?: Config | undefined;
  readFile: FileReader;
  /** Project-relative paths of the project's test and flow files (for Use: completion). */
  listFiles?: (() => readonly string[] | Promise<readonly string[]>) | undefined;
  generators?: GeneratorRegistry | undefined;
  /** Auth profile names, for `auth:` completion. */
  authProfiles?: readonly string[] | undefined;
  /** Whether a secret has a value (from the keychain/vault). Never returns the value. */
  isSecretSet?: ((name: string) => boolean | undefined) | undefined;
  /** Environment for overrides and `{{env.X}}`. */
  environment?: string | undefined;
  words?: LintWords | undefined;
}

export type CompletionKind = "keyword" | "variable" | "file" | "value" | "property" | "number";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail?: string;
  /** Text that replaces `range`. */
  insertText: string;
  range: Range;
}

export interface Hover {
  /** Markdown. */
  contents: string;
  range?: Range;
}

export interface CodeAction {
  title: string;
  kind: "quickfix";
  edits: TextEdit[];
  /** Safe fixes may be applied without asking; never true on an expectation line. */
  safe: boolean;
  /** The finding it fixes. */
  diagnostic: Finding;
}

export interface OutlineItem {
  kind: Step["kind"];
  number: number | null;
  label: string;
  range: Range;
}

export interface Definition {
  path: string;
  range: Range;
}

export interface LanguageService {
  diagnostics(text: string, path: string): Promise<Finding[]>;
  completions(text: string, path: string, position: Position): Promise<CompletionItem[]>;
  hover(text: string, path: string, position: Position): Promise<Hover | null>;
  codeActions(text: string, path: string, range: Range): Promise<CodeAction[]>;
  format(text: string, path: string): TextEdit[];
  outline(text: string, path: string): OutlineItem[];
  definition(text: string, path: string, position: Position): Promise<Definition | null>;
}

const within = (p: Position, r: Range | undefined) =>
  !!r &&
  (p.line > r.start.line || (p.line === r.start.line && p.column >= r.start.column)) &&
  (p.line < r.end.line || (p.line === r.end.line && p.column <= r.end.column));

const overlaps = (a: Range, b: Range | undefined) =>
  !!b &&
  !(
    a.end.line < b.start.line ||
    (a.end.line === b.start.line && a.end.column < b.start.column) ||
    b.end.line < a.start.line ||
    (b.end.line === a.start.line && b.end.column < a.start.column)
  );

const at = (line: number, from: number, to: number): Range => ({
  start: { line, column: from },
  end: { line, column: to },
});

/** Every template in a spec, with the scope it belongs to. */
function templates(spec: TestSpec): Template[] {
  const fm = spec.frontmatter;
  const out: Template[] = [];
  if (fm.start) out.push(fm.start);
  out.push(
    ...Object.values(fm.data),
    ...Object.values(fm.params).filter((t): t is Template => t !== null),
  );
  for (const env of Object.values(fm.environments)) {
    if (env.start) out.push(env.start);
    out.push(...Object.values(env.data ?? {}));
  }
  for (const step of specSteps(spec)) {
    if (step.kind === "flow") out.push(...Object.values(step.params));
    else if (step.kind === "exact") {
      if (step.exact.form === "op") {
        const op = step.exact.op as Record<string, unknown>;
        for (const value of Object.values(op)) {
          if (typeof value === "object" && value !== null && "segments" in value)
            out.push(value as Template);
        }
      }
    } else out.push(step.text);
  }
  return out;
}

function stepLabel(step: Step): string {
  switch (step.kind) {
    case "flow":
      return `Use: ${step.path}`;
    case "exact":
      return step.exact.form === "op"
        ? `Exact: ${printExactOp(step.exact.op, (t) => t.raw)}`
        : (step.exact.label ?? "TypeScript code");
    case "expect":
      return `Expect: ${step.text.raw}`;
    case "soft":
      return `Soft: ${step.text.raw}`;
    case "guard":
      return `Never: ${step.text.raw}`;
    default:
      return step.text.raw;
  }
}

/** Line numbers (1-based) inside fenced code blocks, fence lines included. */
function fencedLines(lines: readonly string[], bodyStart: number): Set<number> {
  const out = new Set<number>();
  let open: string | undefined;
  for (let i = bodyStart - 1; i < lines.length; i++) {
    const content = (lines[i] ?? "").trim().replace(/^\d+[.)]\s*/, "");
    const fence = /^(`{3,})/.exec(content)?.[1];
    if (open) {
      out.add(i + 1);
      if (fence && fence.length >= open.length && content.replace(/`/g, "") === "")
        open = undefined;
    } else if (fence) {
      open = fence;
      out.add(i + 1);
    }
  }
  return out;
}

function frontmatterClose(lines: readonly string[]): number | undefined {
  if ((lines[0] ?? "").trim() !== "---") return undefined;
  const index = lines.findIndex(
    (line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  return index < 0 ? lines.length + 1 : index + 1;
}

export function createLanguageService(options: LanguageServiceOptions): LanguageService {
  const generators = options.generators ?? defaultGenerators;
  const config = options.config;
  const testsDir = normalizePath(config?.tests?.dir ?? "tests") ?? "tests";
  let lastParse: { text: string; path: string; result: ParseResult } | undefined;
  const parse = (text: string, path: string): ParseResult => {
    if (lastParse && lastParse.text === text && lastParse.path === path) return lastParse.result;
    const result = parseTest(text, path, { config, generators });
    lastParse = { text, path, result };
    return lastParse.result;
  };
  const checkContext = (path: string, text: string): CheckContext => ({
    readFile: (p) => (p === path ? text : options.readFile(p)),
    config,
    generators,
    environment: options.environment,
    vars: options.environment ? config?.environments[options.environment]?.vars : undefined,
    testsDir,
    words: options.words,
  });
  const diagnostics = async (text: string, path: string) =>
    (await checkTest(text, path, checkContext(path, text))).findings;

  async function readFlow(path: string): Promise<TestSpec | undefined> {
    try {
      const text = await options.readFile(path);
      return text === undefined ? undefined : parseTest(text, path, { config, generators }).spec;
    } catch {
      return undefined;
    }
  }

  async function resolveFlow(from: string, use: string) {
    for (const candidate of flowCandidates(from, use, testsDir)) {
      const spec = await readFlow(candidate);
      if (spec) return { path: candidate, spec };
    }
    return undefined;
  }

  function secretNames(spec: TestSpec): string[] {
    const names = new Set<string>(Object.keys(config?.secrets ?? {}));
    for (const env of Object.values(config?.environments ?? {})) {
      for (const name of Object.keys(env.secrets ?? {})) names.add(name);
    }
    if (!config) {
      for (const t of templates(spec)) {
        for (const s of t.segments) if (s.kind === "var" && s.ns === "secret") names.add(s.name);
      }
    }
    return [...names].sort();
  }

  function envVarNames(): string[] {
    const names = new Set<string>();
    for (const env of Object.values(config?.environments ?? {})) {
      for (const name of Object.keys(env.vars ?? {})) names.add(name);
    }
    return [...names].sort();
  }

  function members(ns: string, spec: TestSpec): [string, string][] {
    const fm = spec.frontmatter;
    switch (ns) {
      case "data": {
        const keys = new Set(Object.keys(fm.data));
        for (const env of Object.values(fm.environments))
          for (const k of Object.keys(env.data ?? {})) keys.add(k);
        return [...keys].map((k) => [k, fm.data[k]?.raw ?? "(set per environment)"]);
      }
      case "params":
        return fm.kind === "flow"
          ? Object.entries(fm.params).map(([k, v]) => [k, v ? `default: ${v.raw}` : "required"])
          : [];
      case "secret":
        return secretNames(spec).map((n) => [n, "secret"]);
      case "env":
        return envVarNames().map((n) => [n, "environment variable"]);
      case "unique":
      case "faker":
        return generators.members(ns).map((m) => [m, "generated per run"]);
      case "inbox":
        return INBOX_MEMBERS.map((m) => [m, INBOX_MEMBER_DOCS[m] ?? "from the test inbox"]);
      default:
        return [];
    }
  }

  async function completions(
    text: string,
    path: string,
    position: Position,
  ): Promise<CompletionItem[]> {
    const lines = linesOf(text);
    const line = lines[position.line - 1] ?? "";
    const before = line.slice(0, position.column - 1);
    const after = line.slice(position.column - 1);
    const close = frontmatterClose(lines);
    const inFrontmatter = close !== undefined && position.line > 1 && position.line < close;
    if (close !== undefined && (position.line === 1 || position.line === close)) return [];
    if (!inFrontmatter && fencedLines(lines, (close ?? 0) + 1).has(position.line)) return [];
    const { spec } = parse(text, path);
    const cursor = position.column;
    const item = (
      label: string,
      kind: CompletionKind,
      insertText: string,
      from: number,
      detail?: string,
    ) => ({
      label,
      kind,
      insertText,
      range: at(position.line, from, cursor),
      ...(detail && { detail }),
    });

    // Variables, anywhere outside code: after an unclosed {{
    const open = before.lastIndexOf("{{");
    if (open >= 0 && before.indexOf("}}", open) < 0 && before[open - 1] !== "\\") {
      const partial = before.slice(open + 2);
      const closes = /^\s*\}\}/.test(after);
      const nsOnly = /^\s*([A-Za-z_]*)$/.exec(partial);
      if (nsOnly) {
        const from = cursor - (nsOnly[1]?.length ?? 0);
        return Object.entries(NAMESPACE_DOCS)
          .filter(([ns]) => ns.startsWith((nsOnly[1] ?? "").toLowerCase()))
          .filter(([ns]) => ns !== "params" || spec.frontmatter.kind === "flow")
          .map(([ns, doc]) => item(ns, "keyword", `${ns}.`, from, doc));
      }
      const member = /^\s*([A-Za-z_]+)\.([\w-]*)$/.exec(partial);
      if (member) {
        const [, ns = "", typed = ""] = member;
        const from = cursor - typed.length;
        return members(ns, spec)
          .filter(([name]) => name.toLowerCase().startsWith(typed.toLowerCase()))
          .map(([name, detail]) =>
            item(name, "variable", closes ? name : `${name}}}`, from, detail),
          );
      }
      return [];
    }

    if (inFrontmatter) return frontmatterCompletions(before, position, lines, spec, item);

    // Use: flow paths
    const use = /^\s*(?:\d+[.)]\s+)?use:\s*(\S*)$/i.exec(before);
    if (use) {
      const typed = use[1] ?? "";
      const files = (await options.listFiles?.()) ?? [];
      const dir = path.split("/").slice(0, -1).join("/");
      const out: CompletionItem[] = [];
      for (const file of files) {
        if (file === path) continue;
        const flow = await readFlow(file);
        if (flow?.frontmatter.kind !== "flow") continue;
        const rel =
          dir && file.startsWith(`${dir}/`)
            ? file.slice(dir.length + 1)
            : file.startsWith(`${testsDir}/`)
              ? file.slice(testsDir.length + 1)
              : `/${file}`;
        if (rel.startsWith(typed))
          out.push(item(rel, "file", rel, cursor - typed.length, flow.frontmatter.name));
      }
      return out;
    }

    // Exact: ops, keywords and locators
    const exact = /^\s*(?:\d+[.)]\s+)?exact:\s*(.*)$/i.exec(before);
    if (exact) return exactCompletions(exact[1] ?? "", cursor, item);

    // Line start: prefixes and the next step number
    const numbered = /^(\s*)(\d+)[.)]\s+([A-Za-z]*)$/.exec(before);
    if (numbered) {
      const typed = numbered[3] ?? "";
      return PREFIX_DOCS.filter(([p]) => p.toLowerCase().startsWith(typed.toLowerCase())).map(
        ([p, doc]) => item(p.trim(), "keyword", p, cursor - typed.length, doc),
      );
    }
    const bare = /^\s*([A-Za-z]*)$/.exec(before);
    if (bare) {
      const typed = bare[1] ?? "";
      const last = specSteps(spec)
        .filter((s) => s.number !== null && (s.at?.range.start.line ?? 0) < position.line)
        .pop();
      const next = `${(last?.number ?? 0) + 1}. `;
      const out: CompletionItem[] = [];
      if (typed === "") out.push(item(next.trim(), "number", next, cursor, "next step"));
      if ("never:".startsWith(typed.toLowerCase())) {
        out.push(
          item("Never:", "keyword", "Never: ", cursor - typed.length, "A guard for the whole test"),
        );
      }
      return out;
    }
    return [];
  }

  function frontmatterCompletions(
    before: string,
    position: Position,
    lines: readonly string[],
    spec: TestSpec,
    item: (
      label: string,
      kind: CompletionKind,
      insertText: string,
      from: number,
      detail?: string,
    ) => CompletionItem,
  ): CompletionItem[] {
    const cursor = position.column;
    const parentKey = (() => {
      for (let i = position.line - 2; i >= 1; i--) {
        const match = /^([A-Za-z]+):/.exec(lines[i] ?? "");
        if (match) return match[1];
      }
      return undefined;
    })();
    const key = /^([A-Za-z]*)$/.exec(before);
    if (key) {
      const typed = key[1] ?? "";
      const present = new Set(Object.keys(spec.fields ?? {}).filter((k) => !/[.[]/.test(k)));
      return FRONTMATTER_KEYS.filter((k) => !present.has(k) && k.startsWith(typed)).map((k) =>
        item(k, "property", `${k}: `, cursor - typed.length, FIELD_DOCS[k]),
      );
    }
    const values = (typed: string, list: readonly string[], detail?: string) =>
      list
        .filter((v) => v.startsWith(typed))
        .map((v) => item(v, "value", v, cursor - typed.length, detail));
    const scalar = /^(kind|heal|auth|timeout):\s*([\w-]*)$/.exec(before);
    if (scalar) {
      const typed = scalar[2] ?? "";
      switch (scalar[1]) {
        case "kind":
          return values(typed, ["test", "flow"]);
        case "heal":
          return values(typed, ["strict", "review", "auto"]);
        case "auth":
          return values(typed, [...(options.authProfiles ?? []), "none"], "auth profile");
        default:
          return values(typed, ["30s", "1m", "3m", "5m"]);
      }
    }
    const destructive = /^allowDestructive:\s*\[?(?:[\w\s]*,\s*)*(\w*)$/.exec(before);
    if (destructive) return values(destructive[1] ?? "", DESTRUCTIVE_ACTIONS, "destructive action");
    if (parentKey === "setup" || parentKey === "teardown") {
      const hook = /^\s*-\s*(\w*)$/.exec(before);
      if (hook) {
        const typed = hook[1] ?? "";
        return ["request", "run", "sql"]
          .filter((k) => k.startsWith(typed))
          .map((k) => item(k, "property", `${k}: `, cursor - typed.length));
      }
      const method = /^\s*-?\s*request:\s*"?([A-Za-z]*)$/.exec(before);
      if (method) {
        const typed = (method[1] ?? "").toUpperCase();
        return HTTP_METHODS.filter((m) => m.startsWith(typed)).map((m) =>
          item(m, "value", `${m} `, cursor - (method[1] ?? "").length),
        );
      }
    }
    if (parentKey === "environments") {
      const envKey = /^ {4}(\w*)$/.exec(before);
      if (envKey)
        return values(envKey[1] ?? "", ["start", "data", "timeout"]).map((c) => ({
          ...c,
          insertText: `${c.label}: `,
          kind: "property",
        }));
      const envName = /^ {2}(\w*)$/.exec(before);
      if (envName) {
        return values(envName[1] ?? "", Object.keys(config?.environments ?? {}), "environment").map(
          (c) => ({
            ...c,
            insertText: `${c.label}:`,
          }),
        );
      }
    }
    return [];
  }

  function exactCompletions(
    rest: string,
    cursor: number,
    item: (
      label: string,
      kind: CompletionKind,
      insertText: string,
      from: number,
      detail?: string,
    ) => CompletionItem,
  ): CompletionItem[] {
    const tokens = rest.match(/"[^"]*"?|\S+/g) ?? [];
    const typing = rest.length > 0 && !/\s$/.test(rest) ? (tokens.pop() ?? "") : "";
    const from = cursor - typing.length;
    const offer = (list: readonly string[], kind: CompletionKind = "keyword") =>
      list
        .filter((w) => w.startsWith(typing))
        .map((w) => item(w, kind, w.endsWith("=") || w.endsWith('"') ? w : `${w} `, from));
    const locators = () => {
      if (typing.startsWith("role=")) {
        return ROLES.filter((r) => `role=${r}`.startsWith(typing)).map((r) =>
          item(`role=${r}`, "value", `role=${r}`, from, "ARIA role"),
        );
      }
      return LOCATORS.filter(([l]) => l.startsWith(typing)).map(([l, doc]) =>
        item(l, "value", l, from, doc),
      );
    };
    const [first, second] = tokens;
    if (!first) {
      return Object.keys(OP_DOCS)
        .filter((op) => op.startsWith(typing))
        .map((op) => item(op, "keyword", `${op} `, from, OP_DOCS[op]));
    }
    switch (first) {
      case "click":
        return tokens.length === 1 ? locators() : [];
      case "fill":
        return tokens.length === 1 ? locators() : tokens.length === 2 ? offer(["with"]) : [];
      case "select":
        return tokens[tokens.length - 1] === "in"
          ? locators()
          : tokens.length >= 2
            ? offer(["in"])
            : [];
      case "press":
        return tokens.length === 1 ? offer(KEYS, "value") : [];
      case "expect":
        if (tokens.length === 1) return [...offer(["url"]), ...locators()];
        if (second === "url") return tokens.length === 2 ? offer(["contains", "is"]) : [];
        return tokens.length === 2
          ? offer(["text", "contains", "visible", "hidden", "enabled", "disabled", "count"])
          : [];
      default:
        return [];
    }
  }

  async function hover(text: string, path: string, position: Position): Promise<Hover | null> {
    const { spec } = parse(text, path);
    const parts: string[] = [];
    let range: Range | undefined;

    for (const template of templates(spec)) {
      for (const s of template.segments) {
        if (s.kind !== "var" || !within(position, s.at?.range)) continue;
        range = s.at?.range;
        parts.push(variableDoc(s.ns, s.name, spec));
      }
    }
    const lines = linesOf(text);
    const close = frontmatterClose(lines);
    if (parts.length === 0 && close !== undefined && position.line > 1 && position.line < close) {
      const key = /^([A-Za-z]+):/.exec(lines[position.line - 1] ?? "")?.[1];
      if (key && FIELD_DOCS[key] && position.column <= key.length + 1) {
        parts.push(FIELD_DOCS[key]);
        range = at(position.line, 1, key.length + 1);
      }
    }
    for (const step of specSteps(spec)) {
      if (parts.length > 0 || !within(position, step.at?.range)) continue;
      if (step.kind === "flow") {
        const flow = await resolveFlow(path, step.path);
        range = step.at?.path ?? step.at?.range;
        if (!flow) parts.push(`Flow **${step.path}** was not found.`);
        else {
          const params = Object.entries(flow.spec.frontmatter.params).map(
            ([k, v]) =>
              `- \`${k}\`${v ? ` = \`${v.raw}\`` : " (required)"}${step.params[k] ? ` → \`${step.params[k]?.raw}\`` : ""}`,
          );
          parts.push(
            [
              `**${flow.spec.frontmatter.name || flow.path}** (flow, ${specSteps(flow.spec).filter((s) => s.kind !== "guard").length} steps)`,
              `\`${flow.path}\``,
              params.length > 0 ? `Params:\n${params.join("\n")}` : "No params.",
            ].join("\n\n"),
          );
        }
      } else if (step.kind === "exact" && step.exact.form === "op") {
        const op = step.exact.op.op.startsWith("expect") ? "expect" : step.exact.op.op;
        const doc = OP_DOCS[op];
        if (doc) parts.push(doc);
      }
    }
    const findings = (await diagnostics(text, path)).filter((f) => within(position, f.range));
    for (const f of findings) {
      const rule = f.rule ? ruleById(f.rule) : undefined;
      parts.push(
        rule
          ? `**${rule.id}** (${f.severity}): ${f.message}\n\n${rule.why}\n\nFix: ${f.fix}`
          : `**${f.code}** (${f.severity}): ${f.message}\n\nFix: ${f.fix}`,
      );
      range ??= f.range;
    }
    return parts.length > 0
      ? { contents: parts.join("\n\n---\n\n"), ...(range && { range }) }
      : null;
  }

  function variableDoc(ns: string, name: string, spec: TestSpec): string {
    const fm = spec.frontmatter;
    switch (ns) {
      case "data": {
        const value = fm.data[name];
        const envs = Object.entries(fm.environments)
          .filter(([, e]) => e.data?.[name])
          .map(([env, e]) => `- ${env}: \`${e.data?.[name]?.raw}\``);
        return [
          `**data.${name}**`,
          value ? `= \`${value.raw}\`` : "Not in data.",
          envs.length > 0 ? `Per environment:\n${envs.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      case "inbox":
        return INBOX_MEMBER_DOCS[name]
          ? `**inbox.${name}**: ${INBOX_MEMBER_DOCS[name]}\n\nRead from the test inbox (the project's \`inbox\` settings) when the step runs; a recording keeps \`{{inbox.${name}}}\`, never the value.`
          : `**inbox.${name}**: not an inbox value. Use inbox.code, inbox.link or inbox.subject.`;
      case "unique":
      case "faker":
        return `**${ns}.${name}**: generated per run. Each run and worker gets a new value, so parallel runs don't collide. To use the same value twice, put it in data.`;
      case "secret": {
        const declared =
          config?.secrets?.[name] ??
          Object.values(config?.environments ?? {}).find((e) => e.secrets?.[name])?.secrets?.[name];
        const set = options.isSecretSet?.(name);
        return [
          `**secret.${name}**: a secret. The driver types it in; it is never shown to the AI or written to logs.`,
          declared
            ? `May be typed into: ${declared.domains.join(", ") || "no domains"}.`
            : config
              ? "Not declared in the project settings."
              : "",
          set === undefined ? "" : set ? "Value: set." : "Value: missing.",
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      case "params": {
        const value = fm.params[name];
        return `**params.${name}**: ${value === undefined ? "not a param of this flow." : value === null ? "required." : `default \`${value.raw}\`.`}`;
      }
      case "env": {
        const values = Object.entries(config?.environments ?? {})
          .filter(([, e]) => e.vars?.[name] !== undefined)
          .map(([env, e]) => `- ${env}: \`${e.vars[name]}\``);
        return `**env.${name}**: from the environment's vars.${values.length > 0 ? `\n\n${values.join("\n")}` : ""}`;
      }
      default:
        return `**${ns}.${name}**: unknown namespace.`;
    }
  }

  async function codeActions(text: string, path: string, range: Range): Promise<CodeAction[]> {
    const findings = await diagnostics(text, path);
    return findings
      .filter((f) => overlaps(range, f.range))
      .flatMap((f) =>
        f.fixes.map((fix) => ({
          title: fix.title,
          kind: "quickfix" as const,
          edits: fix.edits,
          safe: fix.safe,
          diagnostic: f,
        })),
      );
  }

  function format(text: string, path: string): TextEdit[] {
    const printed = printTest(parse(text, path).spec);
    const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    if (printed === normalized) return [];
    const lines = normalized.split("\n");
    const end = { line: lines.length, column: (lines[lines.length - 1] ?? "").length + 1 };
    return [{ range: { start: { line: 1, column: 1 }, end }, newText: printed }];
  }

  function outline(text: string, path: string): OutlineItem[] {
    return specSteps(parse(text, path).spec).flatMap((step) =>
      step.at
        ? [{ kind: step.kind, number: step.number, label: stepLabel(step), range: step.at.range }]
        : [],
    );
  }

  async function definition(
    text: string,
    path: string,
    position: Position,
  ): Promise<Definition | null> {
    const step = specSteps(parse(text, path).spec).find(
      (s) =>
        s.kind === "flow" &&
        s.at &&
        s.at.range.start.line <= position.line &&
        position.line <= s.at.range.end.line,
    );
    if (step?.kind !== "flow") return null;
    const flow = await resolveFlow(path, step.path);
    return flow ? { path: flow.path, range: at(1, 1, 1) } : null;
  }

  return { diagnostics, completions, hover, codeActions, format, outline, definition };
}
