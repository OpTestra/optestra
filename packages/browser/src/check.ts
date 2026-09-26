import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  bindCheck,
  type CheckOp,
  type Locator as CheckLocator,
  describeLocator,
} from "@testament/recording";
import type { Browser, FrameLocator, Locator, Page } from "playwright";
import type { RequestSummary } from "./types.js";

// The check evaluator (LOOP-2, VER-1/VER-2): runs one typed CheckOp against the
// live page, an empty page or a saved copy, with Playwright's auto-waiting
// semantics (retry until it passes or the time is up). Deterministic code, no
// model. Read-only: nothing here clicks, types or navigates the page under test.

/** Where a check runs: the session's page, an empty page, or a copy from `pageCopy()`. */
export type CheckTarget = "page" | "blank" | PageCopy;

export interface CheckOptions {
  /** Keep retrying until this long has passed (default 5000 ms). 0 = one attempt. */
  timeoutMs?: number;
  /** Values for the op's `{{refs}}`. Secrets are never check values: refused. */
  values?: Readonly<Record<string, string>>;
  /** Default "page". */
  on?: CheckTarget;
  /**
   * `network` checks: the copy taken as the current action step began. Only
   * requests sent since then count (plus those seen while waiting). Without it,
   * only requests seen while waiting count.
   */
  since?: PageCopy;
}

/**
 * passed/failed: the check ran. refused: it references a secret, or its value
 * contains one. unsupported: the op can't run in the harness (`code`,
 * `soft_judgment`, `pending`). error: the page is gone or the op is invalid.
 */
export type CheckStatus = "passed" | "failed" | "refused" | "unsupported" | "error";

export interface CheckEvaluation {
  status: CheckStatus;
  passed: boolean;
  /** What the check wanted, in words ("$0.00 due today", "5", "visible"). */
  expected: string | null;
  /** What was actually seen at the final attempt (scrubbed). */
  actual: string | null;
  ms: number;
  attempts: number;
  /** Elements the target matched at the final attempt (ops with a target). */
  matched?: number;
  /** Hash of everything the check looked at: equal hashes mean the same subject (VER-6). */
  seen: string;
  message?: string;
}

// ── Page copies (for the sanity test) ────────────────────────────────────────

const copies = new WeakMap<PageCopy, { html: string; requestMark: number }>();

/**
 * A static copy of a page (DOM with live field state, styles inlined, no
 * scripts, no frames' content). Opaque: its HTML can't be read, only checked.
 */
export class PageCopy {
  readonly url: string;
  readonly takenAt: string;
  private constructor(url: string) {
    this.url = url;
    this.takenAt = new Date().toISOString();
  }
  /** @internal */
  static create(url: string, html: string, requestMark: number): PageCopy {
    const copy = new PageCopy(url);
    copies.set(copy, { html, requestMark });
    return copy;
  }
}

interface RawCopy {
  html: string;
  css: string;
}

