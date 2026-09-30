import type { HealPolicy, StepKind } from "@testament/contract";

/*
 * The test model. Plain, JSON-safe data: the apps and the MCP server send it
 * over the wire. Every source position lives in an optional `at` field, so
 * editors can build nodes without positions and `withoutSource` can drop them.
 */

/** 1-based line and column. Columns count UTF-16 code units (as editors and LSP do). */
export interface Position {
  line: number;
  column: number;
}

/** `end` is exclusive. */
export interface Range {
  start: Position;
  end: Position;
}

export interface SourceInfo {
  range: Range;
}

// ── Templates ──────────────────────────────────────────────────────────────────

/** Variable namespaces. `unique` and `faker` members come from the generator registry. */
export const NAMESPACES = ["data", "env", "secret", "params", "unique", "faker", "inbox"] as const;
export type Namespace = (typeof NAMESPACES)[number];

/**
 * Members of `{{inbox.…}}` (SEC-5): read from the test inbox at run time, so they
 * always bind as `unresolved` here and a recording keeps the template.
 */
export const INBOX_MEMBERS = ["code", "link", "subject"] as const;
export type InboxMember = (typeof INBOX_MEMBERS)[number];

export type Segment =
  | { kind: "text"; text: string }
  | {
      kind: "var";
      /** As written; not necessarily a known namespace (that is a diagnostic). */
      ns: string;
      name: string;
      /** The reference exactly as written, e.g. `{{ data.email }}`. */
      raw: string;
      at?: SourceInfo;
    };

/** A string that may contain `{{ns.name}}` references. `raw` is the source of truth. */
export interface Template {
  raw: string;
  segments: Segment[];
  at?: SourceInfo;
}

// ── Frontmatter ────────────────────────────────────────────────────────────────

/** SAF-4: destructive actions a test may declare. */
export const DESTRUCTIVE_ACTIONS = ["delete", "pay", "send", "invite", "cancel"] as const;
export type DestructiveAction = (typeof DESTRUCTIVE_ACTIONS)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** AUT-10 setup/teardown hook. Parsed and validated only; execution is later. */
export type Hook =
  | {
      type: "request";
      method: HttpMethod;
      /** A path on the app (`/__test/seed`) or an absolute http(s) URL. */
      target: string;
      body?: unknown;
      headers?: Record<string, string>;
      at?: SourceInfo;
    }
  | { type: "run"; script: string; at?: SourceInfo }
  | {
      type: "sql";
      statement: string;
      /** AUT-10: the statement may run in a production environment (default: never). */
      production?: boolean;
      at?: SourceInfo;
    };

export interface EnvironmentOverride {
  start?: Template;
  data?: Record<string, Template>;
  timeout?: number;
}

export interface Frontmatter {
  /** Required; "" when missing (with a diagnostic). */
  name: string;
  kind: "test" | "flow";
  tags: string[];
  /** Path, absolute URL, or for Android a screen or deep link. */
  start?: Template;
  /** Auth profile name, or `none`. */
  auth?: string;
  data: Record<string, Template>;
  /** Flows only: name → default value; `null` = required. */
  params: Record<string, Template | null>;
  /** Seconds. Written as "90s", "3m" or "1h". */
  timeout?: number;
  heal?: HealPolicy;
  allowDestructive: DestructiveAction[];
  /** AUT-9: path to a CSV or JSON dataset, relative to the test file: one run per row. */
  dataset?: string;
  setup: Hook[];
  teardown: Hook[];
  environments: Record<string, EnvironmentOverride>;
  /** Unknown keys, kept so printing does not lose them (each is a warning). */
  extra: Record<string, unknown>;
}

// ── Exact steps (AUT-3) ────────────────────────────────────────────────────────

export type Locator =
  | { by: "role"; role: string; name?: string }
  | { by: "label" | "testid" | "text" | "placeholder" | "css"; value: string };

export type ExactOp<V = Template> =
  | { op: "goto"; url: V }
  | { op: "click"; target: Locator }
  | { op: "fill"; target: Locator; value: V }
  | { op: "select"; option: V; target: Locator }
  | { op: "press"; key: string }
  | { op: "expectUrl"; match: "contains" | "is"; value: V }
  | { op: "expectText"; target: Locator; match: "text" | "contains"; value: V }
  | {
      op: "expectState";
      target: Locator;
      state: "visible" | "hidden" | "enabled" | "disabled";
    }
  | { op: "expectCount"; target: Locator; count: number };

export interface ExactCode {
  lang: "ts";
  /** Verbatim, without the fence and its indentation. Executed later (LOOP), never here. */
  code: string;
}

// ── Body ───────────────────────────────────────────────────────────────────────

interface StepBase {
  type: "step";
  /** Display number as written; `null` for an unnumbered guard. */
  number: number | null;
  at?: SourceInfo;
}

/** A plain-English step: action, `Expect:`, `Soft:` or `Never:`. `text` is verbatim after the prefix. */
export interface TextStep extends StepBase {
  kind: "action" | "expect" | "soft" | "guard";
  text: Template;
}

/** `Use: <path> { params }` */
export interface FlowStep extends StepBase {
  kind: "flow";
  path: string;
  params: Record<string, Template>;
  at?: SourceInfo & { path?: Range; params?: Range };
}

/** `Exact: <op>` or a fenced ```ts block. `label` is the text before the fence, if any. */
export interface ExactStep extends StepBase {
  kind: "exact";
  exact: { form: "op"; op: ExactOp } | ({ form: "code"; label?: string } & ExactCode);
}

export type Step = TextStep | FlowStep | ExactStep;

/** Everything in the body, in order, so printing keeps blank lines, comments and stray text. */
export type BodyItem =
  | Step
  | { type: "blank" }
  | { type: "comment"; text: string; at?: SourceInfo }
  | { type: "text"; text: string; at?: SourceInfo };

export interface TestSpec {
  /** Project-relative, `/`-separated path, e.g. `tests/checkout.test.md`. */
  path: string;
  frontmatter: Frontmatter;
  body: BodyItem[];
  /** Source positions of frontmatter fields, keyed by path such as `setup[0].request`. */
  fields?: Record<string, Range>;
}

/** Step kinds map 1:1 to the contract's StepKind. */
export type SpecStepKind = Step["kind"] & StepKind;

/** The steps of a spec, in file order (guards included). */
export function specSteps(spec: TestSpec): Step[] {
  return spec.body.filter((item): item is Step => item.type === "step");
}
