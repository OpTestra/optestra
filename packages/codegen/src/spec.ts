import { brand } from "@testament/brand";
import type { Command, Locator } from "@testament/recording";
import {
  type BoundText,
  type ExactOp,
  type ExpandedStep,
  type ExpandedTest,
  type FlowStep,
  type Locator as SpecLocator,
  type OriginFrame,
  parseTemplate,
  specSteps,
  type TestSpec,
} from "@testament/spec";
import { type Header, withHeader } from "./header.js";
import { holdsValue, locatorExpr } from "./locators.js";
import {
  arr,
  arrow,
  awaited,
  blank,
  call,
  comment,
  constStmt,
  type Expr,
  formatNumber,
  id,
  member,
  method,
  newExpr,
  num,
  obj,
  printModule,
  raw,
  type Stmt,
  stmt,
  str,
} from "./print/js.js";
import type { AnyCheckOp, CodegenCheck, CodegenRecording } from "./recording.js";
import {
  camel,
  createScope,
  isTextValue,
  type Needs,
  type Part,
  recordingParts,
  resolveValue,
  type Scope,
  StepLocals,
  templateParts,
  uniqueName,
  type Value,
} from "./values.js";

// One recording + its test → one plain `@playwright/test` spec (EXP-1): a
// `test.step` per English step with the line as a comment, role/label locators,
// web-first assertions, learned waits instead of sleeps, flows as named step
// groups. Healing data (fallbacks, fingerprints) stays in the recording.

export interface SpecSource {
  /** The expanded test (flows inlined), from `expandTest` / `loadTest`. */
  expanded: ExpandedTest;
  /** The parsed test and flow files, by project-relative path. */
  specs: Readonly<Record<string, TestSpec>>;
  /**
   * The test's `auth: <profile>` login (SEC-3): the profile's flow, run on its
   * own, and its recording. The spec logs in with it before the start page.
   * Absent for a profile whose flow isn't recorded (the spec then skips).
   */
  profile?: {
    name: string;
    /** Project-relative path of the flow file. */
    path: string;
    expanded: ExpandedTest;
    recording: CodegenRecording;
    /** The profile's params, as templates (they replace the flow's defaults). */
    params: Readonly<Record<string, string>>;
  };
}

export interface GeneratedFile {
  /** File name inside `<tests dir>/<data dir>/`. */
  name: string;
  content: string;
}

/** Name of the shared helpers module (without extension): `<cli name>.fixtures`. */
export const FIXTURES_MODULE = `${brand.cliName}.fixtures`;
export const specFileName = (testId: string) => `${testId}.spec.ts`;
export const recordingFileName = (testId: string) => `${testId}.steps.json`;

const PASCAL = camel([brand.cliName]).replace(/^./, (c) => c.toUpperCase());
/** The helper that notes a check only the test runner evaluates. */
export const CHECKED_ELSEWHERE = `checkedBy${PASCAL}`;

type FixtureName = "page" | "values" | "secrets" | "network" | "inbox";
const FIXTURE_ORDER: FixtureName[] = ["page", "values", "secrets", "network", "inbox"];
const RESERVED = [
  "test",
  "expect",
  "page",
  "values",
  "secrets",
  "network",
  "inbox",
  "data",
  "allowed",
  "route",
  "containing",
  "expectCount",
  "upload",
  CHECKED_ELSEWHERE,
];

/** Roles of elements that come and go (toasts) or can't be targeted: never waited for. */
const NO_WAIT_ROLES = new Set([
  "alert",
  "status",
  "tooltip",
  "log",
  "marquee",
  "timer",
  "generic",
  "text",
  "none",
  "presentation",
  "paragraph",
  // A select's options are never visible while it is closed.
  "option",
]);

// ── the flow tree ────────────────────────────────────────────────────────────

export interface FlowCall {
  kind: "flow";
  use: OriginFrame;
  flowPath: string;
  items: Item[];
}
export type Item = FlowCall | { kind: "step"; step: ExpandedStep };

const sameFrame = (a: OriginFrame, b: OriginFrame) => a.file === b.file && a.line === b.line;

