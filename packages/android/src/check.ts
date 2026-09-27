import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { CheckEvaluation, CheckStatus } from "@testament/browser";
import {
  bindCheck,
  type Locator as CheckLocator,
  type CheckOp,
  describeLocator,
} from "@testament/recording";
import type { Screen, ScreenNode } from "./hierarchy.js";
import { matchAll } from "./locators.js";
import type { RequestSummary } from "./types.js";

// The check evaluator for Android (LOOP-2's `session.check`, VER-1/VER-2): one
// typed CheckOp against the live screen, an empty screen or a saved copy, with
// auto-waiting (retry until it passes or time is up). Deterministic, no model,
// read-only. Results are the web harness's `CheckEvaluation`.

export type { CheckEvaluation, CheckStatus };

const marks = new WeakMap<AndroidRequestMark, number>();

/** A position in the session's request log, where a step began. Opaque. */
export class AndroidRequestMark {
  readonly takenAt: string;
  private constructor() {
    this.takenAt = new Date().toISOString();
  }
  /** @internal */
  static create(position: number): AndroidRequestMark {
    const mark = new AndroidRequestMark();
    marks.set(mark, position);
    return mark;
  }
}

const copies = new WeakMap<ScreenCopy, { screen: Screen; requestMark: number }>();

/** A frozen copy of a screen (its hierarchy), for the sanity test (VER-6). Opaque. */
export class ScreenCopy {
  readonly url: string;
  readonly takenAt: string;
  private constructor(url: string) {
    this.url = url;
    this.takenAt = new Date().toISOString();
  }
  /** @internal */
  static create(screen: Screen, requestMark: number, url: string): ScreenCopy {
    const copy = new ScreenCopy(url);
    copies.set(copy, { screen, requestMark });
    return copy;
  }
}

export type AndroidCheckTarget = "page" | "blank" | ScreenCopy;

export interface AndroidCheckOptions {
  /** Keep retrying until this long has passed (default 5000 ms). 0 = one attempt. */
  timeoutMs?: number;
  values?: Readonly<Record<string, string>>;
  /** "page" (default) is the live screen. */
  on?: AndroidCheckTarget;
  /** `network` checks: only requests since this mark (or copy) count. */
  since?: AndroidRequestMark | ScreenCopy;
}

export interface CheckContext {
  /** A fresh screen, or null when the driver is gone. */
  screen(): Promise<Screen | null>;
  redact(text: string): string;
  mark(): number;
  requestsSince(mark: number): RequestSummary[];
  blank(): Screen;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_MS = 100;
const MAX_ACTUAL = 300;

const collapse = (text: string) => text.replace(/[\s\u00a0]+/g, " ").trim();
const clip = (text: string) => (text.length > MAX_ACTUAL ? `${text.slice(0, MAX_ACTUAL)}…` : text);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

function textMatches(
  text: string,
  match: "equals" | "contains" | "matches",
  value: string,
): boolean {
  if (match === "matches") {
    try {
      return new RegExp(value).test(text);
    } catch {
      return false;
    }
  }
  const want = collapse(value);
  return match === "equals" ? collapse(text) === want : collapse(text).includes(want);
}

/** The visible text of a node and its descendants (a field: its value). */
export function innerText(screen: Screen, entry: ScreenNode): string {
  if (entry.role === "textbox") return entry.text ?? "";
  const lines: string[] = [];
  const walk = (node: ScreenNode) => {
    if (!node.visible && !screen.hasScrollableAncestor(node)) return;
    const own =
      node.role === "textbox"
        ? node.text
        : (node.node.text ?? (node.children.length ? undefined : node.node.desc));
    if (own && collapse(own)) lines.push(collapse(own));
    for (const child of node.children) {
      const next = screen.nodes[child];
      if (next) walk(next);
    }
  };
  walk(entry);
  return lines.join("\n");
}

function within(screen: Screen, entry: ScreenNode, scope: ScreenNode): boolean {
  for (let at = entry.parent; at >= 0; at = screen.nodes[at]?.parent ?? -1) {
    if (at === scope.index) return true;
  }
  return false;
}

function targets(
  screen: Screen,
  target: CheckLocator,
  scope: CheckLocator | undefined,
): ScreenNode[] {
  const all = matchAll(screen, target as never);
  const picked = target.nth !== undefined ? all.slice(target.nth, target.nth + 1) : all;
  if (!scope) return picked;
  const scopes = matchAll(screen, scope as never);
  return picked.filter((entry) => scopes.some((s) => within(screen, entry, s)));
}

const notFound = (op: { target: CheckLocator; scope?: CheckLocator | undefined }) =>
  `nothing matches ${describeLocator(op.target)}${op.scope ? ` in ${describeLocator(op.scope).replace(/^an? /, "the ")}` : ""}`;

/** `android-app://com.example/.Main` against "is": the URL, `com.example/.Main`, or `.Main` / `Main`. */
function urlMatches(url: string, match: "is" | "contains" | "matches", value: string): boolean {
  if (match === "contains") return url.includes(value);
  if (match === "matches") {
    try {
      return new RegExp(value).test(url);
    } catch {
      return false;
    }
  }
  if (url === value) return true;
  const activity = url.replace(/^android-app:\/\//, "");
  if (activity === value) return true;
  const cls = activity.slice(activity.indexOf("/") + 1);
  return cls === value || cls === `.${value}` || cls.endsWith(`.${value.replace(/^\./, "")}`);
}

function requestMatches(
  request: RequestSummary,
  op: Extract<CheckOp, { type: "network" }>,
): boolean {
  if (request.method.toUpperCase() !== op.method.toUpperCase()) return false;
  if (op.status !== undefined && request.status !== op.status) return false;
  if (op.url.startsWith("/")) {
    try {
      const path = new URL(request.url).pathname;
      const source = op.url
        .split("*")
        .map((part) =>
          part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]\w*/g, "[^/]+"),
        )
        .join(".*");
      return new RegExp(`^${source}$`).test(path);
    } catch {
      return false;
    }
  }
  return request.url.includes(op.url);
}