/** Runs in the page: clones the DOM, fixes live state into attributes, drops active content. */
function snapshotDom(secretAttribute: string): RawCopy {
  const root = document.documentElement;
  const clone = root.cloneNode(true) as HTMLElement;
  const selector = "input, textarea, select, option, dialog, details";
  const live = Array.from(root.querySelectorAll(selector));
  const copied = Array.from(clone.querySelectorAll(selector));
  live.forEach((from, index) => {
    const to = copied[index];
    if (!to) return;
    if (from.hasAttribute(secretAttribute)) {
      to.removeAttribute("value");
      return;
    }
    if (from instanceof HTMLInputElement) {
      if (from.type === "checkbox" || from.type === "radio") {
        if (from.checked) to.setAttribute("checked", "");
        else to.removeAttribute("checked");
      } else if (from.type === "password" || from.type === "file" || from.type === "hidden") {
        to.removeAttribute("value");
      } else {
        to.setAttribute("value", from.value);
      }
    } else if (from instanceof HTMLTextAreaElement) {
      to.textContent = from.value;
    } else if (from instanceof HTMLOptionElement) {
      if (from.selected) to.setAttribute("selected", "");
      else to.removeAttribute("selected");
    } else if (from instanceof HTMLDialogElement || from instanceof HTMLDetailsElement) {
      if (from.open) to.setAttribute("open", "");
      else to.removeAttribute("open");
    }
  });
  for (const node of Array.from(
    clone.querySelectorAll("script, noscript, link, base, meta, style, template"),
  )) {
    node.remove();
  }
  for (const node of Array.from(clone.querySelectorAll("iframe, frame, object, embed"))) {
    for (const name of ["src", "srcdoc", "data"]) node.removeAttribute(name);
  }
  for (const node of Array.from(clone.querySelectorAll("*"))) {
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name.startsWith("on")) node.removeAttribute(attribute.name);
    }
  }
  let css = "";
  const sheets = [...Array.from(document.styleSheets), ...(document.adoptedStyleSheets ?? [])];
  for (const sheet of sheets) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += `${rule.cssText}\n`;
    } catch {
      // A cross-origin sheet can't be read; its rules are lost in the copy.
    }
  }
  return { html: clone.outerHTML, css };
}

const COPY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'";

/** Copies the page as it is now. Secret fields and password values are never copied. */
export async function copyPage(
  page: Page,
  options: { redact: (text: string) => string; secretAttribute: string; requestMark: number },
): Promise<PageCopy> {
  const url = options.redact(page.isClosed() ? "" : page.url());
  let raw: RawCopy;
  try {
    raw = await page.evaluate(snapshotDom, options.secretAttribute);
  } catch {
    raw = { html: "<html><head></head><body></body></html>", css: "" };
  }
  const head = `<meta http-equiv="Content-Security-Policy" content="${COPY_POLICY}"><style>${raw.css.replace(/<\/style/gi, "<\\/style")}</style>`;
  const html = `<!doctype html>${raw.html.replace(/<head([^>]*)>/i, `<head$1>${head}`)}`;
  return PageCopy.create(url, options.redact(html), options.requestMark);
}

// ── The sandbox page ─────────────────────────────────────────────────────────

const sandboxes = new WeakMap<Page, Promise<Page>>();

/** A page in its own offline, script-free context; closed with the session's page. */
function sandboxFor(page: Page, browser: Browser): Promise<Page> {
  let sandbox = sandboxes.get(page);
  if (!sandbox) {
    sandbox = (async () => {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        offline: true,
        serviceWorkers: "block",
        acceptDownloads: false,
        ...(page.viewportSize() ? { viewport: page.viewportSize() } : {}),
      });
      await context.route("**/*", (route) => route.abort().catch(() => {}));
      page.once("close", () => {
        context.close().catch(() => {});
      });
      return context.newPage();
    })();
    sandboxes.set(page, sandbox);
  }
  return sandbox;
}

// ── Locators (as in locators.ts, plus heading levels and scopes) ─────────────

type Root = Page | FrameLocator | Locator;
type AriaRole = Parameters<Page["getByRole"]>[0];

function inRoot(root: Root, spec: CheckLocator): Locator {
  const exact = "exact" in spec ? (spec.exact ?? true) : true;
  let locator: Locator;
  switch (spec.kind) {
    case "role":
      locator = root.getByRole(spec.role as AriaRole, {
        ...(spec.name !== undefined ? { name: spec.name, exact } : {}),
        ...(spec.level !== undefined ? { level: spec.level } : {}),
      });
      break;
    case "label":
      locator = root.getByLabel(spec.text, { exact });
      break;
    case "placeholder":
      locator = root.getByPlaceholder(spec.text, { exact });
      break;
    case "alt":
      locator = root.getByAltText(spec.text, { exact });
      break;
    case "title":
      locator = root.getByTitle(spec.text, { exact });
      break;
    case "testId":
      locator = root.getByTestId(spec.value);
      break;
    case "text":
      locator = root.getByText(spec.text, { exact });
      break;
    case "css":
      locator = root.locator(spec.selector);
      break;
  }
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}