export function flowTree(steps: readonly ExpandedStep[]): Item[] {
  const root: Item[] = [];
  const open: FlowCall[] = [];
  for (const step of steps) {
    const uses = step.origin.slice(0, -1);
    let depth = 0;
    while (
      depth < open.length &&
      depth < uses.length &&
      sameFrame(open[depth]?.use as OriginFrame, uses[depth] as OriginFrame)
    ) {
      depth++;
    }
    open.length = depth;
    for (let i = depth; i < uses.length; i++) {
      const call: FlowCall = {
        kind: "flow",
        use: uses[i] as OriginFrame,
        flowPath: step.flowPath[i] ?? "",
        items: [],
      };
      (i === 0 ? root : (open[i - 1] as FlowCall).items).push(call);
      open.push(call);
    }
    (open.length === 0 ? root : (open[open.length - 1] as FlowCall).items).push({
      kind: "step",
      step,
    });
  }
  return root;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const EXACT_CHECKS = new Set(["expectUrl", "expectText", "expectState", "expectCount"]);

export function isCheckStep(step: ExpandedStep): boolean {
  if (step.kind === "expect" || step.kind === "soft") return true;
  return step.kind === "exact" && step.exact?.form === "op" && EXACT_CHECKS.has(step.exact.op.op);
}

const isAction = (step: ExpandedStep | undefined) =>
  step !== undefined && step.kind !== "guard" && !isCheckStep(step);

/** The line as written in the file, e.g. `3. Expect: a dialog is open`. */
export function sourceLine(step: ExpandedStep): string {
  const prefix = {
    action: "",
    expect: "Expect: ",
    soft: "Soft: ",
    guard: "Never: ",
    exact: "Exact: ",
  }[step.kind];
  const text =
    step.kind === "exact" && step.exact?.form === "code"
      ? `${step.text || "TypeScript code"} (code block)`
      : `${prefix}${step.text}`;
  return step.number === null ? text : `${step.number}. ${text}`;
}

function stepTitle(step: ExpandedStep): string {
  const prefix = { action: "", expect: "Expect: ", soft: "Soft: ", guard: "Never: ", exact: "" }[
    step.kind
  ];
  if (step.kind === "exact" && step.exact?.form === "code") return step.text || "TypeScript code";
  return `${prefix}${step.text}`;
}

function specLocator(locator: SpecLocator): Locator {
  switch (locator.by) {
    case "role":
      return locator.name === undefined
        ? { kind: "role", role: locator.role }
        : { kind: "role", role: locator.role, name: locator.name, exact: true };
    case "label":
      return { kind: "label", text: locator.value, exact: true };
    case "testid":
      return { kind: "testId", value: locator.value };
    case "text":
      return { kind: "text", text: locator.value, exact: true };
    case "placeholder":
      return { kind: "placeholder", text: locator.value, exact: true };
    case "css":
      return { kind: "css", selector: locator.value };
  }
}

type BoundOp = ExactOp<BoundText>;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex literal for `source`, or undefined when it isn't a valid pattern. */
function regexLiteral(source: string): Expr | undefined {
  try {
    new RegExp(source);
  } catch {
    return undefined;
  }
  return raw(`/${source.replace(/(^|[^\\])\//g, "$1\\/").replace(/\n/g, "\\n")}/`);
}

function jsonExpr(value: unknown): Expr {
  if (value === null) return raw("null");
  if (typeof value === "string") return str(value);
  if (typeof value === "number") return raw(formatNumber(value));
  if (typeof value === "boolean") return raw(String(value));
  if (Array.isArray(value)) return arr(value.map(jsonExpr));
  if (typeof value === "object") {
    return obj(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonExpr(item)]),
    );
  }
  return raw("undefined");
}

// ── the generator ────────────────────────────────────────────────────────────

class SpecWriter {
  readonly needs: Needs = { fixtures: new Set(), imports: new Set(["expect", "test"]) };
  readonly taken = new Set(RESERVED);
  // Swapped while writing a profile's login flow (its own steps and recording).
  steps: ExpandedStep[];
  checks: Map<string, CodegenCheck>;
  recorded: Map<string, CodegenRecording["steps"][number]>;
  readonly marksNetwork: boolean;

  constructor(
    readonly recording: CodegenRecording,
    readonly source: SpecSource,
  ) {
    this.steps = source.expanded.steps;
    this.checks = new Map(recording.checks.map((check) => [check.textKey, check]));
    this.recorded = new Map(recording.steps.map((step) => [step.textKey, step]));
    this.marksNetwork = recording.checks.some((check) => check.check.type === "network");
  }

  fixture(name: FixtureName): void {
    this.needs.fixtures.add(name);
  }

  helper(name: string): Expr {
    this.needs.imports.add(name);
    return id(name);
  }

  /** `expect(...)` or `expect.soft(...)`. */
  expect(soft: boolean, subject: Expr): Expr {
    return call(soft ? member(id("expect"), "soft") : id("expect"), subject);
  }

  checkedElsewhere(line: string, reason: string): Stmt[] {
    return [
      comment(`Checked by ${brand.productName} only (${reason}): never fails or passes this spec.`),
      stmt(call(this.helper(CHECKED_ELSEWHERE), str(line), str(reason))),
    ];
  }

