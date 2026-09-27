import type { HealPolicy } from "@testament/contract";
import { testIdFromPath } from "@testament/contract";
import { type SpecDiagnostic, sortDiagnostics } from "./diagnostics.js";
import { opTemplates, printExactOp } from "./exact.js";
import { DEFAULT_EMAIL_DOMAIN, defaultGenerators, type GeneratorRegistry } from "./generators.js";
import { KeyCounter, stepKeyText } from "./key.js";
import type {
  DestructiveAction,
  ExactOp,
  FlowStep,
  Hook,
  Range,
  Step,
  Template,
  TestSpec,
} from "./model.js";
import { specSteps } from "./model.js";
import { type ParseOptions, type ParseResult, parseTest } from "./parse.js";
import { parseTemplate } from "./template.js";
import { Reporter } from "./text.js";

/** Reads a project-relative, `/`-separated path; `undefined` when there is no such file. */
export type FileReader = (path: string) => string | undefined | Promise<string | undefined>;

/** A reader over an in-memory map of path → text (tests, the web app's cache). */
export function mapReader(files: Readonly<Record<string, string>>): FileReader {
  return (path) => (Object.hasOwn(files, path) ? files[path] : undefined);
}

export interface ExpandContext extends ParseOptions {
  /** Reads flow files. The web app passes one backed by cloud storage. */
  readFile: FileReader;
  /**
   * Run seed for `{{unique.*}}` / `{{faker.*}}` (ENV-3). Include the run id and
   * worker, so parallel runs and workers get different values.
   */
  seed: string;
  /** Environment whose frontmatter overrides apply. */
  environment?: string | undefined;
  /** Values for `{{env.X}}` (the environment's `vars`). When omitted, env refs stay unresolved. */
  vars?: Readonly<Record<string, string>> | undefined;
  /** Project-relative tests folder, the fallback root for `Use:` paths. Default `tests`. */
  testsDir?: string | undefined;
  /** Domain for `unique.email`. Default `example.test`. */
  emailDomain?: string | undefined;
  /** Maximum flow nesting. Default 8. */
  maxDepth?: number | undefined;
  /**
   * For a flow run on its own (an auth profile's login, SEC-3): params given as
   * templates, e.g. `{ email: "{{env.ADMIN_EMAIL}}" }`. They replace the flow's
   * defaults and are bound in the flow's own data.
   */
  params?: Readonly<Record<string, string>> | undefined;
}

/**
 * A bound piece of step text. Secrets stay references (SEC-1): only the
 * browser/Android driver ever turns `secret` into a value.
 */
export type BoundSegment =
  | { kind: "text"; text: string }
  | { kind: "value"; ref: string; text: string }
  | { kind: "secret"; name: string }
  | { kind: "unresolved"; ref: string };

export interface BoundText {
  /** As written, e.g. `Fill "Email" with {{params.email}}`. */
  raw: string;
  segments: BoundSegment[];
  /** Values filled in, secrets shown as `{{secret.NAME}}`. */
  display: string;
}

export interface OriginFrame {
  file: string;
  line: number;
  /** Display number of the step in that file. */
  number: number | null;
  range?: Range;
}

export interface ExpandedStep {
  /** Position in `steps` (or in `guards`). */
  index: number;
  kind: Exclude<Step["kind"], "flow">;
  number: number | null;
  /** Text as written; for `Exact:` the canonical op, for code the label. */
  text: string;
  bound: BoundSegment[];
  display: string;
  textKey: string;
  /** Flows the step came through, outermost first. */
  flowPath: string[];
  /** The `Use:` steps that led here (outermost first), then the step itself. */
  origin: OriginFrame[];
  exact?:
    | { form: "op"; op: ExactOp<BoundText> }
    | { form: "code"; lang: "ts"; code: string; label?: string };
}

