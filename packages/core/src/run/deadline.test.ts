import { createSecretValue, memorySource, Redactor } from "@optestra/config/node";
import { AiWaits, BudgetMeter, createModels, type WaitInfo, withAiWaits } from "@optestra/models";
import { type ScriptedCall, scriptedModel } from "@optestra/models/testing";
import { describe, expect, it } from "vitest";
import { agentScript, modelsConfig } from "../author/test-kit.test-support.js";
import { Deadline } from "./deadline.js";
import {
  command,
  expanded,
  facts,
  fakeSession,
  fingerprint,
  recordingFor,
  replay,
  role,
} from "./test-kit.test-support.js";

createSecretValue("SHOP_PASSWORD", "planted-7d1e-secret", { domains: ["127.0.0.1"] });

describe("Deadline", () => {
  it("leaves AI waits out of the time used, and never expires during a wait", () => {
    let clock = 0;
    const waits = new AiWaits(undefined, () => clock);
    const deadline = new Deadline(1_000, waits, () => clock);
    clock = 400;
    expect(deadline.remainingMs).toBe(600);
    waits.begin();
    clock = 5_000;
    expect(deadline.expired).toBe(false);
    expect(deadline.remainingMs).toBe(600);
    waits.end();
    expect(deadline.usedMs).toBe(400);
    clock = 5_600;
    expect(deadline.expired).toBe(true);
  });

  it("its timer fires only once the time not spent waiting is used up", async () => {
    const waits = new AiWaits();
    const deadline = new Deadline(60, waits);
    const controller = new AbortController();
    const disarm = deadline.arm(controller);
    waits.begin();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(controller.signal.aborted).toBe(false);
    waits.end();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(controller.signal.aborted).toBe(true);
    disarm();
  });
});

const SIGN_UP = 'Click "Sign up"';
const LOGIN = 'Click "Log in"';
const HEADING = {
  type: "text",
  target: { kind: "role", role: "heading" },
  match: "equals",
  value: "Dashboard",
} as const;
const primary = role("button", "Log in");
const button = facts("button", "Log in");

/** A planner whose first `limited` calls get a 429 with Retry-After: `seconds`. */
function rateLimitedModels(limited: number, seconds: string) {
  const agent = agentScript([
    [/Sign up/, [{ name: "click", on: { role: "button", name: "Sign up" } }]],
  ]);
  const script = scriptedModel((call: ScriptedCall, index: number) =>
    index < limited ? { error: { status: 429, headers: { "retry-after": seconds } } } : agent(call),
  );
  const calls = () => script.calls.length;
  const models = createModels({
    config: modelsConfig(),
    sources: [memorySource({ A_KEY: "test-key-0000" }, {}, { redactor: new Redactor() })],
    languageModel: script.languageModel,
    budgets: [new BudgetMeter("run", null)],
    backoffMs: 1,
  });
  return { models, calls };
}

async function signUpScenario() {
  const test = await expanded(
    `1. ${SIGN_UP}\n2. ${LOGIN}\n3. Expect: the page heading is "Dashboard"`,
  );
  const recording = recordingFor(
    test,
    { [LOGIN]: [command({ type: "click", target: primary }, fingerprint(primary, button))] },
    { 'the page heading is "Dashboard"': HEADING },
  );
  const session = fakeSession({
    locators: { [JSON.stringify(primary)]: button },
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
        facts: facts("button", "Sign up"),
        locator: role("button", "Sign up"),
      },
    ],
  });
  return { test, recording, session };
}

describe("a provider's rate limit never changes a verdict (PROV-0)", () => {
  it("waits out a Retry-After longer than the test's whole time limit, resumes, same verdict", async () => {
    // Reference: no rate limit.
    const plain = await signUpScenario();
    const reference = rateLimitedModels(0, "0");
    const before = await replay(plain.test, plain.recording, plain.session, {
      models: reference.models,
      plannerAvailable: true,
    });
    expect(before.result.status).toBe("passed");

    // The same test with a 1 s time limit; the provider says "retry after 1.5 s" twice.
    const limited = await signUpScenario();
    const slow = rateLimitedModels(2, "1.5");
    const waited: WaitInfo[] = [];
    const waits = new AiWaits((info) => waited.push(info));
    const started = Date.now();
    const after = await withAiWaits(waits, () =>
      replay(limited.test, limited.recording, limited.session, {
        models: slow.models,
        plannerAvailable: true,
        timeoutMs: 1_000,
      }),
    );
    const wall = Date.now() - started;

    expect(after.result.status).toBe(before.result.status);
    expect(after.result.steps.map((s) => [s.status, s.recovery])).toEqual(
      before.result.steps.map((s) => [s.status, s.recovery]),
    );
    expect(after.result.authored.steps.map((s) => s.text)).toEqual(
      before.result.authored.steps.map((s) => s.text),
    );
    // It really waited (twice 1.5 s, three times the test's limit), and said so.
    expect(wall).toBeGreaterThanOrEqual(3_000);
    expect(waited.map((w) => w.reason)).toEqual(["rate_limited", "rate_limited"]);
    expect(waited[0]?.resumesAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(waits.waitedMs).toBeGreaterThanOrEqual(2_900);
    // The wait shows on the call, apart from its latency.
    const call = after.result.modelCalls.find((c) => (c.waitMs ?? 0) > 0);
    expect(call?.waitMs).toBeGreaterThanOrEqual(2_900);
    expect(call?.latencyMs).toBeLessThan(1_000);
    expect(slow.calls()).toBe(reference.calls() + 2);
  }, 20_000);
});