  /** Statements that skip the test (nothing after them in a step matters). */
  readonly skips = new WeakSet<Stmt>();

  skip(reason: string): Stmt[] {
    const statement = stmt(call("test.skip", raw("true"), str(reason)));
    this.skips.add(statement);
    return [statement];
  }

  value(parts: readonly Part[], scope: Scope, locals: StepLocals): Value {
    return resolveValue(parts, scope, { needs: this.needs, locals });
  }

  // ── commands ──

  command(cmd: Command, scope: Scope, locals: StepLocals): Stmt[] {
    const action = cmd.action;
    const text = (template: string): Value => this.value(recordingParts(template), scope, locals);
    const target = (locator: Locator) => {
      this.fixture("page");
      return locatorExpr(locator);
    };
    const run = (expr: Expr): Stmt[] => [stmt(awaited(expr))];
    this.fixture("page");
    switch (action.type) {
      case "goto": {
        const url = text(action.url);
        if (url.kind !== "text")
          return this.skip(
            `Opening this page needs ${url.kind === "secret" ? "a secret in the URL" : url.reason}`,
          );
        return run(method(id("page"), "goto", url.expr));
      }
      case "click":
      case "dblclick":
      case "hover":
      case "check":
      case "uncheck":
        return run(method(target(action.target), action.type));
      case "fill": {
        const value = text(action.value);
        if (value.kind === "secret") {
          this.fixture("secrets");
          return run(call("secrets.fill", target(action.target), str(value.name)));
        }
        if (value.kind === "unsupported")
          return this.skip(`This step types a value the spec can't produce: ${value.reason}`);
        return run(method(target(action.target), "fill", value.expr));
      }
      case "select": {
        const options = typeof action.option === "string" ? [action.option] : action.option;
        const values = options.map(text);
        const bad = values.find((value) => value.kind !== "text");
        if (bad) return this.skip("This step selects a value the spec can't produce");
        const exprs = values.map((value) => (value as { expr: Expr }).expr);
        return run(
          method(
            target(action.target),
            "selectOption",
            typeof action.option === "string" ? (exprs[0] as Expr) : arr(exprs),
          ),
        );
      }
      case "press":
        return action.target
          ? run(method(target(action.target), "press", str(action.key)))
          : run(call("page.keyboard.press", str(action.key)));
      case "scroll":
        if (action.target) return run(method(target(action.target), "scrollIntoViewIfNeeded"));
        return run(
          call(
            "page.mouse.wheel",
            num(0),
            num((action.direction === "up" ? -1 : 1) * (action.pixels ?? 600)),
          ),
        );
      case "upload": {
        const files = action.files.map((file) => str(`../${file.replace(/^\.\//, "")}`));
        return run(call(this.helper("upload"), target(action.target), arr(files)));
      }
      case "back":
        return run(call("page.goBack"));
      case "reload":
        return run(call("page.reload"));
      case "waitFor": {
        const options = action.timeoutMs ? [obj([["timeout", num(action.timeoutMs)]])] : [];
        if (action.target) {
          return run(
            method(
              this.expect(false, method(target(action.target), "first")),
              "toBeVisible",
              ...options,
            ),
          );
        }
        const waited = action.text === undefined ? undefined : text(action.text);
        if (waited?.kind !== "text")
          return this.skip("This step waits for text the spec can't produce");
        return run(
          method(
            this.expect(false, method(method(id("page"), "getByText", waited.expr), "first")),
            "toBeVisible",
            ...options,
          ),
        );
      }
      // Android actions have no web spec (Android tests export to Maestro, MOB-2).
      default:
        return this.skip(`"${action.type}" is an Android action; a web spec can't run it`);
    }
  }

  /** LRN-4: what the recording saw appear, as a web-first wait (never a fixed sleep). */
  learnedWait(cmd: Command, scope: Scope, locals: StepLocals): Stmt[] {
    const post = cmd.expectPost;
    if (post.urlChange) {
      const url = this.value(recordingParts(post.urlChange), scope, locals);
      if (url.kind === "text") {
        return [
          stmt(
            awaited(
              method(
                this.expect(false, id("page")),
                "toHaveURL",
                call(this.helper("route"), url.expr),
              ),
            ),
          ),
        ];
      }
    }
    // The element just acted on (a field showing its new value) is no page change to wait for,
    // and it may sit in a frame the page-level wait can't see.
    const self = cmd.fingerprint;
    const element = post.appeared?.find(
      (item) =>
        item.name.trim() !== "" &&
        !NO_WAIT_ROLES.has(item.role) &&
        !(self && item.role === self.role && item.name === self.name),
    );
    if (element) {
      const name = this.value(recordingParts(element.name), scope, locals);
      if (name.kind === "text" && name.expr.t === "str") {
        const locator = locatorExpr({
          kind: "role",
          role: element.role,
          name: name.expr.value,
          exact: true,
        });
        return [stmt(awaited(method(this.expect(false, method(locator, "first")), "toBeVisible")))];
      }
    }
    return [];
  }