function stateOf(entry: ScreenNode, state: string, text: string): boolean {
  const flags = entry.node.flags;
  switch (state) {
    case "visible":
      return entry.visible;
    case "hidden":
      return !entry.visible;
    case "enabled":
      return flags.includes("enabled");
    case "disabled":
      return !flags.includes("enabled");
    case "checked":
      return flags.includes("checkable") && flags.includes("checked");
    case "unchecked":
      return flags.includes("checkable") && !flags.includes("checked");
    case "editable":
      return flags.includes("editable") && flags.includes("enabled");
    case "focused":
      return flags.includes("focused");
    case "empty":
      return text === "";
    default:
      return false;
  }
}

function expectedOf(op: CheckOp): string | null {
  switch (op.type) {
    case "text":
    case "value":
      return op.match === "matches" ? `/${op.value}/` : op.value;
    case "url":
      return op.value;
    case "element_state":
      return op.state;
    case "count":
      if (op.n !== undefined) return String(op.n);
      if (op.min !== undefined && op.max !== undefined) return `${op.min} to ${op.max}`;
      if (op.min !== undefined) return `at least ${op.min}`;
      if (op.max !== undefined) return `at most ${op.max}`;
      return "any";
    case "network":
      return `${op.method.toUpperCase()} ${op.url}${op.status !== undefined ? ` ${op.status}` : ""}`;
    case "aria_snapshot":
      return op.snapshot;
    default:
      return null;
  }
}

interface Attempt {
  passed: boolean;
  actual: string | null;
  matched?: number;
  seen: unknown;
}

function closest(texts: readonly string[], expected: string): string | null {
  const lines = texts
    .flatMap((t) => t.split(/\n+/))
    .map(collapse)
    .filter(Boolean);
  if (lines.length === 0) return null;
  const want = collapse(expected).toLowerCase();
  const score = (line: string) => {
    const l = line.toLowerCase();
    if (l.includes(want) || want.includes(l)) return 0;
    const words = new Set(want.split(" "));
    return 1 - l.split(" ").filter((w) => words.has(w)).length / Math.max(words.size, 1);
  };
  return [...lines].sort((a, b) => score(a) - score(b))[0] ?? null;
}