function framed(page: Page, spec: CheckLocator): Root {
  let root: Root = page;
  for (const frame of spec.frame ?? []) root = inRoot(root, frame as CheckLocator).contentFrame();
  return root;
}

/** The target, inside its scope when there is one (the scope carries the frame path). */
export function resolveCheckLocator(
  page: Page,
  target: CheckLocator,
  scope?: CheckLocator,
): Locator {
  if (scope) return inRoot(inRoot(framed(page, scope), scope), target);
  return inRoot(framed(page, target), target);
}

// ── Evaluation ───────────────────────────────────────────────────────────────

interface Attempt {
  passed: boolean;
  actual: string | null;
  matched?: number;
  seen: unknown;
}

interface EvalEnv {
  page: Page;
  url: string;
  requests: () => RequestSummary[];
}

export interface EvaluateContext {
  page: Page;
  browser: Browser;
  redact: (text: string) => string;
  /** Requests seen since `mark` (the session's tracker). */
  mark: () => number;
  requestsSince: (mark: number) => RequestSummary[];
  unusable: () => boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_MS = 100;
const MAX_ACTUAL = 300;
const CALL_TIMEOUT_MS = 1_000;

const collapse = (text: string) => text.replace(/[\s ]+/g, " ").trim();
const clip = (text: string) => (text.length > MAX_ACTUAL ? `${text.slice(0, MAX_ACTUAL)}…` : text);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The line of `texts` closest to `expected`: what a person would call "what it said instead". */
export function closestText(texts: readonly string[], expected: string): string | null {
  const want = collapse(expected);
  const lines = texts
    .flatMap((text) => text.split(/\n+/))
    .map(collapse)
    .filter((line) => line !== "");
  if (lines.length === 0) return null;
  const limit = want.length * 4 + 20;
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.length > limit) continue;
    const score = levenshtein(line, want) / Math.max(line.length, want.length, 1);
    if (score < bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return best ?? (lines[0] as string);
}

function textMatches(text: string, match: "equals" | "contains" | "matches", value: string) {
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

/**
 * What a text check reads from each matched element: a form field's value
 * (like Playwright's `toHaveValue`; a select's option value), else its innerText.
 */
async function textsOf(locator: Locator, count: number): Promise<string[]> {
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    const element = locator.nth(i);
    // inputValue throws at once for anything that isn't an input, textarea or select.
    texts.push(
      await element
        .inputValue({ timeout: CALL_TIMEOUT_MS })
        .catch(() => element.innerText({ timeout: CALL_TIMEOUT_MS })),
    );
  }
  return texts;
}

const notFound = (op: { target: CheckLocator; scope?: CheckLocator | undefined }) =>
  `nothing matches ${describeLocator(op.target)}${op.scope ? ` in ${describeLocator(op.scope).replace(/^an? /, "the ")}` : ""}`;

async function fieldValue(element: Locator): Promise<string> {
  const selected = await element.locator("option:checked").allInnerTexts();
  if (selected.length > 0) return selected.map(collapse).join(", ");
  try {
    return await element.inputValue({ timeout: CALL_TIMEOUT_MS });
  } catch {
    return collapse(await element.innerText({ timeout: CALL_TIMEOUT_MS }));
  }
}

async function stateOf(element: Locator, state: string): Promise<boolean> {
  switch (state) {
    case "visible":
      return element.isVisible();
    case "hidden":
      return element.isHidden();
    case "enabled":
      return element.isEnabled({ timeout: CALL_TIMEOUT_MS });
    case "disabled":
      return element.isDisabled({ timeout: CALL_TIMEOUT_MS });
    case "checked":
      return element.isChecked({ timeout: CALL_TIMEOUT_MS }).catch(() => false);
    case "unchecked":
      return element
        .isChecked({ timeout: CALL_TIMEOUT_MS })
        .then((checked) => !checked)
        .catch(() => false);
    case "editable":
      return element.isEditable({ timeout: CALL_TIMEOUT_MS }).catch(() => false);
    case "focused":
      return (await element.and(element.page().locator(":focus")).count()) > 0;
    case "empty":
      return (await fieldValue(element).catch(() => "x")) === "";
    default:
      return false;
  }
}

function urlMatches(url: string, match: "is" | "contains" | "matches", value: string): boolean {
  if (match === "contains") return url.includes(value);
  if (match === "matches") {
    try {
      return new RegExp(value).test(url);
    } catch {
      return false;
    }
  }
  const strip = (text: string) => (text.length > 1 ? text.replace(/\/$/, "") : text);
  if (value.startsWith("/")) {
    try {
      const parsed = new URL(url);
      return (
        strip(parsed.pathname) === strip(value) ||
        strip(`${parsed.pathname}${parsed.search}`) === strip(value)
      );
    } catch {
      return false;
    }
  }
  return strip(url) === strip(value);
}

function pathPattern(pattern: string): RegExp {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}

function requestMatches(
  request: RequestSummary,
  op: Extract<CheckOp, { type: "network" }>,
): boolean {
  if (request.method.toUpperCase() !== op.method.toUpperCase()) return false;
  if (op.status !== undefined && request.status !== op.status) return false;
  if (op.url.startsWith("/")) {
    try {
      return pathPattern(op.url).test(new URL(request.url).pathname);
    } catch {
      return false;
    }
  }
  return request.url.includes(op.url);
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

async function attempt(op: CheckOp, env: EvalEnv): Promise<Attempt> {
  switch (op.type) {
    case "text": {
      const locator = resolveCheckLocator(env.page, op.target, op.scope);
      const count = await locator.count();
      const texts = (await textsOf(locator, count)).map((t) => t.replace(/ /g, " "));
      const hit = texts.find((text) => textMatches(text, op.match, op.value));
      if (hit !== undefined) {
        const shown =
          op.match === "equals" ? collapse(hit) : (closestText([hit], op.value) ?? collapse(hit));
        return { passed: true, actual: shown, matched: count, seen: texts.map(collapse) };
      }
      const actual =
        count === 0
          ? `(${notFound(op)})`
          : op.match === "equals" && texts.length === 1
            ? collapse(texts[0] as string)
            : closestText(texts, op.value) || "(no visible text)";
      return { passed: false, actual, matched: count, seen: texts.map(collapse) };
    }
    case "url":
      return { passed: urlMatches(env.url, op.match, op.value), actual: env.url, seen: env.url };
    case "element_state": {
      const locator = resolveCheckLocator(env.page, op.target, op.scope);
      const count = await locator.count();
      if (count === 0) {
        return {
          passed: op.state === "hidden",
          actual: op.state === "hidden" ? "not on the page" : `(${notFound(op)})`,
          matched: 0,
          seen: [],
        };
      }
      const states: boolean[] = [];
      for (let i = 0; i < count; i++) states.push(await stateOf(locator.nth(i), op.state));
      const passed = op.state === "hidden" ? states.every(Boolean) : states.some(Boolean);
      const visible = await locator
        .first()
        .isVisible()
        .catch(() => false);
      const actual = passed
        ? op.state
        : op.state === "visible" || op.state === "hidden"
          ? visible
            ? "visible"
            : "hidden"
          : `not ${op.state}`;
      return { passed, actual, matched: count, seen: states };
    }
    case "count": {
      const locator = resolveCheckLocator(env.page, op.target, op.scope);
      const count = await locator.count();
      const passed =
        (op.n === undefined || count === op.n) &&
        (op.min === undefined || count >= op.min) &&
        (op.max === undefined || count <= op.max);
      return { passed, actual: String(count), matched: count, seen: count };
    }
    case "value": {
      const locator = resolveCheckLocator(env.page, op.target, op.scope);
      const count = await locator.count();
      if (count === 0) return { passed: false, actual: `(${notFound(op)})`, matched: 0, seen: [] };
      const values: string[] = [];
      for (let i = 0; i < count; i++) values.push(await fieldValue(locator.nth(i)));
      const hit = values.find((value) => textMatches(value, op.match, op.value));
      return {
        passed: hit !== undefined,
        actual: hit ?? (values.length === 1 ? (values[0] as string) : values.join(" | ")),
        matched: count,
        seen: values,
      };
    }
    case "network": {
      const requests = env.requests();
      const hit = requests.find((request) => requestMatches(request, op));
      const shown = requests
        .filter(
          (r) =>
            r.resourceType === "fetch" || r.resourceType === "xhr" || r.resourceType === "document",
        )
        .slice(-5)
        .map((r) => {
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
        seen: requests.map((r) => [r.method, r.url, r.status]),
      };
    }
    case "aria_snapshot": {
      const locator = resolveCheckLocator(env.page, op.target, op.scope);
      const count = await locator.count();
      if (count === 0) return { passed: false, actual: `(${notFound(op)})`, matched: 0, seen: "" };
      const snapshot = await locator.first().ariaSnapshot({ timeout: CALL_TIMEOUT_MS });
      const have = snapshot.split("\n").map((l) => l.trim());
      let at = 0;
      const passed = op.snapshot
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .every((line) => {
          const found = have.indexOf(line, at);
          if (found < 0) return false;
          at = found + 1;
          return true;
        });
      return { passed, actual: snapshot, matched: count, seen: snapshot };
    }
    default:
      return { passed: false, actual: null, seen: null };
  }
}

/** Evaluates one check. Never throws. */
export async function evaluateCheck(
  input: CheckOp,
  options: CheckOptions,
  ctx: EvaluateContext,
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
        ? "Code checks run from the generated Playwright spec, not in the harness."
        : input.type === "soft_judgment"
          ? "Soft judgments need a model; the engine evaluates them, not the harness."
          : "The expectation has no compiled check.";
    return result("unsupported", { message });
  }
  const bound = bindCheck(input, options.values ?? {});
  if (!bound.ok)
    return result(bound.reason === "secret" ? "refused" : "error", { message: bound.message });
  const op = bound.op;
  const expected = expectedOf(op);
  // A literal value that is (or contains) a secret of this session is refused too.
  if (expected !== null && ctx.redact(expected) !== expected) {
    return result("refused", { message: "A check value may not contain a secret." });
  }

  const on = options.on ?? "page";
  let env: EvalEnv;
  if (on === "page") {
    if (ctx.unusable())
      return result("error", { expected, message: "The page is closed or crashed." });
    const since = options.since ? copies.get(options.since)?.requestMark : undefined;
    const mark = since ?? ctx.mark();
    env = { page: ctx.page, url: "", requests: () => ctx.requestsSince(mark) };
  } else {
    let sandbox: Page;
    try {
      sandbox = await sandboxFor(ctx.page, ctx.browser);
      if (on === "blank") await sandbox.goto("about:blank");
      else {
        const copy = copies.get(on);
        if (!copy) return result("error", { expected, message: "Unknown page copy." });
        await sandbox.setContent(copy.html, { waitUntil: "domcontentloaded" });
      }
    } catch (error) {
      return result("error", {
        expected,
        message: `Could not open the sandbox page: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      });
    }
    env = { page: sandbox, url: on === "blank" ? "about:blank" : on.url, requests: () => [] };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = started + timeoutMs;
  let attempts = 0;
  let last: Attempt = { passed: false, actual: null, seen: null };
  let error: string | undefined;
  for (;;) {
    attempts++;
    if (on === "page") env.url = ctx.redact(ctx.page.isClosed() ? "" : ctx.page.url());
    try {
      last = await attempt(op, env);
      error = undefined;
    } catch (caught) {
      error = caught instanceof Error ? (caught.message.split("\n")[0] ?? "") : String(caught);
      last = { passed: false, actual: null, seen: null };
      if (on === "page" && ctx.unusable()) break;
    }
    if (last.passed || Date.now() + RETRY_MS > deadline) break;
    await sleep(RETRY_MS);
  }
  if (error !== undefined && !last.passed) {
    return result("error", { expected, attempts, message: ctx.redact(error) });
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