  // ── checks ──

  checkStatements(
    check: CodegenCheck | undefined,
    step: ExpandedStep,
    scope: Scope,
    locals: StepLocals,
    soft: boolean,
  ): Stmt[] {
    const line = stepTitle(step);
    if (!check) return this.checkedElsewhere(line, "not recorded yet");
    const op: AnyCheckOp = check.check;
    const assert = (subject: Expr, matcher: string, ...args: Expr[]): Stmt[] => [
      stmt(awaited(method(this.expect(soft, subject), matcher, ...args))),
    ];
    const text = (template: string): Value => this.value(recordingParts(template), scope, locals);
    const target = (locator: Locator, container?: Locator) => {
      this.fixture("page");
      return locatorExpr(locator, container);
    };
    const softOption = soft ? [obj([["soft", raw("true")]])] : [];
    switch (op.type) {
      case "text": {
        const known = op as Extract<AnyCheckOp, { type: "text"; match: string }>;
        const value = text(known.value);
        if (value.kind !== "text") {
          return this.checkedElsewhere(
            line,
            value.kind === "secret" ? "it compares a secret" : value.reason,
          );
        }
        const locator = target(known.target, known.scope);
        const literal = value.expr.t === "str" ? value.expr.value : undefined;
        if (known.match === "matches") {
          // A regex search, like the harness (`matches`): RegExp.test on the text or value.
          const pattern =
            (literal !== undefined ? regexLiteral(literal) : undefined) ??
            newExpr(id("RegExp"), [value.expr]);
          return assert(locator, holdsValue(known.target) ? "toHaveValue" : "toHaveText", pattern);
        }
        if (holdsValue(known.target)) {
          if (known.match === "equals") return assert(locator, "toHaveValue", value.expr);
          const pattern =
            literal !== undefined
              ? (regexLiteral(escapeRegExp(literal)) as Expr)
              : call(this.helper("containing"), value.expr);
          return assert(locator, "toHaveValue", pattern);
        }
        return assert(
          locator,
          known.match === "equals" ? "toHaveText" : "toContainText",
          value.expr,
        );
      }
      case "url": {
        const known = op as Extract<AnyCheckOp, { type: "url" }>;
        const value = text(known.value);
        if (value.kind !== "text")
          return this.checkedElsewhere(
            line,
            value.kind === "secret" ? "it compares a secret" : value.reason,
          );
        this.fixture("page");
        const literal = value.expr.t === "str" ? value.expr.value : undefined;
        if (known.match === "is") return assert(id("page"), "toHaveURL", value.expr);
        if (known.match === "contains") {
          const pattern =
            literal !== undefined
              ? (regexLiteral(escapeRegExp(literal)) as Expr)
              : call(this.helper("containing"), value.expr);
          return assert(id("page"), "toHaveURL", pattern);
        }
        const pattern =
          (literal !== undefined ? regexLiteral(literal) : undefined) ??
          newExpr(id("RegExp"), [value.expr]);
        return assert(id("page"), "toHaveURL", pattern);
      }
      case "element_state": {
        const known = op as Extract<AnyCheckOp, { type: "element_state" }>;
        const locator = target(known.target, known.scope);
        const matcher = {
          visible: "toBeVisible",
          hidden: "toBeHidden",
          enabled: "toBeEnabled",
          disabled: "toBeDisabled",
          checked: "toBeChecked",
          unchecked: "toBeChecked",
          focused: "toBeFocused",
          editable: "toBeEditable",
          empty: "toBeEmpty",
        }[known.state];
        if (known.state === "unchecked") {
          return [stmt(awaited(method(member(this.expect(soft, locator), "not"), matcher)))];
        }
        return assert(locator, matcher);
      }
      case "count": {
        const known = op as Extract<AnyCheckOp, { type: "count" }>;
        const locator = target(known.target, known.scope);
        if (known.n !== undefined) return assert(locator, "toHaveCount", num(known.n));
        const range: Array<[string, Expr]> = [];
        if (known.min !== undefined) range.push(["min", num(known.min)]);
        if (known.max !== undefined) range.push(["max", num(known.max)]);
        return [
          stmt(awaited(call(this.helper("expectCount"), locator, obj(range), ...softOption))),
        ];
      }
      case "network": {
        const known = op as Extract<AnyCheckOp, { type: "network" }>;
        this.fixture("network");
        const match: Array<[string, Expr]> = [
          ["method", str(known.method.toUpperCase())],
          ["url", str(known.url)],
        ];
        if (known.status !== undefined) match.push(["status", num(known.status)]);
        return [stmt(awaited(call("network.expectResponse", obj(match), ...softOption)))];
      }
      case "aria_snapshot": {
        const known = op as Extract<AnyCheckOp, { type: "aria_snapshot" }>;
        const snapshot = known.snapshot.replace(/\s+$/, "");
        return assert(target(known.target, known.scope), "toMatchAriaSnapshot", {
          t: "tpl",
          parts: [`\n${snapshot}\n`],
        });
      }
      case "code": {
        const known = op as Extract<AnyCheckOp, { type: "code" }>;
        this.fixture("page");
        return [{ t: "verbatim", code: known.code.replace(/\s+$/, "") }];
      }
      case "pending":
        return this.checkedElsewhere(line, "not compiled to code yet");
      default:
        return this.checkedElsewhere(
          line,
          op.type === "soft_judgment" ? "a model judges it" : `a "${op.type}" check`,
        );
    }
  }

