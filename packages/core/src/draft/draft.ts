import type { Action, ActionOutcome, Observation, PageCopy, Session } from "@testament/browser";
import { renderForModel } from "@testament/browser";
import type { Config } from "@testament/config";
import type { ModelCall } from "@testament/contract";
import {
  type BudgetMeter,
  type ImagePart,
  type Models,
  type TextPart,
  toModelCall,
} from "@testament/models";
import { type TemplateVariable, toTemplate } from "@testament/recording";
import {
  applySafeFixes,
  checkTest,
  DEFAULT_EMAIL_DOMAIN,
  defaultGenerators,
  type FileReader,
  type Finding,
  type GeneratorRegistry,
  mapReader,
  parseTemplate,
  printTest,
  type Step,
  type TestSpec,
  template,
} from "@testament/spec";
import { checkGuards } from "../author/guards.js";
import { compileCheck } from "../checks/compile.js";
import prompt from "./drafter-prompt.json" with { type: "json" };
import { type DraftedAction, labelOf, nameFromSentence, slugOf, stepText } from "./phrasing.js";
import { DRAFT_TOOLS, type DraftToolCall, parseDraftCall } from "./tools.js";

// Drafting a test from one sentence (AUT-7, AGT-1). The planner explores the app
// through the harness (the closed action set, the allowlist, untrusted page
// content, and production-mode guards: exploring never does a destructive
// action), bounded by actions, model calls and time. Every action it does
// becomes a step written by code from the element it used; every expectation it
// proposes is compiled by the rules and checked on the live page before it is
// kept (it must pass now and must not pass on an empty page or before the
// action). The draft is printed with the spec printer and linted with
// checkTest. Nothing is saved here: the caller decides (never silently).

export const DRAFT_PROMPT_VERSION: string = prompt.version;

export interface DraftLimits {
  /** Actions on the page (default 16). */
  actions: number;
  /** Model calls (default 24). */
  modelCalls: number;
  /** Invalid, refused or failed tool calls in a row (default 3). */
  consecutiveFailures: number;
  /** Wall-clock time for the exploration, ms (default 180 s). */
  timeMs: number;
  /** Expectations kept (default 8). */
  expectations: number;
}

export const DRAFT_LIMITS: DraftLimits = {
  actions: 16,
  modelCalls: 24,
  consecutiveFailures: 3,
  timeMs: 180_000,
  expectations: 8,
};

/** The harness calls drafting uses. A LOOP-0 Session satisfies it. */
export type DraftSession = Pick<
  Session,
  "observe" | "act" | "screenshot" | "url" | "check" | "pageCopy"
>;

export interface DraftOptions {
  session: DraftSession;
  models: Models;
  budget?: BudgetMeter | undefined;
  /** Where the test starts: a path on the app or an allowed URL (default "/"). */
  start?: string | undefined;
  /** Project-relative path the draft is checked (and suggested) under. Default `<testsDir>/<slug>.test.md`. */
  path?: string | undefined;
  /** The path for the draft's name, when `path` isn't given (e.g. to avoid taken files). */
  pathFor?: ((name: string) => string) | undefined;
  /** Default "tests". */
  testsDir?: string | undefined;
  /** Secrets the drafter may type as `{{secret.NAME}}`, with their descriptions (never values). */
  secrets?: Readonly<Record<string, string | undefined>> | undefined;
  /** Extra lines for the prompt's context (values the project's other tests use). */
  hints?: readonly string[] | undefined;
  /** For lint and generated values. */
  config?: Config | undefined;
  /** Reads flow files while linting (default: none). */
  readFile?: FileReader | undefined;
  generators?: GeneratorRegistry | undefined;
  /** Domain of `{{unique.email}}` while exploring (default example.test). */
  emailDomain?: string | undefined;
  /** Seed of the values generated while exploring. */
  seed?: string | undefined;
  limits?: Partial<DraftLimits> | undefined;
  signal?: AbortSignal | undefined;
  tags?: Record<string, string> | undefined;
  onEvent?: ((event: DraftEvent) => void) | undefined;
  now?: () => number;
}

/** One line of the draft, in order. */
export type DraftItem =
  | { kind: "action"; text: string }
  | { kind: "expect"; text: string; check: { summary: string; rule?: string } };

