import { HEAL_POLICIES } from "@testament/contract";
import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument, Scalar } from "yaml";
import { z } from "zod";
import {
  DESTRUCTIVE_ACTIONS,
  type EnvironmentOverride,
  type Frontmatter,
  type Hook,
  HTTP_METHODS,
  type HttpMethod,
  type Range,
  type Template,
} from "./model.js";
import { parseTemplate } from "./template.js";
import { type Reporter, SourceMap } from "./text.js";

/** Known fields, in canonical (printed) order. */
export const FRONTMATTER_KEYS = [
  "name",
  "kind",
  "params",
  "tags",
  "start",
  "auth",
  "data",
  "setup",
  "teardown",
  "timeout",
  "heal",
  "allowDestructive",
  "dataset",
  "environments",
] as const;

const ENVIRONMENT_KEYS = ["start", "data", "timeout"] as const;
export const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Positions of every node in the frontmatter, by path (`setup[0].request`). */
export interface YamlIndex {
  /** Range of the value at a path (for a map entry: key through value). */
  ranges: Map<string, Range>;
  /** Range of a map key. */
  keys: Map<string, Range>;
  /** Maps offsets inside a scalar's content to file positions. */
  scalars: Map<string, SourceMap>;
  /** The frontmatter block, for problems with no better place. */
  whole: Range;
}

export const joinPath = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;

/** Parses the YAML between the `---` lines. `firstLine` is the file line of its first line. */
export function parseFrontmatterYaml(
  text: string,
  firstLine: number,
  whole: Range,
  report: Reporter,
): { value: unknown; index: YamlIndex } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: false, prettyErrors: false });
  const pos = (offset: number) => {
    const { line, col } = lineCounter.linePos(offset);
    return { line: line + firstLine - 1, column: col };
  };
  const rangeOf = (start: number, end: number): Range => ({ start: pos(start), end: pos(end) });
  const index: YamlIndex = { ranges: new Map(), keys: new Map(), scalars: new Map(), whole };

  for (const error of doc.errors) {
    const [start, end] = error.pos;
    report.error(
      "YAML_SYNTAX",
      rangeOf(start, Math.max(end, start + 1)),
      `The frontmatter is not valid YAML: ${error.message.split("\n")[0]}`,
      "Fix the YAML between the --- lines (check indentation, colons and quotes).",
    );
  }

  const walk = (node: unknown, path: string) => {
    if (isScalar(node) && node.range) {
      const quoted = node.type === Scalar.QUOTE_DOUBLE || node.type === Scalar.QUOTE_SINGLE;
      const start = pos(node.range[0] + (quoted ? 1 : 0));
      index.scalars.set(path, SourceMap.at(start.line, start.column));
    }
    if (isMap(node)) {
      const seen = new Set<string>();
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        const keyPath = joinPath(path, key);
        const keyNode = pair.key as Node | null;
        const valueNode = pair.value as Node | null;
        const start = keyNode?.range?.[0] ?? valueNode?.range?.[0] ?? 0;
        const end = valueNode?.range?.[1] ?? keyNode?.range?.[1] ?? start;
        const keyRange = keyNode?.range ? rangeOf(keyNode.range[0], keyNode.range[1]) : undefined;
        if (seen.has(key)) {
          report.error(
            "YAML_DUPLICATE_KEY",
            keyRange,
            `"${keyPath}" appears more than once in the frontmatter.`,
            `Keep one "${key}" and delete the other.`,
            keyPath,
          );
        }
        seen.add(key);
        if (!index.ranges.has(keyPath)) index.ranges.set(keyPath, rangeOf(start, end));
        if (keyRange && !index.keys.has(keyPath)) index.keys.set(keyPath, keyRange);
        walk(valueNode, keyPath);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const itemNode = item as Node | null;
        const itemPath = joinPath(path, i);
        if (itemNode?.range)
          index.ranges.set(itemPath, rangeOf(itemNode.range[0], itemNode.range[1]));
        walk(itemNode, itemPath);
      });
    }
  };
  walk(doc.contents, "");
  const value = doc.errors.length > 0 ? undefined : doc.toJS({ maxAliasCount: 100 });
  return { value, index };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TIMEOUT = /^(\d+(?:\.\d+)?)\s*(s|m|h)$/;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600 } as const;