  /** An exact check step with no recorded check: typed straight from the op. */
  exactCheck(op: BoundOp): CodegenCheck["check"] | undefined {
    switch (op.op) {
      case "expectUrl":
        return { type: "url", match: op.match, value: op.value.raw };
      case "expectText":
        return {
          type: "text",
          target: specLocator(op.target),
          match: op.match === "text" ? "equals" : "contains",
          value: op.value.raw,
        };
      case "expectState":
        return { type: "element_state", target: specLocator(op.target), state: op.state };
      case "expectCount":
        return { type: "count", target: specLocator(op.target), n: op.count };
      default:
        return undefined;
    }
  }

  /** An exact action step with no recording: its one command, straight from the op. */
  exactCommand(op: BoundOp): Command | undefined {
    const action = (() => {
      switch (op.op) {
        case "goto":
          return { type: "goto" as const, url: op.url.raw };
        case "click":
          return { type: "click" as const, target: specLocator(op.target) };
        case "fill":
          return { type: "fill" as const, target: specLocator(op.target), value: op.value.raw };
        case "select":
          return { type: "select" as const, target: specLocator(op.target), option: op.option.raw };
        case "press":
          return { type: "press" as const, key: op.key };
        default:
          return undefined;
      }
    })();
    if (!action) return undefined;
    return {
      action,
      fingerprint: null,
      expectPost: {},
      wait: { settledMs: 0, waitedFor: { network: 0, dom: 0, busy: 0 } },
    };
  }

  // ── steps ──

  stepBody(step: ExpandedStep, scope: Scope): Stmt[] {
    const locals = new StepLocals(this.taken);
    const body: Stmt[] = [];
    const index = this.steps.indexOf(step);
    const nextIsAction = isAction(this.steps[index + 1]);
    if (isCheckStep(step)) {
      let check = this.checks.get(step.textKey);
      if (!check && step.kind === "exact" && step.exact?.form === "op") {
        const op = this.exactCheck(step.exact.op);
        if (op)
          check = {
            key: "",
            textKey: step.textKey,
            text: step.text,
            soft: false,
            check: op,
            generatedBy: "exact",
          };
      }
      body.push(
        ...this.checkStatements(check, step, scope, locals, check?.soft ?? step.kind === "soft"),
      );
    } else if (step.kind === "exact" && step.exact?.form === "code") {
      this.fixture("page");
      body.push({ t: "verbatim", code: step.exact.code.replace(/\s+$/, "") });
    } else {
      const recorded = this.recorded.get(step.textKey);
      let commands = recorded?.commands;
      if (!commands && step.kind === "exact" && step.exact?.form === "op") {
        const command = this.exactCommand(step.exact.op);
        if (command) commands = [command];
      }
      if (!commands) {
        const which = step.number === null ? "This step" : `Step ${step.number}`;
        return this.skip(
          `${which} is not recorded yet: run \`${brand.cliName} author ${this.source.expanded.path}\``,
        );
      }
      if (this.marksNetwork) {
        this.fixture("network");
        body.push(stmt(call("network.mark")));
      }
      commands.forEach((cmd, i) => {
        const fallbacks = cmd.fingerprint?.fallbacks.length ?? 0;
        if (fallbacks > 0) {
          body.push(
            comment(
              `${fallbacks} fallback locator${fallbacks === 1 ? "" : "s"} recorded: ${brand.productName} can heal this.`,
            ),
          );
        }
        const statements = this.command(cmd, scope, locals);
        body.push(...statements);
        const skipped = statements.some((statement) => this.skips.has(statement));
        const last = i === commands.length - 1;
        if (!skipped && (!last || nextIsAction)) body.push(...this.learnedWait(cmd, scope, locals));
      });
    }
    return [...locals.statements.map((local) => constStmt(local.name, local.init)), ...body];
  }

