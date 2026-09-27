import type {
  ActionOutcome,
  CandidatesResult,
  CheckEvaluation,
  CheckOptions,
  PageCopy,
  Observation,
  ObservedElement,
  PostState,
} from "@testament/browser";
import { type Config, resolveConfig } from "@testament/config";
import { memorySource, Redactor } from "@testament/config/node";
import { BudgetMeter, createModels, type Models } from "@testament/models";
import { type ScriptedCall, type ScriptedReply, scriptedModel } from "@testament/models/testing";
import type { AuthorSession } from "./types.js";

// Test support for the author: a models client backed by a scripted model, a
// scripted "agent" that reads the page from the prompt, and a fake session.

export function modelsConfig(baseUrl = "http://127.0.0.1:4100"): Config {
  const result = resolveConfig({
    project: {
      version: 1,
      project: { name: "T", target: "web" },
      environments: { local: { baseUrl } },
      models: {
        providers: {
          a: { kind: "openai-compatible", baseUrl: "https://a.test/v1", keySecret: "A_KEY" },
        },
        roles: {
          planner: [{ provider: "a", model: "claude-sonnet-5" }],
          fixer: [{ provider: "a", model: "claude-sonnet-5" }],
        },
      },
    },
    env: {},
  });
  if (result.diagnostics.some((d) => d.severity === "error"))
    throw new Error(JSON.stringify(result.diagnostics));
  return result.config;
}

/** A real models client whose planner is `script`. Returns the calls for prompt checks. */
export function scriptedModels(
  script: (call: ScriptedCall, index: number) => ScriptedReply,
  options: { cap?: number } = {},
) {
  const scripted = scriptedModel(script);
  const budget = new BudgetMeter("run", options.cap ?? null);
  const models: Models = createModels({
    config: modelsConfig(),
    sources: [memorySource({ A_KEY: "test-key-0000" }, {}, { redactor: new Redactor() })],
    languageModel: scripted.languageModel,
    budgets: [budget],
    backoffMs: 1,
  });
  return { models, calls: scripted.calls, budget };
}

/** All text the model was sent in one call (system + user messages). */
export function promptText(call: ScriptedCall): string {
  const parts: string[] = [];
  for (const message of call.prompt as Array<{ role: string; content: unknown }>) {
    if (typeof message.content === "string") parts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type: string; text?: string }>) {
        if (part.type === "text" && part.text) parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

/** The ref of `role "name"` in the rendered page of a prompt. */
export function refIn(text: string, role: string, name: string | RegExp): string {
  for (const match of text.matchAll(/- (\w+) "((?:[^"\\]|\\.)*)" \[(e\d+)\]/g)) {
    const [, r, n, ref] = match;
    if (r === role && (typeof name === "string" ? n === name : name.test(n ?? "")))
      return ref as string;
  }
  throw new Error(`no ${role} "${name}" in the prompt:\n${text}`);
}

export type Target = { role: string; name: string | RegExp };
export type PlannedCall = { name: string; input?: Record<string, unknown>; on?: Target };

/**
 * A scripted agent: for the current step (matched by regex on the step line),
 * the first call performs `plan(page)`, later calls say step_done. Refs are
 * looked up by role and name in the page the model was sent.
 */
export function agentScript(
  plans: Array<[RegExp, PlannedCall[] | ((page: string, turn: number) => PlannedCall[] | "done")]>,
) {
  return (call: ScriptedCall): ScriptedReply => {
    const text = promptText(call);
    const stepLine = /Current step [^:]*: (.*)/.exec(text)?.[1] ?? "";
    const history = /Done so far in this step:\n([\s\S]*?)\n\nCurrent page:/.exec(text)?.[1] ?? "";
    const turn = history.trim() === "(nothing yet)" ? 0 : history.trim().split("\n").length;
    const entry = plans.find(([pattern]) => pattern.test(stepLine));
    if (!entry)
      return {
        toolCalls: [{ name: "step_impossible", input: { reason: `no plan for ${stepLine}` } }],
      };
    const planned =
      typeof entry[1] === "function" ? entry[1](text, turn) : turn === 0 ? entry[1] : "done";
    if (planned === "done")
      return { toolCalls: [{ name: "step_done", input: { visible_effect: "done" } }] };
    return {
      toolCalls: planned.map((p) => ({
        name: p.name,
        input: { ...(p.on ? { ref: refIn(text, p.on.role, p.on.name) } : {}), ...p.input },
      })),
    };
  };
}

