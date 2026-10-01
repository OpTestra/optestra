import { createSecretValue } from "@optestra/config/node";
import type { StepResult } from "@optestra/contract";
import { describe, expect, it } from "vitest";
import { agentScript, scriptedModels } from "../author/test-kit.test-support.js";
import {
  command,
  expanded,
  facts,
  fakeSession,
  fingerprint,
  passedEvaluation,
  recordingFor,
  replay,
  role,
} from "./test-kit.test-support.js";
import { decideVerdict } from "./verdict.js";

createSecretValue("SHOP_PASSWORD", "planted-7d1e-secret", { domains: ["127.0.0.1"] });

const LOGIN = 'Click "Log in"';
const HEADING = {
  type: "text",
  target: { kind: "role", role: "heading" },
  match: "equals",
  value: "Dashboard",
} as const;
const button = facts("button", "Log in");
const primary = role("button", "Log in");
const loc = (l: unknown) => JSON.stringify(l);
/** What was done after opening the start page. */
const actions = (session: { acted: unknown[] }) =>
  session.acted.filter((a) => (a as { type: string }).type !== "goto");

async function loginTest() {
  return expanded(`1. ${LOGIN}\n2. Expect: the page heading is "Dashboard"`);
}

describe("replay (no browser)", () => {
  it("replays an unchanged app with zero model calls and passes on fresh checks", async () => {
    const test = await loginTest();
    const recording = recordingFor(
      test,
      { [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))] },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const session = fakeSession({ locators: { [loc(primary)]: button } });
    const { models, calls } = scriptedModels(() => ({ text: "should not be called" }));
    const { result, calls: emitted } = await replay(test, recording, session, {
      models,
      plannerAvailable: true,
      fixerAvailable: true,
    });
    expect(calls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(result.status).toBe("passed");
    expect(result.steps.map((s) => [s.status, s.recovery])).toEqual([
      ["passed", "replay"],
      ["passed", "none"],
    ]);
    expect(result.steps[0]?.postState?.status).toBe("verified");
    expect(result.checks).toMatchObject([{ passed: true, soft: false, kind: "text" }]);
    expect(decideVerdict([result]).verdict).toBe("passed");
  });

  it("heals with a stored fallback locator that finds the same element (no AI), as a pending proposal", async () => {
    const test = await loginTest();
    const fallback = { kind: "css", selector: "#login" } as const;
    const recording = recordingFor(
      test,
      {
        [LOGIN]: [
          command({ type: "click", target: primary }, fingerprint(primary, button, [fallback])),
        ],
      },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const session = fakeSession({
      locators: { [loc(fallback)]: { ...button, attributes: { class: "button--main" } } },
    });
    const { result } = await replay(test, recording, session);
    expect(result.status).toBe("passed");
    expect(result.heals).toHaveLength(1);
    expect(result.heals[0]).toMatchObject({
      status: "pending",
      changes: [{ target: "locator" }],
      policy: "review",
    });
    expect(result.steps[0]).toMatchObject({ recovery: "refind", locator: { used: "fallback" } });
    expect(actions(session)[0]).toMatchObject({ type: "click", target: fallback });
    const verdict = decideVerdict([result]);
    expect(verdict.verdict).toBe("healed");
    expect(verdict.decidedBy.every((d) => d.kind === "check")).toBe(true);
  });

  it("re-finds the element over the page when one candidate is clearly the recorded one", async () => {
    const test = await loginTest();
    const byTestId = { kind: "testId", value: "login-button" } as const;
    const recording = recordingFor(
      test,
      { [LOGIN]: [command({ type: "click", target: byTestId }, fingerprint(byTestId, button))] },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const session = fakeSession({
      locators: {},
      elements: [
        {
          element: {
            role: "button",
            name: "Log in",
            depth: 0,
            states: {},
            interactive: true,
            frame: 0,
          },
          facts: button,
          locator: primary,
        },
        {
          element: {
            role: "button",
            name: "Sign up",
            depth: 0,
            states: {},
            interactive: true,
            frame: 0,
          },
          facts: facts("button", "Sign up", {
            anchorText: "New here?",
            box: { x: 500, y: 600, width: 80, height: 40 },
          }),
          locator: role("button", "Sign up"),
        },
      ],
    });
    const { result } = await replay(test, recording, session);
    expect(result.status).toBe("passed");
    expect(result.healedWithoutAi).toBe(1);
    expect(actions(session)[0]).toMatchObject({ type: "click", target: primary });
    expect(result.heals[0]?.changes[0]?.after).toContain("Log in");
  });

  it("fails the silent-click trap: the right element, but nothing happened (no heal)", async () => {
    const test = await loginTest();
    const recording = recordingFor(
      test,
      {
        [LOGIN]: [
          command({ type: "click", target: primary }, fingerprint(primary, button), {
            appeared: [{ role: "dialog", name: "New project" }],
          }),
        ],
      },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: false } }),
    });
    const { result } = await replay(test, recording, session, { fixerAvailable: true });
    expect(result.status).toBe("failed");
    expect(result.heals).toHaveLength(0);
    expect(result.steps[0]).toMatchObject({ status: "failed", postState: { status: "mismatch" } });
    expect(result.steps[0]?.error).toMatch(/right element was used, but nothing happened/);
    expect(result.failure?.decider).toEqual({ kind: "step", attempt: 1, stepIndex: 0 });
    expect(result.steps[1]?.status).toBe("skipped");
  });

  it("reports a miss only an AI heal could fix as 'needs an AI heal' (the fixer is HEAL's)", async () => {
    const test = await loginTest();
    const recording = recordingFor(test, {
      [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))],
    });
    const { result } = await replay(test, recording, fakeSession({ locators: {} }), {
      fixerAvailable: true,
    });
    expect(result.status).toBe("failed");
    expect(result.needsAi).toBe(1);
    expect(result.failure?.headline).toMatch(/needs an AI heal/);
  });

  it("blocks with ai_unavailable when a heal needs AI and no fixer model is available", async () => {
    const test = await loginTest();
    const recording = recordingFor(test, {
      [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))],
    });
    const { result } = await replay(test, recording, fakeSession({ locators: {} }));
    expect(result.status).toBe("blocked");
    expect(result.blocked?.reason).toBe("ai_unavailable");
  });

  it("never heals in replay-only mode: a miss fails", async () => {
    const test = await loginTest();
    const fallback = { kind: "css", selector: "#login" } as const;
    const recording = recordingFor(test, {
      [LOGIN]: [
        command({ type: "click", target: primary }, fingerprint(primary, button, [fallback])),
      ],
    });
    const session = fakeSession({ locators: { [loc(fallback)]: button } });
    const { result } = await replay(test, recording, session, {
      mode: "replay-only",
      fixerAvailable: true,
    });
    expect(result.status).toBe("failed");
    expect(result.heals).toHaveLength(0);
    expect(result.failure?.headline).toMatch(/replay-only/);
  });

  it("treats a primary locator that finds a different element as a miss, never a silent success", async () => {
    const test = await loginTest();
    const recording = recordingFor(test, {
      [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))],
    });
    const other = facts("button", "Log in", {
      anchorText: "Admin area",
      box: { x: 900, y: 900, width: 80, height: 40 },
    });
    const session = fakeSession({ locators: { [loc(primary)]: other } });
    const { result } = await replay(test, recording, session, { mode: "replay-only" });
    expect(actions(session)).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.error).toMatch(/different element/);
  });

  it("blocks on a missing secret and a disallowed domain", async () => {
    const fill = 'Fill "Password" with {{secret.SHOP_PASSWORD}}';
    const test = await expanded(`1. ${fill}\n2. Expect: the page heading is "Dashboard"`);
    const field = facts("textbox", "Password");
    const target = role("textbox", "Password");
    const recording = recordingFor(test, {
      [fill]: [
        command(
          { type: "fill", target, value: "{{secret.SHOP_PASSWORD}}" },
          fingerprint(target, field),
        ),
      ],
    });
    const refusing = (reason: string) =>
      fakeSession({
        locators: { [loc(target)]: field },
        effect: () => ({
          status: "refused",
          reason: reason as never,
          message: `refused: ${reason}`,
        }),
      });
    const missing = await replay(test, recording, refusing("missing_secret"));
    expect(missing.result.status).toBe("blocked");
    expect(missing.result.blocked?.reason).toBe("missing_secret");
    const domain = await replay(test, recording, refusing("disallowed_domain"));
    expect(domain.result.blocked?.reason).toBe("disallowed_domain");
    expect(decideVerdict([domain.result]).decidedBy[0]).toMatchObject({
      kind: "blocked",
      reason: "disallowed_domain",
    });
  });

  it("fails a pending check in replay-only mode and a check that proves nothing, naming the line", async () => {
    const test = await loginTest();
    const steps = {
      [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))],
    };
    const session = () => fakeSession({ locators: { [loc(primary)]: button } });
    const pending = await replay(
      test,
      recordingFor(test, steps, { 'the page heading is "Dashboard"': { type: "pending" } }),
      session(),
      { mode: "replay-only" },
    );
    expect(pending.result.status).toBe("failed");
    expect(pending.result.failure?.headline).toMatch(
      /the page heading is "Dashboard".*no check yet/,
    );
    const nothing = await replay(
      test,
      recordingFor(test, steps, {
        'the page heading is "Dashboard"': { op: HEADING, provesNothing: true },
      }),
      session(),
    );
    expect(nothing.result.status).toBe("failed");
    expect(nothing.result.checks[0]).toMatchObject({ passed: false });
    expect(nothing.result.failure?.headline).toMatch(/proves nothing/);
  });

  it("compiles a pending check in place in normal mode (rules, no AI) and stores it", async () => {
    const test = await loginTest();
    const recording = recordingFor(
      test,
      { [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))] },
      { 'the page heading is "Dashboard"': { type: "pending" } },
    );
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      elements: [
        {
          element: {
            role: "heading",
            name: "Dashboard",
            depth: 0,
            states: { level: 1 },
            interactive: false,
            frame: 0,
          },
          facts: facts("heading", "Dashboard"),
          locator: role("heading", "Dashboard"),
        },
      ],
      check: (op) => {
        const o = op as { type: string };
        return o.type === "text"
          ? passedEvaluation({ expected: "Dashboard", actual: "Dashboard" })
          : passedEvaluation();
      },
    });
    const { result, calls } = await replay(test, recording, session);
    expect(calls).toHaveLength(0);
    expect(result.authored.checks).toHaveLength(1);
    expect(result.authored.checks[0]).toMatchObject({
      generatedBy: "rules",
      check: { type: "text" },
    });
  });

  it("warns on a failing soft check without failing the test", async () => {
    const test = await expanded(
      `1. ${LOGIN}\n2. Expect: the page heading is "Dashboard"\n3. Soft: the page shows "Welcome back"`,
    );
    const soft = {
      type: "text",
      target: { kind: "css", selector: "body" },
      match: "contains",
      value: "Welcome back",
    } as const;
    const recording = recordingFor(
      test,
      { [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))] },
      { 'the page heading is "Dashboard"': HEADING, 'the page shows "Welcome back"': soft },
    );
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      check: (op) =>
        (op as { value?: string }).value === "Welcome back"
          ? { ...passedEvaluation(), status: "failed", passed: false, actual: "Hello" }
          : passedEvaluation(),
    });
    const { result } = await replay(test, recording, session);
    expect(result.status).toBe("passed");
    expect(result.steps[2]?.status).toBe("warned");
    const verdict = decideVerdict([result]);
    expect(verdict.verdict).toBe("passed");
    // A soft check never decides a pass.
    expect(verdict.decidedBy).toHaveLength(1);
  });

  it("blocks a step that reads an email (inboxes come with AUTH-1) without calling a model", async () => {
    const step = 'Enter the code from the verification email into "Code"';
    const test = await expanded(`1. ${step}\n2. Expect: the page heading is "Dashboard"`);
    const { models, calls } = scriptedModels(() => ({ text: "no" }));
    const { result } = await replay(test, recordingFor(test, {}), fakeSession({ locators: {} }), {
      models,
      plannerAvailable: true,
    });
    expect(calls).toHaveLength(0);
    expect(result.blocked?.reason).toBe("inbox_unavailable");
  });

  it("authors an unrecorded step in place with the planner (REP-4), then keeps replaying", async () => {
    const test = await expanded(
      `1. Click "Sign up"\n2. ${LOGIN}\n3. Expect: the page heading is "Dashboard"`,
    );
    const recording = recordingFor(
      test,
      { [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))] },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const signUp = facts("button", "Sign up");
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      elements: [
        {
          element: {
            role: "button",
            name: "Sign up",
            depth: 0,
            states: {},
            interactive: true,
            frame: 0,
          },
          facts: signUp,
          locator: role("button", "Sign up"),
        },
      ],
    });
    const { models, calls } = scriptedModels(
      agentScript([[/Sign up/, [{ name: "click", on: { role: "button", name: "Sign up" } }]]]),
    );
    const { result } = await replay(test, recording, session, { models, plannerAvailable: true });
    expect(result.status).toBe("passed");
    expect(calls.length).toBeGreaterThan(0);
    expect(result.modelCalls.length).toBe(calls.length);
    expect(result.authored.steps.map((s) => s.text)).toEqual(['Click "Sign up"']);
    expect(result.steps.map((s) => s.recovery)).toEqual(["none", "replay", "none"]);
  });

  it("--rerecord authors every step, ignoring the recording", async () => {
    const test = await loginTest();
    const recording = recordingFor(
      test,
      { [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))] },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      elements: [
        {
          element: {
            role: "button",
            name: "Log in",
            depth: 0,
            states: {},
            interactive: true,
            frame: 0,
          },
          facts: button,
          locator: primary,
        },
      ],
    });
    const { models } = scriptedModels(
      agentScript([[/Log in/, [{ name: "click", on: { role: "button", name: "Log in" } }]]]),
    );
    const { result } = await replay(test, recording, session, {
      models,
      plannerAvailable: true,
      mode: "rerecord",
    });
    expect(result.authored.steps).toHaveLength(1);
    expect(result.authored.checks).toHaveLength(1);
  });

  it("an unrecorded step: replay-only fails it; normal mode without a model blocks", async () => {
    const test = await loginTest();
    const only = await replay(test, recordingFor(test, {}), fakeSession({ locators: {} }), {
      mode: "replay-only",
    });
    expect(only.result.status).toBe("failed");
    expect(only.result.failure?.headline).toMatch(/not recorded yet/);
    const normal = await replay(test, recordingFor(test, {}), fakeSession({ locators: {} }));
    expect(normal.result.blocked?.reason).toBe("ai_unavailable");
  });

  it("a failed check ends the attempt: later steps are skipped", async () => {
    const test = await expanded(`1. Expect: the page heading is "Dashboard"\n2. ${LOGIN}`);
    const recording = recordingFor(
      test,
      { [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))] },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      check: () => ({
        ...passedEvaluation(),
        status: "failed",
        passed: false,
        expected: "Dashboard",
        actual: "Something went wrong",
      }),
    });
    const { result } = await replay(test, recording, session);
    expect(result.failure?.headline).toBe(
      'Step 1 "the page heading is "Dashboard"": expected "Dashboard", found "Something went wrong".',
    );
    expect(result.steps[1]?.status).toBe("skipped");
    expect(actions(session)).toHaveLength(0);
  });
});

describe("an empty test that logs in first (COST-0)", () => {
  it("is blocked, never passed: the auth login is not one of the test's own steps", async () => {
    // A pasted paragraph has no numbered steps; with `auth:` the login still runs.
    const test = await expanded('Never: click "Delete account"');
    const login = {
      index: 0,
      key: "flow:auth",
      text: "auth: ada",
      kind: "flow",
      status: "passed",
      recovery: "replay",
      locator: null,
      postState: null,
      startedAt: new Date(0).toISOString(),
      durationMs: 1,
      settledMs: null,
      screenshots: { before: null, after: null },
      error: null,
      checkIds: [],
      modelCallIds: [],
      decisionIds: [],
      healIds: [],
    } as unknown as StepResult;
    const { result } = await replay(test, undefined, fakeSession({ locators: {} }), {
      prepare: async () => ({ status: "ready", message: "", step: login }),
    });
    expect(result.status).toBe("blocked");
    expect(decideVerdict([result]).verdict).toBe("blocked");
  });
});