  step(step: ExpandedStep, scope: Scope): Stmt[] {
    return [
      comment(sourceLine(step)),
      stmt(
        awaited(call("test.step", str(stepTitle(step)), arrow(null, this.stepBody(step, scope)))),
      ),
    ];
  }

  // ── scopes and objects ──

  /** Declares the data and params objects a scope needs, with only the keys used. */
  declare(scope: Scope, kind: "data" | "params"): Stmt[] {
    if (kind === "params") {
      const props: Array<[string, Expr]> = [];
      for (const name of Object.keys(scope.params)) {
        if (!scope.usedParams.has(name)) continue;
        const param = scope.params[name] as Scope["params"][string];
        const value = resolveValue(param.parts, param.scope, { needs: this.needs });
        if (value.kind === "text") props.push([name, value.expr]);
      }
      return props.length > 0 ? [constStmt(scope.paramsVar, obj(props))] : [];
    }
    // Data values may use other data values: those are declared first, as constants.
    const needed = new Set<string>();
    const referencedByOthers = new Set<string>();
    const visit = (key: string) => {
      if (needed.has(key) || !Object.hasOwn(scope.data, key)) return;
      needed.add(key);
      for (const part of scope.data[key] as Part[]) {
        if ("ref" in part && part.ref.startsWith("data.")) {
          const other = part.ref.slice(5);
          if (Object.hasOwn(scope.data, other) && other !== key) {
            referencedByOthers.add(other);
            visit(other);
          }
        }
      }
    };
    for (const key of Object.keys(scope.data)) if (scope.usedData.has(key)) visit(key);
    const statements: Stmt[] = [];
    const aliases = new Map<string, string>();
    const declaring: Scope = { ...scope, aliases, usedData: new Set() };
    const order: string[] = [];
    const placed = new Set<string>();
    const place = (key: string, stack: Set<string>) => {
      if (placed.has(key) || stack.has(key)) return;
      stack.add(key);
      for (const part of scope.data[key] as Part[]) {
        if ("ref" in part && part.ref.startsWith("data.") && needed.has(part.ref.slice(5)))
          place(part.ref.slice(5), stack);
      }
      placed.add(key);
      order.push(key);
    };
    for (const key of Object.keys(scope.data)) if (needed.has(key)) place(key, new Set());
    for (const key of order.filter((k) => referencedByOthers.has(k))) {
      const value = resolveValue(scope.data[key] as Part[], declaring, { needs: this.needs });
      if (value.kind !== "text") continue;
      const name = uniqueName(camel([scope.dataVar, key]), this.taken);
      statements.push(constStmt(name, value.expr));
      aliases.set(key, name);
    }
    const props: Array<[string, Expr]> = [];
    for (const key of Object.keys(scope.data)) {
      if (!scope.usedData.has(key)) continue;
      if (!isTextValue(scope.data[key] as Part[], scope)) continue;
      const alias = aliases.get(key);
      if (alias) props.push([key, id(alias)]);
      else {
        const value = resolveValue(scope.data[key] as Part[], declaring, { needs: this.needs });
        if (value.kind === "text") props.push([key, value.expr]);
      }
    }
    if (props.length > 0) statements.push(constStmt(scope.dataVar, obj(props)));
    return statements;
  }

  items(items: readonly Item[], scope: Scope): Stmt[] {
    const out: Stmt[] = [];
    for (const item of items) {
      if (out.length > 0) out.push(blank);
      if (item.kind === "step") {
        out.push(...this.step(item.step, scope));
        continue;
      }
      out.push(...this.flow(item, scope));
    }
    return out;
  }