export interface ExpandedTest {
  id: string;
  path: string;
  kind: "test" | "flow";
  name: string;
  tags: string[];
  environment: string | null;
  /** The test's own start. An included flow's start is ignored. */
  start: BoundText | null;
  auth: string | null;
  timeout: number | null;
  heal: HealPolicy | null;
  allowDestructive: DestructiveAction[];
  dataset: string | null;
  setup: Hook[];
  teardown: Hook[];
  data: Record<string, BoundText>;
  /** For a flow run on its own: its params, from their defaults. */
  params: Record<string, BoundText>;
  steps: ExpandedStep[];
  /** Guards of the test and of every included flow. They apply to the whole test. */
  guards: ExpandedStep[];
  /** Every file read (the test first), for cache invalidation. */
  files: string[];
  /** Problems in the test and its flows, sorted, without duplicates. */
  diagnostics: SpecDiagnostic[];
}

// ── paths ─────────────────────────────────────────────────────────────────────

/** Normalizes a `/` path; undefined when it escapes the project. */
export function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** Where `Use: <path>` may point: relative to the including file, then the tests root. */
export function flowCandidates(from: string, use: string, testsDir: string): string[] {
  const list = use.startsWith("/")
    ? [normalizePath(use)]
    : [normalizePath(`${dirOf(from)}/${use}`), normalizePath(`${testsDir}/${use}`)];
  return [...new Set(list.filter((p): p is string => p !== undefined && p !== ""))];
}

// ── binding ───────────────────────────────────────────────────────────────────

type Bindings = { data: Map<string, BoundSegment[]>; params: Map<string, BoundSegment[]> };

export function displayOf(segments: readonly BoundSegment[]): string {
  return segments
    .map((s) =>
      s.kind === "secret"
        ? `{{secret.${s.name}}}`
        : s.kind === "unresolved"
          ? `{{${s.ref}}}`
          : s.text,
    )
    .join("");
}

/** Labels a bound value with the reference it came through, keeping secrets as secrets. */
function wrap(ref: string, segments: readonly BoundSegment[]): BoundSegment[] {
  const out: BoundSegment[] = [];
  for (const s of segments) {
    if (s.kind === "secret" || s.kind === "unresolved") out.push(s);
    else {
      const last = out[out.length - 1];
      if (last?.kind === "value" && last.ref === ref) last.text += s.text;
      else out.push({ kind: "value", ref, text: s.text });
    }
  }
  return out.length > 0 ? out : [{ kind: "value", ref, text: "" }];
}

function merge(segments: BoundSegment[]): BoundSegment[] {
  const out: BoundSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (s.kind === "text" && last?.kind === "text") last.text += s.text;
    else if (!(s.kind === "text" && s.text === "")) out.push({ ...s });
  }
  return out;
}

/** The canonical op text with each value's bound segments spliced in (secrets stay references). */
function opSegments(op: ExactOp<BoundText>): BoundSegment[] {
  const values: BoundText[] = [];
  const marked = printExactOp(op, (value) => `\u0000${values.push(value) - 1}\u0000`);
  const out: BoundSegment[] = [];
  marked.split("\u0000").forEach((part, i) => {
    if (i % 2 === 0) out.push({ kind: "text", text: part });
    else out.push(...(values[Number(part)]?.segments ?? []));
  });
  return merge(out);
}

class Expander {
  readonly diagnostics: SpecDiagnostic[] = [];
  readonly files: string[] = [];
  readonly #cache = new Map<string, ParseResult | null>();
  readonly #counter = new KeyCounter();
  readonly steps: ExpandedStep[] = [];
  readonly guards: ExpandedStep[] = [];
  readonly generators: GeneratorRegistry;
  readonly testsDir: string;
  readonly maxDepth: number;
  readonly testId: string;

  constructor(
    readonly root: TestSpec,
    readonly ctx: ExpandContext,
  ) {
    this.generators = ctx.generators ?? defaultGenerators;
    this.testsDir = normalizePath(ctx.testsDir ?? "tests") ?? "tests";
    this.maxDepth = ctx.maxDepth ?? 8;
    this.testId = testIdFromPath(root.path);
    this.files.push(root.path);
    this.#cache.set(root.path, { spec: root, diagnostics: [] });
  }