function attempt(op: CheckOp, screen: Screen, requests: () => RequestSummary[]): Attempt {
  switch (op.type) {
    case "text": {
      const found = targets(screen, op.target, op.scope);
      const texts = found.map((entry) => innerText(screen, entry));
      const hit = texts.find((text) => textMatches(text, op.match, op.value));
      if (hit !== undefined)
        return { passed: true, actual: collapse(hit), matched: found.length, seen: texts };
      const actual =
        found.length === 0
          ? `(${notFound(op)})`
          : op.match === "equals" && texts.length === 1
            ? collapse(texts[0] as string)
            : (closest(texts, op.value) ?? "(no visible text)");
      return { passed: false, actual, matched: found.length, seen: texts.map(collapse) };
    }
    case "url":
      return {
        passed: urlMatches(screen.url, op.match, op.value),
        actual: screen.url,
        seen: screen.url,
      };
    case "element_state": {
      const found = targets(screen, op.target, op.scope);
      if (found.length === 0) {
        return {
          passed: op.state === "hidden",
          actual: op.state === "hidden" ? "not on the screen" : `(${notFound(op)})`,
          matched: 0,
          seen: [],
        };
      }
      const states = found.map((entry) => stateOf(entry, op.state, innerText(screen, entry)));
      const passed = op.state === "hidden" ? states.every(Boolean) : states.some(Boolean);
      const visible = found[0]?.visible ?? false;
      const actual = passed
        ? op.state
        : op.state === "visible" || op.state === "hidden"
          ? visible
            ? "visible"
            : "hidden"
          : `not ${op.state}`;
      return { passed, actual, matched: found.length, seen: states };
    }
    case "count": {
      const count = targets(screen, op.target, op.scope).length;
      const passed =
        (op.n === undefined || count === op.n) &&
        (op.min === undefined || count >= op.min) &&
        (op.max === undefined || count <= op.max);
      return { passed, actual: String(count), matched: count, seen: count };
    }
    case "value": {
      const found = targets(screen, op.target, op.scope);
      if (found.length === 0)
        return { passed: false, actual: `(${notFound(op)})`, matched: 0, seen: [] };
      const values = found.map((entry) =>
        entry.role === "textbox" ? (entry.text ?? "") : innerText(screen, entry),
      );
      const hit = values.find((value) => textMatches(value, op.match, op.value));
      return {
        passed: hit !== undefined,
        actual: hit ?? (values.length === 1 ? (values[0] as string) : values.join(" | ")),
        matched: found.length,
        seen: values,
      };
    }
    case "network": {
      const list = requests();
      const hit = list.find((request) => requestMatches(request, op));
      const shown = list.slice(-5).map((r) => {
        let path = r.url;
        try {
          path = new URL(r.url).pathname;
        } catch {
          // keep the URL
        }
        return `${r.method} ${path} ${r.status}`;
      });
      return {
        passed: hit !== undefined,
        actual: hit
          ? `${hit.method} ${hit.url} ${hit.status}`
          : shown.join("; ") || "(no requests)",
        seen: list.map((r) => [r.method, r.url, r.status]),
      };
    }
    default:
      return { passed: false, actual: null, seen: null };
  }
}

/** Evaluates one check. Never throws. */
export async function evaluateCheck(
  input: CheckOp,
  options: AndroidCheckOptions,
  ctx: CheckContext,
): Promise<CheckEvaluation> {
  const started = Date.now();
  const result = (status: CheckStatus, fields: Partial<CheckEvaluation> = {}): CheckEvaluation => ({
    status,
    passed: status === "passed",
    expected: null,
    actual: null,
    ms: Date.now() - started,
    attempts: 0,
    seen: hash(null),
    ...fields,
  });
  if (input.type === "code" || input.type === "soft_judgment" || input.type === "pending") {
    const message =
      input.type === "code"
        ? "Code checks run from generated test code, not in the harness."
        : input.type === "soft_judgment"
          ? "Soft judgments need a model; the engine evaluates them, not the harness."
          : "The expectation has no compiled check.";
    return result("unsupported", { message });
  }
  if (input.type === "aria_snapshot") {
    return result("unsupported", {
      message: "Accessibility snapshots are a web check; Android has none yet.",
    });
  }
  const bound = bindCheck(input, options.values ?? {});
  if (!bound.ok)
    return result(bound.reason === "secret" ? "refused" : "error", { message: bound.message });
  const op = bound.op;
  const expected = expectedOf(op);
  if (expected !== null && ctx.redact(expected) !== expected) {
    return result("refused", { message: "A check value may not contain a secret." });
  }

  const on = options.on ?? "page";
  let frozen: Screen | null = null;
  let requests: () => RequestSummary[] = () => [];
  if (on === "blank") frozen = ctx.blank();
  else if (on instanceof ScreenCopy) {
    const copy = copies.get(on);
    if (!copy) return result("error", { expected, message: "Unknown screen copy." });
    frozen = copy.screen;
  } else {
    const since =
      options.since instanceof AndroidRequestMark
        ? marks.get(options.since)
        : options.since
          ? copies.get(options.since)?.requestMark
          : undefined;
    const mark = since ?? ctx.mark();
    requests = () => ctx.requestsSince(mark);
  }

  const timeoutMs = frozen ? 0 : (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = started + timeoutMs;
  let attempts = 0;
  let last: Attempt = { passed: false, actual: null, seen: null };
  for (;;) {
    attempts++;
    const screen = frozen ?? (await ctx.screen());
    if (!screen)
      return result("error", { expected, attempts, message: "The device or its driver is gone." });
    last = attempt(op, screen, requests);
    if (last.passed || Date.now() + RETRY_MS > deadline) break;
    await sleep(RETRY_MS);
  }
  return {
    status: last.passed ? "passed" : "failed",
    passed: last.passed,
    expected,
    actual: last.actual === null ? null : clip(ctx.redact(last.actual)),
    ms: Date.now() - started,
    attempts,
    ...(last.matched !== undefined ? { matched: last.matched } : {}),
    seen: hash([op.type, last.seen]),
  };
}