  flow(call_: FlowCall, caller: Scope): Stmt[] {
    const flow = this.source.specs[call_.flowPath];
    const including = this.source.specs[call_.use.file];
    const useStep = including
      ? specSteps(including).find(
          (step): step is FlowStep =>
            step.kind === "flow" && step.at?.range.start.line === call_.use.line,
        )
      : undefined;
    const base = camel([
      call_.flowPath
        .split("/")
        .pop()
        ?.replace(/\.test\.md$|\.md$/, "") ?? "flow",
    ]);
    const dataVar = uniqueName(`${base}Data`, this.taken);
    const paramsVar = uniqueName(`${base}Params`, this.taken);
    const flowData: Record<string, Part[]> = {};
    for (const [key, template] of Object.entries(flow?.frontmatter.data ?? {}))
      flowData[key] = templateParts(template);
    const dataScope = createScope(dataVar, flowData);
    const params: Scope["params"] = {};
    for (const [name, fallback] of Object.entries(flow?.frontmatter.params ?? {})) {
      const given = useStep?.params[name];
      if (given) params[name] = { parts: templateParts(given), scope: caller };
      else if (fallback) params[name] = { parts: templateParts(fallback), scope: dataScope };
    }
    const scope: Scope = { ...dataScope, paramsVar, params };
    const inner = this.items(call_.items, scope);
    // Declarations use the keys the steps read; params can read the flow's data.
    const paramsDecl = this.declare(scope, "params");
    const dataDecl = this.declare(scope, "data");
    const name = flow?.frontmatter.name || call_.flowPath;
    const usePath = useStep?.path ?? call_.flowPath;
    const title = `${name} (${usePath})`;
    return [
      ...dataDecl,
      ...paramsDecl,
      comment(`${call_.use.number === null ? "" : `${call_.use.number}. `}Use: ${usePath}`),
      stmt(awaited(call("test.step", str(title), arrow(null, inner)))),
    ];
  }

  /** `auth: <profile>`: the profile's login flow as one step, from the flow's own recording. */
  profileLogin(profile: NonNullable<SpecSource["profile"]>): Stmt[] {
    const flow = this.source.specs[profile.path];
    const saved = { steps: this.steps, checks: this.checks, recorded: this.recorded };
    this.steps = profile.expanded.steps;
    this.checks = new Map(profile.recording.checks.map((check) => [check.textKey, check]));
    this.recorded = new Map(profile.recording.steps.map((step) => [step.textKey, step]));
    try {
      const base = camel([
        profile.path
          .split("/")
          .pop()
          ?.replace(/\.test\.md$|\.md$/, "") ?? "login",
      ]);
      const dataVar = uniqueName(`${base}Data`, this.taken);
      const paramsVar = uniqueName(`${base}Params`, this.taken);
      const flowData: Record<string, Part[]> = {};
      for (const [key, template] of Object.entries(flow?.frontmatter.data ?? {}))
        flowData[key] = templateParts(template);
      const dataScope = createScope(dataVar, flowData);
      const params: Scope["params"] = {};
      for (const [name, fallback] of Object.entries(flow?.frontmatter.params ?? {})) {
        const given = profile.params[name];
        if (given !== undefined)
          params[name] = { parts: templateParts(parseTemplate(given)), scope: dataScope };
        else if (fallback) params[name] = { parts: templateParts(fallback), scope: dataScope };
      }
      const scope: Scope = { ...dataScope, paramsVar, params };
      const inner = this.items(flowTree(profile.expanded.steps), scope);
      return [
        ...this.declare(scope, "data"),
        ...this.declare(scope, "params"),
        comment(
          `auth: ${profile.name}. ${brand.productName} reuses a saved session; this spec logs in each time.`,
        ),
        stmt(
          awaited(
            call("test.step", str(`auth: ${profile.name} (${profile.path})`), arrow(null, inner)),
          ),
        ),
      ];
    } finally {
      Object.assign(this, saved);
    }
  }

  // ── the test ──

  hooks(): Stmt[] {
    const test = this.source.expanded;
    const out: Stmt[] = [];
    const block = (phase: "setup" | "teardown") => {
      const hooks = phase === "setup" ? test.setup : test.teardown;
      if (hooks.length === 0) return;
      const body: Stmt[] = [];
      const names = new Set<string>(["page", "expect", "allowed"]);
      for (const hook of hooks) {
        if (hook.type !== "request") {
          const what = hook.type === "run" ? `run ${hook.script}` : `sql ${hook.statement}`;
          body.push(comment(`${phase}: ${what}`));
          body.push(
            ...this.skip(`\`${hook.type}\` ${phase} hooks are not supported yet (${what})`),
          );
          continue;
        }
        const description = `${hook.method} ${hook.target}`;
        const verb = hook.method.toLowerCase();
        const options: Array<[string, Expr]> = [];
        if (hook.body !== undefined) options.push(["data", jsonExpr(hook.body)]);
        if (hook.headers) options.push(["headers", jsonExpr(hook.headers)]);
        options.push(["maxRedirects", num(0)]);
        const url = call(this.helper("allowed"), str(hook.target));
        const request =
          verb === "options"
            ? call("page.request.fetch", url, obj([["method", str(hook.method)], ...options]))
            : call(`page.request.${verb === "delete" ? "delete" : verb}`, url, obj(options));
        const segment =
          new URL(hook.target, "http://x.invalid").pathname.split("/").filter(Boolean).pop() ??
          "response";
        const name = uniqueName(camel([segment]), names);
        body.push(comment(`${phase}: ${description}`));
        body.push(constStmt(name, awaited(request)));
        body.push(
          stmt(
            awaited(method(call("expect", id(name), str(`${phase}: ${description}`)), "toBeOK")),
          ),
        );
      }
      out.push(
        stmt(call(phase === "setup" ? "test.beforeEach" : "test.afterEach", arrow(["page"], body))),
      );
    };
    block("setup");
    if (out.length > 0 && test.teardown.length > 0) out.push(blank);
    block("teardown");
    return out;
  }