// ── A fake session (no browser) ──────────────────────────────────────────────

export function element(
  ref: string,
  role: string,
  name: string,
  extra: Partial<ObservedElement> = {},
): ObservedElement {
  return { ref, role, name, depth: 0, states: {}, interactive: true, frame: 0, ...extra };
}

export function post(overrides: Partial<PostState> = {}): PostState {
  return {
    urlBefore: "http://127.0.0.1:4100/login",
    urlAfter: "http://127.0.0.1:4100/login",
    added: [],
    removed: [],
    requests: [],
    dialogs: [],
    popups: [],
    refused: [],
    changed: false,
    reordered: false,
    ...overrides,
  };
}

export interface FakeSession extends AuthorSession {
  acted: unknown[];
  checked: Array<{ op: unknown; options: CheckOptions | undefined }>;
}

/** A check result for fake sessions. */
export function evaluation(
  passed: boolean,
  fields: Partial<CheckEvaluation> = {},
): CheckEvaluation {
  return {
    status: passed ? "passed" : "failed",
    passed,
    expected: null,
    actual: null,
    ms: 1,
    attempts: 1,
    matched: passed ? 1 : 0,
    seen: passed ? "seen-pass" : "seen-fail",
    ...fields,
  };
}

/** A session over a fixed page; `effect` decides each action's post-state. */
export function fakeSession(
  elements: ObservedElement[],
  effect: (action: {
    type: string;
  }) => Omit<Partial<ActionOutcome>, "post"> & { post?: Partial<PostState> } = () => ({
    post: { changed: true, added: [{ role: "status", name: "", text: "done" }] },
  }),
  checker: (op: unknown, options: CheckOptions | undefined) => CheckEvaluation = (_op, options) =>
    evaluation(options?.on === undefined || options.on === "page"),
): FakeSession {
  const url = "http://127.0.0.1:4100/login";
  const observation: Observation = {
    untrusted: true,
    url,
    title: "Log in",
    observedAt: new Date(0).toISOString(),
    frames: [{ url, parentRef: null }],
    elements,
    refused: [],
    truncated: false,
  };
  const acted: unknown[] = [];
  const checked: FakeSession["checked"] = [];
  return {
    acted,
    checked,
    check: async (op, options) => {
      checked.push({ op, options });
      return checker(op, options);
    },
    pageCopy: async () => ({ url, takenAt: new Date(0).toISOString() }) as unknown as PageCopy,
    browserName: "chromium",
    get url() {
      return url;
    },
    observe: async () => observation,
    act: async (action) => {
      acted.push(action);
      const result = effect(action);
      const settle = {
        settledMs: 5,
        timedOut: false,
        waitedFor: { network: 0, dom: 5, busy: 0 },
        inflight: 0,
      };
      return {
        action,
        status: "ok",
        ms: 1,
        settledMs: 5,
        settle,
        ...result,
        post: post(result.post),
      } as ActionOutcome;
    },
    candidates: async (ref): Promise<CandidatesResult> => {
      const found = elements.find((e) => e.ref === ref);
      if (!found) return { status: "not_found", candidates: [], facts: null };
      return {
        status: "ok",
        candidates: [
          {
            locator: { kind: "role", role: found.role, name: found.name, exact: true },
            unique: true,
            matches: 1,
          },
          { locator: { kind: "css", selector: `#${ref}` }, unique: true, matches: 1 },
        ],
        facts: {
          role: found.role,
          name: found.name,
          tag: "input",
          attributes: { id: ref },
          text: "",
          anchorText: "Log in",
          framePath: [],
          box: { x: 0, y: 0, width: 10, height: 10 },
        },
      };
    },
    screenshot: async () => ({
      status: "ok",
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    }),
    hookRequest: async () => ({ status: "ok", httpStatus: 200 }),
    refusals: () => [],
  };
}