/** "90s" | "3m" | "1h" → seconds; undefined when invalid. */
export function parseDuration(text: string): number | undefined {
  const match = TIMEOUT.exec(text.trim());
  if (!match) return undefined;
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** Canonical duration text: the largest unit that divides exactly. */
export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

class Validator {
  constructor(
    readonly index: YamlIndex,
    readonly report: Reporter,
  ) {}

  range(path: string): Range {
    return this.index.ranges.get(path) ?? this.index.whole;
  }

  invalid(path: string, message: string, fix: string) {
    this.report.error("INVALID_VALUE", this.range(path), message, fix, path);
  }

  /** zod check: the first issue becomes an INVALID_VALUE at its exact path. */
  check<T>(schema: z.ZodType<T>, value: unknown, path: string, fix: string): T | undefined {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const at = (issue?.path ?? []).reduce<string>(
      (p, k) => joinPath(p, typeof k === "number" ? k : String(k)),
      path,
    );
    this.invalid(at, `"${at}" is invalid: ${issue?.message ?? "wrong type"}.`, fix);
    return undefined;
  }

  template(value: unknown, path: string): Template {
    const raw = typeof value === "string" ? value : String(value);
    return parseTemplate(raw, this.index.scalars.get(path), this.report);
  }

  unknownKeys(value: Record<string, unknown>, known: readonly string[], path: string) {
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue;
      const keyPath = joinPath(path, key);
      this.report.warn(
        "UNKNOWN_KEY",
        this.index.keys.get(keyPath) ?? this.range(keyPath),
        `"${keyPath}" is not a test file field; it is ignored.`,
        `Remove it, or use one of: ${known.join(", ")}.`,
        keyPath,
      );
    }
  }

  duration(value: unknown, path: string): number | undefined {
    const seconds = typeof value === "string" ? parseDuration(value) : undefined;
    if (seconds === undefined) {
      this.invalid(
        path,
        `"${path}" must be a duration like "90s", "3m" or "1h", got ${JSON.stringify(value)}.`,
        `Write the timeout with a unit, e.g. timeout: 3m.`,
      );
    }
    return seconds;
  }

  scalarMap(value: unknown, path: string, allowNull: boolean): Record<string, Template | null> {
    const out: Record<string, Template | null> = {};
    if (!isObject(value)) {
      this.invalid(
        path,
        `"${path}" must be a map of name: value.`,
        `Write it as\n${path}:\n  name: value`,
      );
      return out;
    }
    for (const [key, item] of Object.entries(value)) {
      const itemPath = joinPath(path, key);
      if (!NAME.test(key)) {
        this.invalid(
          itemPath,
          `"${key}" is not a valid name; names start with a letter and use letters, digits, - and _.`,
          `Rename it, e.g. "${key.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[^A-Za-z_]+/, "") || "value"}".`,
        );
        continue;
      }
      if (item === null && allowNull) out[key] = null;
      else if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        out[key] = this.template(item, itemPath);
      } else {
        this.invalid(
          itemPath,
          `"${itemPath}" must be a single value (text, number or true/false).`,
          allowNull
            ? `Give ${key} a default value, or leave it empty (${key}:) to make it required.`
            : `Give ${key} one value; lists and nested maps are not supported.`,
        );
      }
    }
    return out;
  }

  hooks(value: unknown, path: string): Hook[] {
    if (!Array.isArray(value)) {
      this.report.error(
        "HOOK_INVALID",
        this.range(path),
        `"${path}" must be a list of hooks.`,
        `Write it as\n${path}:\n  - request: POST /api/seed`,
        path,
      );
      return [];
    }
    const hooks: Hook[] = [];
    value.forEach((item, i) => {
      const itemPath = joinPath(path, i);
      const at = { range: this.range(itemPath) };
      const bad = (message: string, fix: string, where = itemPath) =>
        this.report.error("HOOK_INVALID", this.range(where), message, fix, where);
      if (!isObject(item)) {
        bad(
          `${itemPath} must be one of request:, run: or sql:.`,
          `Write e.g. "- request: POST /api/seed".`,
        );
        return;
      }
      const kinds = (["request", "run", "sql"] as const).filter((k) => k in item);
      if (kinds.length !== 1) {
        bad(
          kinds.length === 0
            ? `${itemPath} needs request:, run: or sql:.`
            : `${itemPath} has ${kinds.join(" and ")}; a hook does exactly one thing.`,
          "Split it into one hook per request, script or statement.",
        );
        return;
      }
      const kind = kinds[0] as "request" | "run" | "sql";
      const known = kind === "request" ? ["request", "body", "headers"] : [kind];
      this.unknownKeys(item, known, itemPath);
      const text = item[kind as string];
      const textPath = joinPath(itemPath, kind as string);
      if (typeof text !== "string" || text.trim() === "") {
        bad(
          `${textPath} must be text.`,
          `Write e.g. ${kind}: ${kind === "request" ? "POST /api/seed" : kind === "run" ? "scripts/seed.sh" : "DELETE FROM carts"}.`,
          textPath,
        );
        return;
      }
      if (kind === "run") hooks.push({ type: "run", script: text.trim(), at });
      else if (kind === "sql") hooks.push({ type: "sql", statement: text.trim(), at });
      else {
        const match = /^([A-Za-z]+)\s+(\S+)$/.exec(text.trim());
        const method = match?.[1]?.toUpperCase();
        const target = match?.[2] ?? "";
        if (!match || !(HTTP_METHODS as readonly string[]).includes(method ?? "")) {
          bad(
            `"${text}" is not a request; expected "METHOD path", e.g. "POST /api/seed".`,
            `Use one of ${HTTP_METHODS.join(", ")} followed by a path or URL.`,
            textPath,
          );
          return;
        }
        if (!target.startsWith("/") && !/^https?:\/\//.test(target)) {
          bad(
            `"${target}" must be a path starting with / or an http(s) URL.`,
            `Write e.g. "${method} /${target}".`,
            textPath,
          );
          return;
        }
        const hook: Extract<Hook, { type: "request" }> = {
          type: "request",
          method: method as HttpMethod,
          target,
          at,
        };
        if ("body" in item) hook.body = item.body;
        if ("headers" in item) {
          const headers = this.check(
            z.record(z.string(), z.string()),
            item.headers,
            joinPath(itemPath, "headers"),
            'Write headers as a map of text values, e.g. headers: { X-Env: "test" }.',
          );
          if (headers) hook.headers = headers;
        }
        hooks.push(hook);
      }
    });
    return hooks;
  }
}