export type DraftEvent =
  | { type: "item"; item: DraftItem }
  | { type: "refused"; tool: string; text: string; message: string };

export type DraftStatus =
  /** The model said the test shows the goal, with at least one kept expectation. */
  | "drafted"
  /** A limit, the time or a refused destructive action ended the exploration: a partial draft. */
  | "incomplete"
  /** The model found the goal can't be done on this app. */
  | "impossible"
  /** Exploring couldn't go on (no AI, budget, the app unreachable). */
  | "stopped";

export interface DraftResult {
  status: DraftStatus;
  /** limit_reached, timeout, destructive, budget_exceeded, ai_unavailable, app_unreachable, … */
  reason?: string;
  message?: string;
  sentence: string;
  name: string;
  /** Project-relative, where it would be saved. */
  path: string;
  /** The `.test.md` text: printed by the spec printer, safe lint fixes applied. */
  text: string;
  spec: TestSpec;
  /** Lint and parse findings left (checkTest). */
  findings: Finding[];
  /** No error or warning findings. */
  lintClean: boolean;
  /** Safe lint fixes applied to the draft. */
  fixed: string[];
  items: DraftItem[];
  /** What the reviewer should know: refused expectations, unexplored parts. */
  notes: string[];
  modelCalls: ModelCall[];
  totals: {
    aiCalls: number;
    tokens: { input: number; output: number; cached: number; cacheWrite: number };
    costUsd: number;
    unknownCostCalls: number;
    billing: "api" | "subscription" | "mixed" | null;
  };
  promptVersion: string;
  actions: number;
  durationMs: number;
}

function summarize(outcome: ActionOutcome): string {
  const parts: string[] = [outcome.status + (outcome.reason ? ` (${outcome.reason})` : "")];
  if (outcome.message) parts.push(outcome.message);
  const post = outcome.post;
  if (post.urlAfter !== post.urlBefore) parts.push(`page changed to ${post.urlAfter}`);
  const shown = (list: typeof post.added) =>
    list
      .slice(0, 6)
      .map(
        (e) =>
          `${e.role}${e.name ? ` "${e.name}"` : ""}${e.text ? `: "${e.text.slice(0, 60)}"` : ""}`,
      )
      .join(", ");
  if (post.added.length) parts.push(`appeared: ${shown(post.added)}`);
  if (post.removed.length) parts.push(`removed: ${shown(post.removed)}`);
  if (outcome.status === "ok" && !post.changed) parts.push("no visible change");
  return parts.join("; ");
}

function portableUrl(url: string, current: string): string {
  try {
    const target = new URL(url, current);
    const here = new URL(current);
    if (target.origin === here.origin) return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    // keep as given
  }
  return url;
}

/** Values generated while exploring: `{{unique.email}}` becomes `data.email` in the draft. */
class DraftData {
  readonly entries = new Map<string, { ref: string; value: string }>();
  readonly #byRef = new Map<string, string>();
  constructor(
    readonly generators: GeneratorRegistry,
    readonly seed: string,
    readonly emailDomain: string,
  ) {}

  /** The data key for a generator reference, created on first use. */
  keyFor(ns: string, member: string): string | undefined {
    const ref = `${ns}.${member}`;
    const known = this.#byRef.get(ref);
    if (known) return known;
    const value = this.generators.generate(ns, member, this.seed, ref, {
      emailDomain: this.emailDomain,
    });
    if (value === undefined) return undefined;
    let key = member.replace(/[^A-Za-z0-9]/g, "") || "value";
    for (let n = 2; this.entries.has(key); n++) key = `${member}${n}`;
    this.entries.set(key, { ref, value });
    this.#byRef.set(ref, key);
    return key;
  }

  get variables(): TemplateVariable[] {
    return [...this.entries].map(([key, entry]) => ({ ref: `data.${key}`, value: entry.value }));
  }

  get values(): Record<string, string> {
    return Object.fromEntries([...this.entries].map(([key, e]) => [`data.${key}`, e.value]));
  }
}

type Typed =
  | { ok: true; harness: string | { secret: string }; text: string }
  | { ok: false; error: string };