  async load(path: string): Promise<ParseResult | null> {
    if (this.#cache.has(path)) return this.#cache.get(path) ?? null;
    let text: string | undefined;
    try {
      text = await this.ctx.readFile(path);
    } catch {
      text = undefined;
    }
    const result = text === undefined ? null : parseTest(text, path, this.ctx);
    this.#cache.set(path, result);
    if (result) {
      this.files.push(path);
      this.diagnostics.push(...result.diagnostics);
    }
    return result;
  }

  bind(template: Template, bindings: Bindings, where: string, report: Reporter): BoundSegment[] {
    const out: BoundSegment[] = [];
    template.segments.forEach((s, i) => {
      if (s.kind === "text") {
        out.push({ kind: "text", text: s.text });
        return;
      }
      const ref = `${s.ns}.${s.name}`;
      switch (s.ns) {
        case "secret":
          out.push({ kind: "secret", name: s.name });
          return;
        case "inbox":
          // Read from the test inbox at run time (the auth package's InboxValues).
          out.push({ kind: "unresolved", ref });
          return;
        case "data":
        case "params": {
          const value = (s.ns === "data" ? bindings.data : bindings.params).get(s.name);
          out.push(...(value ? wrap(ref, value) : [{ kind: "text", text: s.raw } as const]));
          return;
        }
        case "env": {
          const vars = this.ctx.vars;
          if (!vars) out.push({ kind: "unresolved", ref });
          else if (Object.hasOwn(vars, s.name))
            out.push({ kind: "value", ref, text: vars[s.name] ?? "" });
          else {
            report.error(
              "ENV_UNDEFINED",
              s.at?.range,
              `{{${ref}}} is not set${this.ctx.environment ? ` in environment "${this.ctx.environment}"` : ""}.`,
              `Add ${s.name} under the environment's vars: in the project settings, or fix the name.`,
            );
            out.push({ kind: "unresolved", ref });
          }
          return;
        }
        case "unique":
        case "faker": {
          const value = this.generators.generate(
            s.ns,
            s.name,
            this.ctx.seed,
            `${this.testId}|${where}|${i}`,
            {
              emailDomain: this.ctx.emailDomain ?? DEFAULT_EMAIL_DOMAIN,
            },
          );
          out.push(
            value === undefined
              ? { kind: "text", text: s.raw }
              : { kind: "value", ref, text: value },
          );
          return;
        }
        default:
          out.push({ kind: "text", text: s.raw });
      }
    });
    return merge(out);
  }

  /** Evaluates data values in dependency order. Cycles were reported by the parser. */
  bindData(
    data: Readonly<Record<string, Template>>,
    chainKey: string,
    report: Reporter,
    extra?: Bindings,
  ) {
    const values = new Map<string, BoundSegment[]>();
    const visiting = new Set<string>();
    const bindings: Bindings = { data: values, params: extra?.params ?? new Map() };
    const visit = (key: string): void => {
      if (values.has(key) || visiting.has(key)) return;
      const template = data[key];
      if (!template) return;
      visiting.add(key);
      for (const s of template.segments) {
        if (s.kind === "var" && s.ns === "data" && Object.hasOwn(data, s.name)) visit(s.name);
      }
      visiting.delete(key);
      if (!values.has(key))
        values.set(key, this.bind(template, bindings, `${chainKey}data.${key}`, report));
    };
    for (const key of Object.keys(data)) visit(key);
    return values;
  }

  bound(template: Template, bindings: Bindings, where: string, report: Reporter): BoundText {
    const segments = this.bind(template, bindings, where, report);
    return { raw: template.raw, segments, display: displayOf(segments) };
  }

  emit(
    step: Exclude<Step, FlowStep>,
    spec: TestSpec,
    bindings: Bindings,
    chain: string[],
    via: OriginFrame[],
    report: Reporter,
  ) {
    const keyText = stepKeyText(step);
    const textKey = this.#counter.next(step.kind, chain, keyText);
    const where = `${chain.join(">")}|${textKey}`;
    const frame: OriginFrame = {
      file: spec.path,
      line: step.at?.range.start.line ?? 0,
      number: step.number,
      ...(step.at && { range: step.at.range }),
    };
    let text: string;
    let segments: BoundSegment[];
    let exact: ExpandedStep["exact"];
    if (step.kind === "exact") {
      if (step.exact.form === "code") {
        text = step.exact.label ?? "";
        segments = [{ kind: "text", text: text || "(TypeScript code)" }];
        exact = {
          form: "code",
          lang: step.exact.lang,
          code: step.exact.code,
          ...(step.exact.label && { label: step.exact.label }),
        };
      } else {
        const op = step.exact.op;
        const templates = opTemplates(op);
        const boundOp = { ...op } as Record<string, unknown>;
        for (const [field, value] of Object.entries(op)) {
          const index = templates.indexOf(value as Template);
          if (index >= 0)
            boundOp[field] = this.bound(value as Template, bindings, `${where}|${field}`, report);
        }
        exact = { form: "op", op: boundOp as ExactOp<BoundText> };
        text = printExactOp(op, (t) => t.raw);
        segments = opSegments(exact.op);
      }
    } else {
      text = step.text.raw;
      segments = this.bind(step.text, bindings, where, report);
    }
    const list = step.kind === "guard" ? this.guards : this.steps;
    list.push({
      index: list.length,
      kind: step.kind,
      number: step.number,
      text,
      bound: segments,
      display: displayOf(segments),
      textKey,
      flowPath: [...chain],
      origin: [...via, frame],
      ...(exact && { exact }),
    });
  }

  async body(
    spec: TestSpec,
    bindings: Bindings,
    chain: string[],
    via: OriginFrame[],
    stack: string[],
  ) {
    const report = new Reporter(spec.path);
    for (const step of specSteps(spec)) {
      if (step.kind !== "flow") {
        this.emit(step, spec, bindings, chain, via, report);
        continue;
      }
      await this.include(step, spec, bindings, chain, via, stack, report);
    }
    this.diagnostics.push(...report.diagnostics);
  }

  async include(
    step: FlowStep,
    spec: TestSpec,
    bindings: Bindings,
    chain: string[],
    via: OriginFrame[],
    stack: string[],
    report: Reporter,
  ) {
    const pathRange = step.at?.path ?? step.at?.range;
    const candidates = flowCandidates(spec.path, step.path, this.testsDir);
    let found: { path: string; result: ParseResult } | undefined;
    for (const candidate of candidates) {
      const result = await this.load(candidate);
      if (result) {
        found = { path: candidate, result };
        break;
      }
    }
    if (!found) {
      report.error(
        "FLOW_NOT_FOUND",
        pathRange,
        `Flow "${step.path}" was not found (looked for ${candidates.join(" and ") || "a path inside the project"}).`,
        `Fix the path (it is relative to this file, or to the ${this.testsDir}/ folder), or create the flow.`,
      );
      return;
    }
    const { path, result } = found;
    const flow = result.spec;
    if (stack.includes(path)) {
      report.error(
        "FLOW_CYCLE",
        pathRange,
        `Flows include each other in a loop: ${[...stack, path].join(" → ")}.`,
        `Remove this Use: step, or the one in ${path} that leads back here.`,
      );
      return;
    }
    if (chain.length + 1 > this.maxDepth) {
      report.error(
        "FLOW_DEPTH",
        pathRange,
        `Flows are nested more than ${this.maxDepth} deep here.`,
        "Flatten the flows: include fewer flows inside flows.",
      );
      return;
    }
    if (flow.frontmatter.kind !== "flow") {
      report.error(
        "FLOW_NOT_A_FLOW",
        pathRange,
        `${path} is a test, not a flow.`,
        `Add "kind: flow" to its frontmatter if it is meant to be reused, or include a flow instead.`,
      );
      return;
    }

    const flowReport = new Reporter(path);
    const useKey = `${chain.join(">")}|use:${stepKeyText(step)}`;
    const declared = flow.frontmatter.params;
    for (const name of Object.keys(step.params)) {
      if (!Object.hasOwn(declared, name)) {
        report.error(
          "FLOW_PARAM_UNKNOWN",
          step.params[name]?.at?.range ?? step.at?.params ?? pathRange,
          `Flow ${path} has no param "${name}".`,
          Object.keys(declared).length > 0
            ? `Use one of: ${Object.keys(declared).join(", ")}.`
            : "Remove it; this flow takes no params.",
        );
      }
    }
    const flowData = this.bindData(flow.frontmatter.data, `${useKey}|`, flowReport);
    const params = new Map<string, BoundSegment[]>();
    for (const [name, fallback] of Object.entries(declared)) {
      const given = step.params[name];
      if (given) params.set(name, this.bind(given, bindings, `${useKey}|${name}`, report));
      else if (fallback) {
        params.set(
          name,
          this.bind(
            fallback,
            { data: flowData, params: new Map() },
            `${useKey}|default.${name}`,
            flowReport,
          ),
        );
      } else {
        report.error(
          "FLOW_PARAM_MISSING",
          step.at?.params ?? step.at?.range,
          `Flow ${path} needs the param "${name}".`,
          `Pass it: Use: ${step.path} { ${[...Object.keys(step.params), name].map((k) => `${k}: …`).join(", ")} }`,
        );
      }
    }
    this.diagnostics.push(...flowReport.diagnostics);
    const frame: OriginFrame = {
      file: spec.path,
      line: step.at?.range.start.line ?? 0,
      number: step.number,
      ...(step.at && { range: step.at.range }),
    };
    await this.body(
      flow,
      { data: flowData, params },
      [...chain, path],
      [...via, frame],
      [...stack, path],
    );
  }
}

function dedupe(diagnostics: SpecDiagnostic[]): SpecDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const id = JSON.stringify([d.code, d.file, d.range, d.message]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Turns a parsed test into its runnable form: flows inlined (recursively, with
 * params bound), variables bound, secrets kept as references, and a stable
 * textKey per step. Never throws on user mistakes. Pass the parse diagnostics of
 * `spec` yourself if you want them in one list; `expandTest` adds only the ones
 * it finds (flows, params, env vars) and those of the flow files it reads.
 */
export async function expandTest(spec: TestSpec, ctx: ExpandContext): Promise<ExpandedTest> {
  const x = new Expander(spec, ctx);
  const fm = spec.frontmatter;
  const env = ctx.environment ? fm.environments[ctx.environment] : undefined;
  const data = { ...fm.data, ...(env?.data ?? {}) };
  const report = new Reporter(spec.path);
  const values = x.bindData(data, "|", report);

  const params = new Map<string, BoundSegment[]>();
  const given = fm.kind === "flow" ? (ctx.params ?? {}) : {};
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(fm.params, name))
      report.error(
        "FLOW_PARAM_UNKNOWN",
        undefined,
        `Flow ${spec.path} has no param "${name}".`,
        Object.keys(fm.params).length > 0
          ? `Use one of: ${Object.keys(fm.params).join(", ")}.`
          : "Remove it; this flow takes no params.",
        "params",
      );
  }
  for (const [name, fallback] of Object.entries(fm.params)) {
    const value = Object.hasOwn(given, name)
      ? parseTemplate(given[name] as string, undefined, report)
      : fallback;
    if (value)
      params.set(
        name,
        x.bind(value, { data: values, params: new Map() }, `|default.${name}`, report),
      );
    else if (fm.kind === "flow") {
      report.error(
        "FLOW_PARAM_MISSING",
        spec.fields?.[`params.${name}`],
        `Param "${name}" has no default, so this flow cannot run on its own.`,
        `Give it a default (${name}: value), or run it through a test with Use:.`,
        `params.${name}`,
      );
    }
  }
  const bindings: Bindings = { data: values, params };
  const start = env?.start ?? fm.start;
  const out = (map: Map<string, BoundSegment[]>, raws: Record<string, Template | null>) =>
    Object.fromEntries(
      [...map].map(([k, segments]) => [
        k,
        { raw: raws[k]?.raw ?? "", segments, display: displayOf(segments) },
      ]),
    );

  const startBound = start ? x.bound(start, bindings, "start", report) : null;
  x.diagnostics.push(...report.diagnostics);
  await x.body(spec, bindings, [], [], [spec.path]);

  return {
    id: x.testId,
    path: spec.path,
    kind: fm.kind,
    name: fm.name,
    tags: [...fm.tags],
    environment: ctx.environment ?? null,
    start: startBound,
    auth: fm.auth ?? null,
    timeout: env?.timeout ?? fm.timeout ?? null,
    heal: fm.heal ?? null,
    allowDestructive: [...fm.allowDestructive],
    dataset: fm.dataset ?? null,
    setup: fm.setup,
    teardown: fm.teardown,
    data: out(values, data),
    params: out(params, fm.params),
    steps: x.steps,
    guards: x.guards,
    files: x.files,
    diagnostics: sortDiagnostics(dedupe(x.diagnostics)),
  };
}