const nonEmpty = z.string().trim().min(1, "must not be empty");

/** Validates the frontmatter object into the typed model. Never throws. */
export function validateFrontmatter(
  value: unknown,
  index: YamlIndex,
  report: Reporter,
): Frontmatter {
  const fm: Frontmatter = {
    name: "",
    kind: "test",
    tags: [],
    data: {},
    params: {},
    allowDestructive: [],
    setup: [],
    teardown: [],
    environments: {},
    extra: {},
  };
  const v = new Validator(index, report);
  if (value === undefined || value === null) {
    report.error(
      "REQUIRED_MISSING",
      index.whole,
      "The test has no name.",
      'Add a name to the frontmatter, e.g. "name: New customer can check out".',
      "name",
    );
    return fm;
  }
  if (!isObject(value)) {
    report.error(
      "FRONTMATTER_NOT_OBJECT",
      index.whole,
      "The frontmatter must be a list of fields (name: …, tags: …).",
      'Write fields as "key: value" lines between the --- lines.',
    );
    return fm;
  }
  v.unknownKeys(value, FRONTMATTER_KEYS, "");
  for (const key of Object.keys(value)) {
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key)) fm.extra[key] = value[key];
  }

  if (value.kind !== undefined) {
    const kind = v.check(
      z.enum(["test", "flow"]),
      value.kind,
      "kind",
      "Use kind: test or kind: flow.",
    );
    if (kind) fm.kind = kind;
  }
  if (value.name === undefined || value.name === null) {
    report.error(
      "REQUIRED_MISSING",
      index.whole,
      `The ${fm.kind} has no name.`,
      'Add a name to the frontmatter, e.g. "name: New customer can check out".',
      "name",
    );
  } else {
    fm.name =
      v.check(nonEmpty, value.name, "name", "Give it a short name, e.g. name: Guest checkout.") ??
      "";
  }
  if (value.tags !== undefined) {
    fm.tags =
      v.check(
        z.array(nonEmpty),
        value.tags,
        "tags",
        `Write tags as a list, e.g. tags: [${typeof value.tags === "string" ? value.tags : "smoke"}].`,
      ) ?? [];
  }
  if (value.start !== undefined) {
    const start = v.check(
      nonEmpty,
      value.start,
      "start",
      "Write the start page, e.g. start: /pricing.",
    );
    if (start !== undefined) fm.start = v.template(value.start, "start");
  }
  if (value.auth !== undefined) {
    const auth = v.check(
      nonEmpty,
      value.auth,
      "auth",
      "Name an auth profile, or write auth: none.",
    );
    if (auth !== undefined) fm.auth = auth;
  }
  if (value.data !== undefined) {
    fm.data = v.scalarMap(value.data, "data", false) as Record<string, Template>;
  }
  if (value.params !== undefined) {
    if (fm.kind !== "flow") {
      report.error(
        "PARAMS_OUTSIDE_FLOW",
        v.range("params"),
        "Only flows (kind: flow) take params.",
        "Add kind: flow if this file is a reusable flow, or move these values to data:.",
        "params",
      );
    } else fm.params = v.scalarMap(value.params, "params", true);
  }
  if (value.timeout !== undefined) {
    const seconds = v.duration(value.timeout, "timeout");
    if (seconds !== undefined) fm.timeout = seconds;
  }
  if (value.heal !== undefined) {
    const heal = v.check(
      z.enum(HEAL_POLICIES),
      value.heal,
      "heal",
      "Use heal: strict, review or auto.",
    );
    if (heal) fm.heal = heal;
  }
  if (value.allowDestructive !== undefined) {
    fm.allowDestructive =
      v.check(
        z.array(z.enum(DESTRUCTIVE_ACTIONS)),
        value.allowDestructive,
        "allowDestructive",
        `List the actions this test may do, from: ${DESTRUCTIVE_ACTIONS.join(", ")}; e.g. allowDestructive: [delete].`,
      ) ?? [];
  }
  if (value.dataset !== undefined) {
    const dataset = v.check(
      nonEmpty.regex(/\.(csv|json)$/i, "must be a .csv or .json file"),
      value.dataset,
      "dataset",
      "Point it at a CSV or JSON file, e.g. dataset: data/users.csv.",
    );
    if (dataset !== undefined) fm.dataset = dataset;
  }
  if (value.setup !== undefined) fm.setup = v.hooks(value.setup, "setup");
  if (value.teardown !== undefined) fm.teardown = v.hooks(value.teardown, "teardown");
  if (value.environments !== undefined) {
    if (!isObject(value.environments)) {
      v.invalid(
        "environments",
        '"environments" must be a map of environment name: overrides.',
        "Write e.g.\nenvironments:\n  staging:\n    start: /login",
      );
    } else {
      for (const [name, override] of Object.entries(value.environments)) {
        const path = joinPath("environments", name);
        if (!isObject(override)) {
          v.invalid(
            path,
            `"${path}" must be a map with start, data or timeout.`,
            `Write e.g.\n  ${name}:\n    timeout: 5m`,
          );
          continue;
        }
        v.unknownKeys(override, ENVIRONMENT_KEYS, path);
        const env: EnvironmentOverride = {};
        if (override.start !== undefined) {
          const start = v.check(
            nonEmpty,
            override.start,
            joinPath(path, "start"),
            "Write the start page, e.g. start: /pricing.",
          );
          if (start !== undefined) env.start = v.template(override.start, joinPath(path, "start"));
        }
        if (override.data !== undefined) {
          env.data = v.scalarMap(override.data, joinPath(path, "data"), false) as Record<
            string,
            Template
          >;
        }
        if (override.timeout !== undefined) {
          const seconds = v.duration(override.timeout, joinPath(path, "timeout"));
          if (seconds !== undefined) env.timeout = seconds;
        }
        fm.environments[name] = env;
      }
    }
  }
  return fm;
}

export type { HttpMethod };