/** What the model typed: the harness value and the step's template. */
function resolveTyped(
  typed: string,
  data: DraftData,
  secrets: ReadonlySet<string>,
  allowSecret: boolean,
): Typed {
  const parsed = parseTemplate(typed);
  const vars = parsed.segments.filter((s) => s.kind === "var");
  const secret = vars.find((s) => s.ns === "secret");
  if (secret) {
    if (!allowSecret) return { ok: false, error: "Secrets can only be typed into fields (fill)." };
    if (vars.length !== 1 || parsed.segments.length !== 1)
      return {
        ok: false,
        error: "A secret must be typed on its own, as the whole value: {{secret.NAME}}.",
      };
    if (!secrets.has(secret.name))
      return {
        ok: false,
        error: `There is no secret {{secret.${secret.name}}}. Known: ${[...secrets].map((s) => `{{secret.${s}}}`).join(", ") || "none"}.`,
      };
    return { ok: true, harness: { secret: secret.name }, text: `{{secret.${secret.name}}}` };
  }
  let harness = "";
  let text = "";
  for (const segment of parsed.segments) {
    if (segment.kind === "text") {
      harness += segment.text;
      text += segment.text;
      continue;
    }
    if (segment.ns === "unique" || segment.ns === "faker") {
      const key = data.keyFor(segment.ns, segment.name);
      if (!key)
        return {
          ok: false,
          error: `There is no generated value {{${segment.ns}.${segment.name}}}.`,
        };
      harness += data.entries.get(key)?.value ?? "";
      text += `{{data.${key}}}`;
      continue;
    }
    if (segment.ns === "data" && data.entries.has(segment.name)) {
      harness += data.entries.get(segment.name)?.value ?? "";
      text += `{{data.${segment.name}}}`;
      continue;
    }
    return {
      ok: false,
      error: `{{${segment.ns}.${segment.name}}} has no value here. Type the text, a {{secret.NAME}}, or {{unique.email}}.`,
    };
  }
  // A generated value typed as plain text still becomes its reference.
  return { ok: true, harness, text: toTemplate(text, data.variables) };
}

type Planned =
  | { action: Action; drafted: DraftedAction | null; description: string }
  | { error: string; description: string; destructive?: boolean };

