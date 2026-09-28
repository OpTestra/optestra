import type { ModelCall } from "@testament/contract";
import { createDecisions } from "@testament/decide";
import {
  type Command,
  checkKey,
  type Fingerprint,
  type Locator,
  RECORDING_EPOCH,
  RECORDING_VERSION,
  type Recording,
  routeOf,
  stepKey,
} from "@testament/recording";
import { type ExpandedTest, expandTest, mapReader, parseTest } from "@testament/spec";
import type {
  ActOptions,
  ActionOutcome,
  CandidatesResult,
  CheckEvaluation,
  ElementFacts,
  InspectResult,
  Observation,
  ObservedElement,
  PageCopy,
  PostState,
  RequestMark,
} from "../target/harness.js";
import { replayAttempt } from "./replay.js";
import type { ReplayEvent, ReplayOptions, ReplaySession } from "./types.js";

// Test support for replay (no browser): a fake page the fake session serves,
// recordings built from test text, and a replay runner that collects events.

export const URL0 = "http://127.0.0.1:4100/login";

export async function expanded(
  body: string,
  frontmatter = "name: T\nstart: /login",
): Promise<ExpandedTest> {
  const text = `---\n${frontmatter}\n---\n\n${body}\n`;
  const { spec } = parseTest(text, "tests/t.test.md");
  return expandTest(spec, { readFile: mapReader({ "tests/t.test.md": text }), seed: "s" });
}

export function facts(role: string, name: string, extra: Partial<ElementFacts> = {}): ElementFacts {
  return {
    role,
    name,
    tag: role === "textbox" ? "input" : "button",
    attributes: { class: "btn" },
    text: role === "textbox" ? "" : name,
    anchorText: "Log in",
    framePath: [],
    box: { x: 100, y: 200, width: 80, height: 40 },
    ...extra,
  };
}

export const role = (r: string, name: string): Locator => ({
  kind: "role",
  role: r,
  name,
  exact: true,
});

export function fingerprint(
  primary: Locator,
  f: ElementFacts,
  fallbacks: Locator[] = [],
): Fingerprint {
  return {
    primary,
    fallbacks,
    role: f.role,
    name: f.name,
    tag: f.tag,
    attributes: f.attributes,
    anchorText: f.anchorText,
    framePath: [],
    box: f.box,
  };
}

export function command(
  action: Command["action"],
  fp: Fingerprint | null,
  expectPost: Command["expectPost"] = { appeared: [{ role: "status", name: "", text: "done" }] },
): Command {
  return {
    action,
    fingerprint: fp,
    expectPost,
    wait: { settledMs: 5, waitedFor: { network: 0, dom: 5, busy: 0 } },
  };
}

/** A recording for `test`: commands per action step (by text), checks per Expect line (by text). */
export function recordingFor(
  test: ExpandedTest,
  steps: Record<string, Command[]>,
  checks: Record<
    string,
    | Recording["checks"][number]["check"]
    | { op: Recording["checks"][number]["check"]; provesNothing: true }
  > = {},
  route = routeOf(URL0),
): Recording {
  return {
    recordingVersion: RECORDING_VERSION,
    testId: test.id,
    testPath: "tests/t.test.md",
    target: "web",
    recordedWith: {
      engineVersion: "0.1.0",
      epoch: RECORDING_EPOCH,
      browser: "chromium",
      device: "desktop",
      environment: "local",
      model: null,
      promptVersion: null,
    },
    updatedAt: new Date(0).toISOString(),
    steps: test.steps
      .filter((s) => steps[s.text])
      .map((s) => ({
        key: stepKey(s.textKey, route),
        textKey: s.textKey,
        route,
        text: s.text,
        kind: "action" as const,
        commands: steps[s.text] as Command[],
        source: "ai" as const,
        recordedAt: new Date(0).toISOString(),
      })),
    checks: test.steps
      .filter((s) => (s.kind === "expect" || s.kind === "soft") && checks[s.text])
      .map((s) => {
        const entry = checks[s.text] as NonNullable<(typeof checks)[string]>;
        const op = "op" in entry ? entry.op : entry;
        return {
          key: checkKey(s.textKey),
          textKey: s.textKey,
          text: s.text,
          soft: s.kind === "soft",
          check: op,
          generatedBy: "rules" as const,
          summary: `checks ${s.text}`,
          sanity: {
            empty: { result: "failed" as const },
            before: { result: "failed" as const },
            provesNothing: "op" in entry,
          },
          recordedAt: new Date(0).toISOString(),
        };
      }),
  };
}