  write(): { statements: Stmt[] } {
    const test = this.source.expanded;
    const testScope = createScope(
      "data",
      Object.fromEntries(
        Object.entries(test.data).map(([key, bound]) => [
          key,
          templateParts(parseTemplate(bound.raw)),
        ]),
      ),
    );
    const body: Stmt[] = [];
    if (test.timeout) body.push(stmt(call("test.setTimeout", num(test.timeout * 1000))));
    const login: Stmt[] = [];
    if (test.auth && test.auth !== "none") {
      if (this.source.profile) login.push(...this.profileLogin(this.source.profile));
      else
        body.push(
          ...this.skip(
            `Signs in with the auth profile "${test.auth}", whose login flow isn't recorded yet`,
          ),
        );
    }
    const start: Stmt[] = [];
    if (test.start) {
      const locals = new StepLocals(this.taken);
      const url = this.value(templateParts(parseTemplate(test.start.raw)), testScope, locals);
      if (url.kind === "text") {
        this.fixture("page");
        start.push(
          comment(`Start: ${test.start.raw}`),
          ...locals.statements.map((local) => constStmt(local.name, local.init)),
          stmt(awaited(method(id("page"), "goto", url.expr))),
        );
      }
    }
    const steps = this.items(flowTree(this.steps), testScope);
    const data = this.declare(testScope, "data");
    body.push(...data);
    if (body.length > 0) body.push(blank);
    if (login.length > 0) body.push(...login, blank);
    if (start.length > 0) body.push(...start, blank);
    body.push(...steps);

    const details: Array<[string, Expr]> = [];
    if (test.tags.length > 0) details.push(["tag", arr(test.tags.map((tag) => str(`@${tag}`)))]);
    const guards = test.guards.map((guard) =>
      obj([
        ["type", str(brand.cliName)],
        ["description", str(`Never: ${guard.text} (checked by ${brand.productName} only)`)],
      ]),
    );
    if (guards.length > 0) details.push(["annotation", arr(guards)]);
    const fixtures = FIXTURE_ORDER.filter((name) => this.needs.fixtures.has(name));
    const testCall = call(
      "test",
      str(test.name || test.id),
      ...(details.length > 0 ? [obj(details)] : []),
      arrow(fixtures, body),
    );
    const hooks = this.hooks();
    const imports = [...this.needs.imports].sort((a, b) => a.localeCompare(b, "en"));
    return {
      statements: [
        { t: "verbatim", code: "" },
        importStatement(imports, `./${FIXTURES_MODULE}`),
        blank,
        ...(hooks.length > 0 ? [...hooks, blank] : []),
        stmt(testCall),
      ],
    };
  }
}

/** `import { a, b } from "x";`, broken over lines when too long. */
function importStatement(names: string[], from: string): Stmt {
  const flat = `import { ${names.join(", ")} } from "${from}";`;
  if (flat.length <= 100) return { t: "verbatim", code: flat };
  return {
    t: "verbatim",
    code: `import {\n${names.map((name) => `  ${name},`).join("\n")}\n} from "${from}";`,
  };
}

/** A stable identity of what the spec is generated from (commands and checks, not timestamps). */
export function recordingKey(recording: CodegenRecording): string {
  return JSON.stringify({
    testId: recording.testId,
    steps: recording.steps.map((step) => [step.textKey, step.commands]),
    checks: recording.checks.map((check) => [check.textKey, check.soft, check.check]),
  });
}

/**
 * Generates `<testId>.spec.ts` for one test from its recording. Deterministic:
 * the same recording and test file always give the same bytes.
 */
export function generateSpec(recording: CodegenRecording, source: SpecSource): GeneratedFile {
  const writer = new SpecWriter(recording, source);
  const { statements } = writer.write();
  const body = printModule(statements.slice(1));
  const header: Header = {
    from: source.expanded.path,
    recording: recordingFileName(recording.testId),
    recordingKey: recordingKey(recording),
  };
  return { name: specFileName(recording.testId), content: withHeader(body, header) };
}