function plan(
  call: Exclude<DraftToolCall, { name: "look" | "expect" | "draft_done" | "draft_impossible" }>,
  observation: Observation,
  data: DraftData,
  secrets: ReadonlySet<string>,
  currentUrl: string,
): Planned {
  const input = call.input as { ref?: string };
  const element = input.ref ? observation.elements.find((e) => e.ref === input.ref) : undefined;
  const label = labelOf(element);
  const description = `${call.name}${input.ref ? ` ${input.ref}${element ? ` (${element.role}${label ? ` "${label}"` : ""})` : ""}` : ""}`;
  if (input.ref && !element)
    return { error: `There is no element ${input.ref} in the current snapshot.`, description };
  const ref = input.ref ? { ref: input.ref } : undefined;

  const decision = checkGuards(
    {
      type: call.name === "wait_for" ? "waitFor" : call.name,
      ...(element
        ? {
            target: {
              role: element.role,
              name: element.name,
              ...(element.text !== undefined ? { text: element.text } : {}),
            },
          }
        : {}),
      ...(call.name === "goto" ? { url: call.input.url } : {}),
    },
    // Exploring is always production mode (SAF-4): never a destructive action.
    { guards: [], production: true, allowDestructive: [] },
  );
  if (!decision.allowed) {
    const message =
      decision.kind === "destructive"
        ? `Refused: this looks like a destructive action (${decision.intent}). Exploring never does destructive actions. Finish the test without it (draft_done), or call draft_impossible.`
        : decision.message;
    return { error: message, description, destructive: decision.kind === "destructive" };
  }

  switch (call.name) {
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
    case "hover":
      return {
        action: { type: call.name, target: ref as { ref: string } },
        drafted: { type: call.name, element: element as NonNullable<typeof element> },
        description,
      };
    case "fill": {
      const typed = resolveTyped(call.input.value, data, secrets, true);
      if (!typed.ok) return { error: typed.error, description };
      return {
        action: { type: "fill", target: ref as { ref: string }, value: typed.harness },
        drafted: {
          type: "fill",
          element: element as NonNullable<typeof element>,
          value: typed.text,
        },
        description: `${description} ${JSON.stringify(typed.text)}`,
      };
    }
    case "select": {
      const typed = resolveTyped(call.input.option, data, secrets, false);
      if (!typed.ok || typeof typed.harness !== "string")
        return { error: typed.ok ? "Options are plain text." : typed.error, description };
      return {
        action: { type: "select", target: ref as { ref: string }, option: typed.harness },
        drafted: {
          type: "select",
          element: element as NonNullable<typeof element>,
          option: typed.text,
        },
        description: `${description} ${JSON.stringify(typed.text)}`,
      };
    }
    case "press":
      return {
        action: { type: "press", key: call.input.key, ...(ref ? { target: ref } : {}) },
        drafted: { type: "press", key: call.input.key, element },
        description: `press ${call.input.key}${input.ref ? ` in ${description.slice("press ".length)}` : ""}`,
      };
    case "scroll":
      return {
        action: {
          type: "scroll",
          ...(ref ? { target: ref } : {}),
          ...(call.input.direction ? { direction: call.input.direction } : {}),
        },
        drafted: null,
        description,
      };
    case "upload":
      return {
        action: { type: "upload", target: ref as { ref: string }, files: call.input.file },
        drafted: {
          type: "upload",
          element: element as NonNullable<typeof element>,
          file: call.input.file,
        },
        description: `${description} ${JSON.stringify(call.input.file)}`,
      };
    case "goto": {
      const typed = resolveTyped(call.input.url, data, secrets, false);
      if (!typed.ok || typeof typed.harness !== "string")
        return { error: typed.ok ? "Open pages by their address." : typed.error, description };
      return {
        action: { type: "goto", url: typed.harness },
        drafted: { type: "goto", url: portableUrl(typed.text, currentUrl) },
        description: `goto ${JSON.stringify(typed.text)}`,
      };
    }
    case "back":
    case "reload":
      return { action: { type: call.name }, drafted: { type: call.name }, description };
    case "wait_for": {
      const timeoutMs = call.input.seconds ? Math.round(call.input.seconds * 1000) : undefined;
      return {
        action: {
          type: "waitFor",
          ...(call.input.text !== undefined ? { text: call.input.text } : {}),
          ...(ref ? { target: ref } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
        drafted: null,
        description,
      };
    }
  }
}

function describeContext(options: DraftOptions, data: DraftData): string {
  const lines: string[] = [];
  for (const [name, description] of Object.entries(options.secrets ?? {}))
    lines.push(
      `- secret {{secret.${name}}}${description ? `: ${description}` : ""} (type it exactly as {{secret.${name}}})`,
    );
  for (const hint of options.hints ?? []) lines.push(`- ${hint}`);
  for (const [key, entry] of data.entries)
    lines.push(`- {{${entry.ref}}} is typed as {{data.${key}}} = ${JSON.stringify(entry.value)}`);
  return lines.length ? lines.join("\n") : "(nothing)";
}

function describeDraft(items: readonly DraftItem[]): string {
  if (items.length === 0) return "(no steps yet)";
  return items
    .map((item, i) => `${i + 1}. ${item.kind === "expect" ? "Expect: " : ""}${item.text}`)
    .join("\n");
}

function billingOf(calls: readonly ModelCall[]): DraftResult["totals"]["billing"] {
  if (calls.length === 0) return null;
  const subscription = calls.filter((c) => c.billing === "subscription").length;
  return subscription === 0 ? "api" : subscription === calls.length ? "subscription" : "mixed";
}

/** The draft as a spec, printed, fixed where it's safe, and linted. */
export async function finishDraft(input: {
  name: string;
  start: string;
  items: readonly DraftItem[];
  data: Readonly<Record<string, string>>;
  path: string;
  config?: Config | undefined;
  readFile?: FileReader | undefined;
}): Promise<Pick<DraftResult, "spec" | "text" | "findings" | "lintClean" | "fixed">> {
  const body: Step[] = input.items.map((item, i) => ({
    type: "step",
    kind: item.kind === "expect" ? "expect" : "action",
    number: i + 1,
    text: template(item.text),
  }));
  const spec: TestSpec = {
    path: input.path,
    frontmatter: {
      name: input.name,
      kind: "test",
      tags: [],
      start: template(input.start),
      data: Object.fromEntries(
        Object.entries(input.data).map(([key, ref]) => [key, template(`{{${ref}}}`)]),
      ),
      params: {},
      allowDestructive: [],
      setup: [],
      teardown: [],
      environments: {},
      extra: {},
    },
    body,
  };
  const readFile = input.readFile ?? mapReader({});
  const check = async (text: string) =>
    (await checkTest(text, input.path, { readFile, config: input.config })).findings;
  const fixedText = await applySafeFixes(printTest(spec), check);
  const checked = await checkTest(fixedText.text, input.path, {
    readFile,
    config: input.config,
  });
  return {
    spec: checked.spec,
    text: fixedText.text,
    findings: checked.findings,
    lintClean: !checked.findings.some((f) => f.severity === "error" || f.severity === "warning"),
    fixed: fixedText.applied.map((a) => a.title),
  };
}

/** Explores the app from `start` and drafts a test for `sentence`. Saves nothing. */
export async function exploreDraft(sentence: string, options: DraftOptions): Promise<DraftResult> {
  const now = options.now ?? Date.now;
  const began = now();
  const limits = { ...DRAFT_LIMITS, ...options.limits };
  const session = options.session;
  const secrets = new Set(Object.keys(options.secrets ?? {}));
  const data = new DraftData(
    options.generators ?? defaultGenerators,
    options.seed ?? `draft-${began.toString(36)}`,
    options.emailDomain ?? DEFAULT_EMAIL_DOMAIN,
  );
  const start = options.start?.trim() || "/";
  const items: DraftItem[] = [];
  const notes: string[] = [];
  const history: string[] = [];
  const modelCalls: ModelCall[] = [];
  const note = (line: string) => history.push(`${history.length + 1}. ${line}`);
  const timer = AbortSignal.timeout(limits.timeMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;

  let status: DraftStatus = "incomplete";
  let reason: string | undefined;
  let message: string | undefined;
  let name = "";
  let actions = 0;
  let calls = 0;
  let failures = 0;
  let wantShot = false;
  const nudged = new Set<string>();
  let before: PageCopy | undefined;

  const refuse = (tool: string, text: string, why: string) => {
    options.onEvent?.({ type: "refused", tool, text, message: why });
  };
  const add = (item: DraftItem) => {
    items.push(item);
    options.onEvent?.({ type: "item", item });
  };

  // Exploring: every way out sets the status, reason and message.
  const explore = async (): Promise<void> => {
    const opened = await session.act({ type: "goto", url: start });
    if (opened.status !== "ok") {
      status = "stopped";
      reason = opened.reason === "disallowed_domain" ? "disallowed_domain" : "app_unreachable";
      message = `The start page ${start} could not be opened: ${opened.message ?? opened.status}.`;
      return;
    }
    note(`opened ${start} → ${summarize(opened)}`);

    for (;;) {
      if (signal.aborted) {
        reason = options.signal?.aborted ? "aborted" : "timeout";
        message = `Exploring stopped after ${Math.round((now() - began) / 1000)} s (the limit is ${Math.round(limits.timeMs / 1000)} s).`;
        return;
      }
      if (calls >= limits.modelCalls) {
        reason = "limit_reached";
        message = `Exploring used its ${limits.modelCalls} model calls.`;
        return;
      }
      const observation = await session.observe();
      const content: Array<TextPart | ImagePart> = [
        {
          type: "text",
          text: prompt.turn
            .replace("{sentence}", sentence)
            .replace("{context}", describeContext(options, data))
            .replace("{draft}", describeDraft(items))
            .replace("{history}", history.length ? history.slice(-20).join("\n") : "(nothing yet)")
            .replace("{page}", renderForModel(observation)),
        },
      ];
      if (wantShot || observation.truncated) {
        const shot = await session.screenshot({ forModel: true });
        if (shot.status === "ok")
          content.push({ type: "image", data: shot.bytes, mediaType: shot.contentType });
      }
      wantShot = false;
      const reply = await options.models.complete("planner", {
        system: prompt.system,
        messages: [{ role: "user", content }],
        tools: DRAFT_TOOLS,
        maxOutputTokens: 600,
        temperature: 0,
        cache: true,
        signal,
        ...(options.budget ? { budgets: [options.budget] } : {}),
        tags: { ...options.tags, task: "draft" },
      });
      calls++;
      modelCalls.push(toModelCall(reply.record));
      if (!reply.ok) {
        if (signal.aborted) continue;
        status = "stopped";
        reason = reply.reason === "budget_exceeded" ? "budget_exceeded" : "ai_unavailable";
        message = `${reply.message} ${reply.fix}`.trim();
        return;
      }
      if (reply.toolCalls.length === 0) {
        note("(you replied without calling a tool; always call the tools)");
        if (++failures >= limits.consecutiveFailures) {
          reason = "limit_reached";
          message = "The model kept answering without using the tools.";
          return;
        }
        continue;
      }

      for (const raw of reply.toolCalls) {
        const parsed = parseDraftCall(raw.name, raw.input);
        if (!parsed.ok) {
          note(`${raw.name}: ${parsed.error}`);
          if (++failures >= limits.consecutiveFailures) {
            reason = "limit_reached";
            message = `${limits.consecutiveFailures} invalid or refused tool calls in a row. Last: ${parsed.error}`;
            return;
          }
          break;
        }
        const call = parsed.call;
        if (call.name === "look") {
          wantShot = true;
          note("look: a screenshot comes with the next snapshot");
          break;
        }
        if (call.name === "draft_impossible") {
          status = "impossible";
          reason = "impossible";
          message = call.input.reason.trim().slice(0, 300);
          return;
        }
        if (call.name === "draft_done") {
          const expects = items.filter((i) => i.kind === "expect").length;
          const nudge =
            expects === 0
              ? "nudge_no_expect"
              : items.at(-1)?.kind === "action"
                ? "nudge_last_action"
                : undefined;
          if (nudge && !nudged.has(nudge)) {
            nudged.add(nudge);
            note(prompt[nudge]);
            break;
          }
          name = call.input.name.replace(/\s+/g, " ").trim().slice(0, 100);
          status = expects > 0 ? "drafted" : "incomplete";
          if (expects === 0) {
            reason = "no_expectations";
            message = "The draft has no expectation that holds on the page.";
          }
          return;
        }
        if (call.name === "expect") {
          const text = toTemplate(
            call.input.text
              .replace(/^\s*(expect|soft)\s*:\s*/i, "")
              .replace(/\s+/g, " ")
              .trim(),
            data.variables,
          );
          const refused = (why: string) => {
            note(`expect ${JSON.stringify(text)}: refused: ${why}`);
            refuse("expect", text, why);
            failures++;
          };
          if (items.filter((i) => i.kind === "expect").length >= limits.expectations) {
            refused(`the draft already has ${limits.expectations} expectations; call draft_done.`);
          } else if (items.some((i) => i.kind === "expect" && i.text === text)) {
            refused("the test already has this expectation.");
          } else {
            const compiled = await compileCheck(
              { text, soft: false },
              { session, values: data.values, before, timeoutMs: 3_000, signal },
            );
            if (compiled.op.type === "pending") {
              refused(
                `no check can be made from it (${compiled.problem ?? "no rule matches"}). Use one of the phrasings from the rules, quoting visible text.`,
              );
            } else if (compiled.problem) {
              refused(compiled.problem);
            } else if (compiled.evaluation?.passed !== true) {
              refused(
                `it doesn't hold on the page now (expected ${JSON.stringify(compiled.evaluation?.expected ?? null)}, saw ${JSON.stringify(compiled.evaluation?.actual ?? null)}).`,
              );
            } else {
              failures = 0;
              add({
                kind: "expect",
                text,
                check: {
                  summary: compiled.summary,
                  ...(compiled.rule ? { rule: compiled.rule } : {}),
                },
              });
              note(`expect ${JSON.stringify(text)}: kept (${compiled.summary})`);
              continue;
            }
          }
          if (failures >= limits.consecutiveFailures) {
            reason = "limit_reached";
            message = `${limits.consecutiveFailures} refused or failed tool calls in a row.`;
            return;
          }
          continue;
        }

        // An action on the page.
        if (actions >= limits.actions) {
          reason = "limit_reached";
          message = `Exploring used its ${limits.actions} actions.`;
          return;
        }
        const planned = plan(call, observation, data, secrets, session.url);
        if ("error" in planned) {
          note(`${planned.description}: ${planned.error}`);
          refuse(call.name, planned.description, planned.error);
          if (planned.destructive && !notes.some((n) => n.startsWith("Exploring refused")))
            notes.push(
              `Exploring refused a destructive action (${planned.description}), so the draft doesn't do it. Add that step yourself, with allowDestructive, if the test needs it.`,
            );
          if (++failures >= limits.consecutiveFailures) {
            reason = planned.destructive ? "destructive" : "limit_reached";
            message = `${limits.consecutiveFailures} refused or failed actions in a row. Last: ${planned.error}`;
            return;
          }
          break;
        }
        before = await session.pageCopy();
        actions++;
        const outcome = await session.act(planned.action);
        note(
          `${planned.description} → ${summarize(outcome)}${planned.drafted ? "" : " (not written as a step)"}`,
        );
        if (outcome.status !== "ok") {
          if (++failures >= limits.consecutiveFailures) {
            reason = "limit_reached";
            message = `${limits.consecutiveFailures} failed actions in a row. Last: ${outcome.message ?? outcome.status}`;
            return;
          }
          break;
        }
        failures = 0;
        if (planned.drafted) add({ kind: "action", text: stepText(planned.drafted) });
        // The page moved on: the rest of this reply's refs may be stale.
        if (outcome.post.urlAfter !== outcome.post.urlBefore) break;
      }
    }
  };
  await explore();

  if (status === "incomplete" && reason !== "no_expectations" && items.length > 0)
    notes.push(
      `The exploration didn't finish (${reason ?? "stopped"}): check that the draft reaches the goal.`,
    );
  if (!name) name = nameFromSentence(sentence);
  return assembleDraft({
    status,
    reason,
    message,
    sentence,
    name,
    path:
      options.path ??
      options.pathFor?.(name) ??
      `${options.testsDir ?? "tests"}/${slugOf(name)}.test.md`,
    start,
    items,
    data: Object.fromEntries([...data.entries].map(([key, e]) => [key, e.ref])),
    notes,
    modelCalls,
    actions,
    durationMs: now() - began,
    config: options.config,
    readFile: options.readFile,
  });
}

/** A DraftResult from what exploring found: printed, fixed, linted, with its totals. */
export async function assembleDraft(input: {
  status: DraftStatus;
  reason?: string | undefined;
  message?: string | undefined;
  sentence: string;
  name: string;
  path: string;
  start: string;
  items: DraftItem[];
  /** data key → generator reference, e.g. email → unique.email. */
  data: Readonly<Record<string, string>>;
  notes: string[];
  modelCalls: ModelCall[];
  actions: number;
  durationMs: number;
  config?: Config | undefined;
  readFile?: FileReader | undefined;
}): Promise<DraftResult> {
  const { modelCalls, notes } = input;
  const finished = await finishDraft(input);
  for (const finding of finished.findings.filter(
    (f) => f.severity === "error" || f.severity === "warning",
  ))
    notes.push(
      `Lint: ${finding.rule ?? finding.code}: ${finding.message}${finding.range ? ` (line ${finding.range.start.line})` : ""}`,
    );
  return {
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.message ? { message: input.message } : {}),
    sentence: input.sentence,
    name: input.name,
    path: input.path,
    ...finished,
    items: input.items,
    notes,
    modelCalls,
    totals: {
      aiCalls: modelCalls.length,
      tokens: {
        input: modelCalls.reduce((s, c) => s + c.tokens.input, 0),
        output: modelCalls.reduce((s, c) => s + c.tokens.output, 0),
        cached: modelCalls.reduce((s, c) => s + c.tokens.cached, 0),
        cacheWrite: modelCalls.reduce((s, c) => s + c.tokens.cacheWrite, 0),
      },
      costUsd: modelCalls.reduce((s, c) => s + (c.costUsd ?? 0), 0),
      unknownCostCalls: modelCalls.filter((c) => c.costUsd === null).length,
      billing: billingOf(modelCalls),
    },
    promptVersion: DRAFT_PROMPT_VERSION,
    actions: input.actions,
    durationMs: input.durationMs,
  };
}