export function post(overrides: Partial<PostState> = {}): PostState {
  return {
    urlBefore: URL0,
    urlAfter: URL0,
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

export interface FakePage {
  /** What each locator (JSON) finds now. */
  locators: Record<string, ElementFacts | "multiple">;
  /** Elements an observe() shows (refs e1…), with their facts. */
  elements?: Array<{ element: ObservedElement; facts: ElementFacts; locator: Locator }>;
  /** What an action does; default: a "done" status appears. */
  effect?: (
    action: unknown,
  ) => Omit<Partial<ActionOutcome>, "post"> & { post?: Partial<PostState> };
  /** Check results; default passed. */
  check?: (op: unknown) => CheckEvaluation;
  url?: string;
  /** Called when the replay settles the page (e.g. to make a late element appear). */
  onSettle?: () => void;
}

/** What a fake session saw of the replay's waits (PERF-0). */
export interface FakeWaits {
  /** The options of each act, in order (undefined: settle with the quiet window). */
  actOptions: (ActOptions | undefined)[];
  /** How often the replay settled the page on its own. */
  settles: number;
}

export function passedEvaluation(fields: Partial<CheckEvaluation> = {}): CheckEvaluation {
  return {
    status: "passed",
    passed: true,
    expected: "x",
    actual: "x",
    ms: 1,
    attempts: 1,
    seen: "s",
    ...fields,
  };
}

export function fakeSession(
  page: FakePage,
): ReplaySession & { acted: unknown[]; waits: FakeWaits } {
  const acted: unknown[] = [];
  const waits: FakeWaits = { actOptions: [], settles: 0 };
  // Like the harness: an act that ended on its effect leaves the page unsettled.
  let unsettled = false;
  const url = page.url ?? URL0;
  const observed = (page.elements ?? []).map((e, i) => ({ ...e.element, ref: `e${i + 1}` }));
  const observation: Observation = {
    untrusted: true,
    url,
    title: "Page",
    observedAt: new Date(0).toISOString(),
    frames: [{ url, parentRef: null }],
    elements: observed,
    refused: [],
    truncated: false,
  };
  return {
    acted,
    waits,
    browserName: "chromium",
    get url() {
      return url;
    },
    observe: async () => observation,
    inspect: async (target): Promise<InspectResult> => {
      const found = page.locators[JSON.stringify(target)];
      if (!found) return { status: "not_found", matches: 0, facts: null };
      if (found === "multiple") return { status: "multiple", matches: 2, facts: null };
      return { status: "ok", matches: 1, facts: found };
    },
    factsOf: async (ref) => {
      const index = Number(ref.slice(1)) - 1;
      return page.elements?.[index]?.facts ?? null;
    },
    candidates: async (ref): Promise<CandidatesResult> => {
      const index = Number(ref.slice(1)) - 1;
      const entry = page.elements?.[index];
      if (!entry) return { status: "not_found", candidates: [], facts: null };
      return {
        status: "ok",
        candidates: [{ locator: entry.locator as never, unique: true, matches: 1 }],
        facts: entry.facts,
      };
    },
    act: async (action, options) => {
      acted.push(action);
      waits.actOptions.push(options);
      const result = page.effect?.(action) ?? {
        post: { changed: true, added: [{ role: "status", name: "", text: "done" }] },
      };
      const after = post(result.post);
      unsettled = Boolean(options?.until?.(after));
      const settle = {
        settledMs: 5,
        timedOut: false,
        waitedFor: { network: 0, dom: 5, busy: 0 },
        inflight: 0,
        ...(unsettled ? { endedBy: "effect" as const } : {}),
      };
      return {
        action,
        status: "ok",
        ms: 1,
        settledMs: 5,
        settle,
        ...result,
        post: after,
      } as ActionOutcome;
    },
    check: async (op) => page.check?.(op) ?? passedEvaluation(),
    screenshot: async () => ({
      status: "ok",
      bytes: new Uint8Array([1]),
      contentType: "image/png",
    }),
    hookRequest: async () => ({ status: "ok", httpStatus: 200 }),
    refusals: () => [],
    pageCopy: async () => ({ url, takenAt: new Date(0).toISOString() }) as unknown as PageCopy,
    requestMark: () => ({ takenAt: new Date(0).toISOString() }) as unknown as RequestMark,
    settle: async () => {
      waits.settles++;
      unsettled = false;
      page.onSettle?.();
      return {
        settledMs: 0,
        timedOut: false,
        waitedFor: { network: 0, dom: 0, busy: 0 },
        inflight: 0,
      };
    },
    get unsettled() {
      return unsettled;
    },
  };
}

let ids = 0;

/** Replays one attempt against a fake session and collects its events. */
export async function replay(
  test: ExpandedTest,
  recording: Recording | undefined,
  session: ReplaySession,
  overrides: Partial<ReplayOptions> = {},
) {
  const events: ReplayEvent[] = [];
  const calls: ModelCall[] = [];
  const result = await replayAttempt({
    test,
    recording,
    session,
    attempt: 1,
    mode: "normal",
    policy: "review",
    decisions: createDecisions(),
    fixerAvailable: false,
    plannerAvailable: false,
    production: false,
    timeoutMs: 60_000,
    checkTimeoutMs: 0,
    emit: (event) => {
      events.push(event);
      if (event.type === "model.called") calls.push(event.call);
    },
    newId: () => `id${++ids}`,
    ...overrides,
  });
  return { result, events, calls };
}
