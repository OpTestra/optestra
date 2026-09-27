import { HealProposalSchema } from "@testament/contract";
import type { Command } from "@testament/recording";
import { describe, expect, it } from "vitest";
import { agentScript, promptText, scriptedModels } from "../author/test-kit.test-support.js";
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
} from "../run/test-kit.test-support.js";
import { fixerProposal } from "../run/heal.js";
import { decideVerdict } from "../run/verdict.js";
import { fixerContext } from "./fixer.js";
import { applyPatches, describeCommand } from "./patch.js";
import { markAutoApplied } from "./policy.js";

// HEAL-0 without a browser: the fixer path (success, failure, budget), the
// guarantees (a heal never changes a check, a heal must prove itself, strict
// never heals), and accept → the next replay uses no AI.

const CREATE = 'Click "Create"';
const HEADING = {
  type: "text",
  target: { kind: "role", role: "heading" },
  match: "equals",
  value: "Dashboard",
} as const;
const createButton = facts("button", "Create");
const saveButton = facts("button", "Save project");
const createLocator = role("button", "Create");
const saveLocator = role("button", "Save project");
const loc = (l: unknown) => JSON.stringify(l);

const saveElement = {
  element: {
    role: "button",
    name: "Save project",
    depth: 0,
    states: {},
    interactive: true,
    frame: 0,
  },
  facts: saveButton,
  locator: saveLocator,
};

async function createTest() {
  const test = await expanded(`1. ${CREATE}\n2. Expect: the page heading is "Dashboard"`);
  const recording = recordingFor(
    test,
    {
      [CREATE]: [
        command({ type: "click", target: createLocator }, fingerprint(createLocator, createButton)),
      ],
    },
    { 'the page heading is "Dashboard"': HEADING },
  );
  return { test, recording };
}

/** The reworded build: "Create" is gone, "Save project" does the same thing. */
const reworded = (check?: Parameters<typeof fakeSession>[0]["check"]) =>
  fakeSession({ locators: {}, elements: [saveElement], ...(check ? { check } : {}) });

const fixerClicksSave = () => {
  const script = agentScript([
    [/Click "Create"/, [{ name: "click", on: { role: "button", name: "Save project" } }]],
  ]);
  return (call: Parameters<typeof script>[0]) => ({
    ...script(call),
    text: "Save project is the renamed Create button.",
  });
};

describe("the fixer path (HEAL-1 level 2)", () => {
  it("redoes the missed step with the fixer model: a fixer heal proposal, verdict healed", async () => {
    const { test, recording } = await createTest();
    const { models, calls } = scriptedModels(fixerClicksSave());
    const { result } = await replay(test, recording, reworded(), {
      models,
      fixerAvailable: true,
      plannerAvailable: true,
    });
    expect(result.status).toBe("passed");
    expect(result.healedByFixer).toBe(1);
    expect(result.steps[0]).toMatchObject({ status: "passed", recovery: "fixer" });
    expect(result.heals).toHaveLength(1);
    const heal = result.heals[0];
    expect(heal).toMatchObject({ level: "fixer", status: "pending", policy: "review" });
    expect(HealProposalSchema.safeParse(heal).success).toBe(true);
    // The same click on the renamed button: a locator change, not an action change.
    expect(heal?.changes.map((c) => c.target)).toEqual(["locator"]);
    expect(heal?.changes[0]).toMatchObject({
      before: "the button 'Create'",
      after: "the button 'Save project'",
    });
    expect(heal?.diff).toContain("redone by the fixer model");
    // The fixer role, its prompt holds the recorded step, the calls carry a short note.
    expect(result.modelCalls.every((c) => c.role === "fixer")).toBe(true);
    expect(result.modelCalls[0]?.note).toBe("Save project is the renamed Create button.");
    // The recorded effect showed after the click: no second call just to say step_done.
    expect(calls).toHaveLength(1);
    const prompt = promptText(calls[0] as never);
    expect(prompt).toContain("Recorded actions for this step");
    expect(prompt).toContain("MISSED now");
    // Its patch replaces the step's commands from the missed one.
    const patch = result.patches[0];
    expect(patch).toMatchObject({ level: "fixer", from: 0, healId: heal?.id });
    expect(patch?.after[0]?.action).toMatchObject({ type: "click", target: saveLocator });
    expect(patch?.labels.action).toBe("call_fixer");
    const verdict = decideVerdict([result]);
    expect(verdict.verdict).toBe("healed");
    expect(verdict.headline).toBe("Passed after 1 heal by AI (proposed for review).");
    expect(verdict.decidedBy.every((d) => d.kind === "check")).toBe(true);
  });

  it("fails the step with the fixer's reason when it can't redo it", async () => {
    const { test, recording } = await createTest();
    const { models } = scriptedModels(() => ({
      toolCalls: [{ name: "step_impossible", input: { reason: "there is no Create button" } }],
    }));
    const { result } = await replay(test, recording, reworded(), {
      models,
      fixerAvailable: true,
      plannerAvailable: true,
    });
    expect(result.status).toBe("failed");
    expect(result.heals).toEqual([]);
    expect(result.patches).toEqual([]);
    expect(result.steps[0]?.error).toMatch(
      /fixer model couldn't redo the step \(step_impossible\)/,
    );
    expect(result.steps[0]?.error).toContain("there is no Create button");
    expect(result.steps[1]?.status).toBe("skipped");
  });

  it("stops on the budget mid-heal: blocked, budget_exceeded", async () => {
    const { test, recording } = await createTest();
    // The first call only looks; the budget is spent before the second.
    const { models, budget } = scriptedModels(
      () => ({ toolCalls: [{ name: "look", input: {} }] }),
      {
        cap: 0.000_001,
      },
    );
    const { result } = await replay(test, recording, reworded(), {
      models,
      budget,
      fixerAvailable: true,
      plannerAvailable: true,
    });
    expect(result.status).toBe("blocked");
    expect(result.blocked?.reason).toBe("budget_exceeded");
    expect(result.heals).toEqual([]);
  });

  it("never lets a heal change a check (guarantee 1): a fixer 'fixing' the expectation is refused", async () => {
    const { test, recording } = await createTest();
    // The fixer tries a tool outside the closed action set to rewrite the expectation.
    const { models } = scriptedModels(() => ({
      toolCalls: [
        {
          name: "update_expectation",
          input: { line: 'the page heading is "Dashboard"', value: "Projects" },
        },
      ],
    }));
    const { result } = await replay(test, recording, reworded(), {
      models,
      fixerAvailable: true,
      plannerAvailable: true,
    });
    expect(result.status).toBe("failed");
    expect(result.heals).toEqual([]);
    expect(result.patches).toEqual([]);
    expect(decideVerdict([result]).verdict).toBe("failed");
    // And no proposal can carry one: a change to an expectation doesn't parse.
    const proposal = {
      id: "h1",
      stepIndex: 1,
      stepKey: "k",
      changes: [{ target: "expectation", before: "Dashboard", after: "Projects" }],
      diff: "",
      signals: [],
      confidence: 1,
      classification: "cosmetic",
      status: "pending",
      policy: "review",
    };
    expect(HealProposalSchema.safeParse(proposal).success).toBe(false);
  });

  it("a heal can never make a failed check pass: fixer heal, then the check fails → failed", async () => {
    const { test, recording } = await createTest();
    const { models } = scriptedModels(fixerClicksSave());
    const { result } = await replay(
      test,
      recording,
      reworded(() =>
        passedEvaluation({
          status: "failed",
          passed: false,
          expected: "Dashboard",
          actual: "Oops",
        }),
      ),
      { models, fixerAvailable: true, plannerAvailable: true },
    );
    expect(result.heals).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(decideVerdict([result]).verdict).toBe("failed");
  });

  it("fails a fixer heal whose actions don't show the step's recorded effect (VER-5)", async () => {
    const { test, recording } = await createTest();
    const { models } = scriptedModels(fixerClicksSave());
    const session = fakeSession({
      locators: {},
      elements: [saveElement],
      effect: () => ({ post: { changed: true, added: [{ role: "dialog", name: "Oops" }] } }),
    });
    const { result } = await replay(test, recording, session, {
      models,
      fixerAvailable: true,
      plannerAvailable: true,
    });
    expect(result.status).toBe("failed");
    expect(result.heals).toEqual([]);
    expect(result.steps[0]?.error).toMatch(/recorded effect didn't show/);
  });

  it("describes the recorded step for the fixer: done, missed, not done yet", async () => {
    const { test, recording } = await createTest();
    const step = recording.steps[0];
    if (!step) throw new Error("no step");
    const two = {
      ...step,
      commands: [
        command({ type: "fill", target: role("textbox", "Name"), value: "{{data.name}}" }, null),
        ...step.commands,
        command({ type: "press", key: "Escape" }, null),
      ],
    };
    const text = fixerContext({ recorded: two, command: 1, reason: "Element not found" });
    expect(text).toMatch(/1\. fill .*\(already done now\)/);
    expect(text).toMatch(/2\. click .*\[was: button "Create", in "Log in"\] \(MISSED now\)/);
    expect(text).toMatch(/3\. press Escape \(not done yet\)/);
    expect(test.steps).toHaveLength(2);
  });
});

describe("fixer proposals", () => {
  it("names an action change only when the actions themselves changed", () => {
    const click = command({ type: "click", target: createLocator }, null);
    const clickSave = command({ type: "click", target: saveLocator }, null);
    const fill = command({ type: "fill", target: role("textbox", "Name"), value: "x" }, null);
    const base = {
      id: "h",
      stepIndex: 0,
      stepKey: "k",
      from: 0,
      answer: null,
      policy: "review" as const,
    };
    const moved = fixerProposal({ ...base, before: [click], after: [clickSave] });
    expect(moved.changes.map((c) => c.target)).toEqual(["locator"]);
    const redone = fixerProposal({ ...base, before: [click], after: [fill, clickSave] });
    expect(redone.changes.map((c) => c.target)).toEqual(["locator", "action"]);
    expect(redone.changes[1]?.after).toBe(
      "fill the text field 'Name' with \"x\"; click the button 'Save project'",
    );
    expect(HealProposalSchema.safeParse(redone).success).toBe(true);
  });
});

describe("policies (HEAL-5)", () => {
  it("strict never heals: a stored fallback that would match is not used, the step fails", async () => {
    const test = await expanded(`1. ${CREATE}\n2. Expect: the page heading is "Dashboard"`);
    const fallback = { kind: "css", selector: "#create" } as const;
    const recording = recordingFor(
      test,
      {
        [CREATE]: [
          command(
            { type: "click", target: createLocator },
            fingerprint(createLocator, createButton, [fallback]),
          ),
        ],
      },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const session = fakeSession({ locators: { [loc(fallback)]: createButton } });
    const { models, calls } = scriptedModels(fixerClicksSave());
    const { result } = await replay(test, recording, session, {
      policy: "strict",
      models,
      fixerAvailable: true,
      plannerAvailable: true,
    });
    expect(calls).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.heals).toEqual([]);
    expect(result.steps[0]?.error).toMatch(/heal policy strict/);
  });

  it("auto accepts a passed attempt's heals, but never a behaviour change (HEAL-6)", () => {
    const heal = (classification: "cosmetic" | "behavior_change" | "unknown") => ({
      id: classification,
      stepIndex: 0,
      stepKey: "k",
      changes: [{ target: "locator" as const, before: "a", after: "b" }],
      diff: "",
      signals: [],
      confidence: 0.9,
      classification,
      status: "pending" as const,
      policy: "auto" as const,
    });
    const heals = [heal("cosmetic"), heal("behavior_change"), heal("unknown")];
    const now = () => new Date("2026-09-27T00:00:00Z");
    markAutoApplied(heals, false, now);
    expect(heals.every((h) => h.status === "pending")).toBe(true);
    markAutoApplied(heals, true, now);
    expect(heals.map((h) => [h.id, h.status])).toEqual([
      ["cosmetic", "accepted"],
      ["behavior_change", "pending"],
      ["unknown", "accepted"],
    ]);
    expect(heals[0]).toMatchObject({ appliedBy: "auto", reviewedAt: "2026-09-27T00:00:00.000Z" });
    expect(heals[1]).not.toHaveProperty("appliedBy");
    const verdict = decideVerdict([
      {
        attempt: 1,
        status: "passed",
        steps: [],
        checks: [
          {
            id: "c",
            stepIndex: 1,
            expectation: "x",
            kind: "text",
            soft: false,
            passed: true,
            expected: "x",
            actual: "x",
            generated: { description: "d", code: "c" },
          } as never,
        ],
        heals: [heals[0] as never],
        failure: null,
        blocked: null,
      },
    ]);
    expect(verdict.headline).toBe(
      "Passed after 1 heal without AI (applied to the recording: heal policy auto).",
    );
  });
});

describe("accept (HEAL-4, LRN-3)", () => {
  it("changes only the healed step's commands; the next replay uses zero AI", async () => {
    const { test, recording } = await createTest();
    const other = 'Click "Help"';
    const withOther = {
      ...recording,
      steps: [
        ...recording.steps,
        {
          ...(recording.steps[0] as (typeof recording.steps)[number]),
          key: "0123456789abcdef",
          textKey: "click help",
          text: other,
        },
      ],
    };
    const { models } = scriptedModels(fixerClicksSave());
    const { result } = await replay(test, withOther, reworded(), {
      models,
      fixerAvailable: true,
      plannerAvailable: true,
    });
    const applied = applyPatches(withOther, result.patches);
    expect(applied.conflicts).toEqual([]);
    expect(applied.applied).toEqual(result.heals.map((h) => h.id));
    const next = applied.recording;
    expect(next.checks).toEqual(withOther.checks);
    expect(next.steps[1]).toEqual(withOther.steps[1]);
    expect(next.steps[0]?.key).toBe(withOther.steps[0]?.key);
    expect(next.steps[0]?.commands.map(describeCommand)).toEqual([
      "click the button 'Save project'",
    ]);
    // Applying it again finds a changed step: a conflict, never a double apply.
    expect(applyPatches(next, result.patches).conflicts).toHaveLength(1);

    // The next run replays the healed step from the recording: no model, no heal.
    const again = scriptedModels(() => ({ text: "must not be called" }));
    const session = fakeSession({ locators: { [loc(saveLocator)]: saveButton } });
    const replayed = await replay(test, next, session, {
      models: again.models,
      fixerAvailable: true,
      plannerAvailable: true,
    });
    expect(again.calls).toHaveLength(0);
    expect(replayed.result.status).toBe("passed");
    expect(replayed.result.heals).toEqual([]);
    expect(decideVerdict([replayed.result]).verdict).toBe("passed");
  });

  it("a no-AI heal's patch moves the old locator to the fallbacks and updates the element facts", async () => {
    const test = await expanded(`1. ${CREATE}\n2. Expect: the page heading is "Dashboard"`);
    const fallback = { kind: "css", selector: "#create" } as const;
    const recorded: Command = command(
      { type: "click", target: createLocator },
      fingerprint(createLocator, createButton, [fallback]),
    );
    const recording = recordingFor(
      test,
      { [CREATE]: [recorded] },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const moved = { ...createButton, attributes: { class: "button--main" } };
    const { result } = await replay(
      test,
      recording,
      fakeSession({ locators: { [loc(fallback)]: moved } }),
    );
    expect(result.heals[0]?.level).toBe("fallback");
    const patch = result.patches[0];
    expect(patch?.labels).toMatchObject({ action: "replay_fallback" });
    expect(patch?.labels.sameElement).toBeDefined();
    expect(patch?.labels.healClass).toBeDefined();
    const after = patch?.after[0];
    expect(after?.action).toMatchObject({ target: fallback });
    expect(after?.fingerprint?.primary).toEqual(fallback);
    expect(after?.fingerprint?.fallbacks).toEqual([createLocator]);
    expect(after?.fingerprint?.attributes).toEqual({ class: "button--main" });
    expect(after?.expectPost).toEqual(recorded.expectPost);
  });

  it("renames the element's own entries in the recorded effect when its name changed", async () => {
    const test = await expanded(`1. ${CREATE}\n2. Expect: the page heading is "Dashboard"`);
    const fallback = { kind: "css", selector: "#create" } as const;
    // A weak recording: the only effect seen was the button itself re-rendering.
    const recorded: Command = command(
      { type: "click", target: createLocator },
      fingerprint(createLocator, createButton, [fallback]),
      {
        appeared: [{ role: "button", name: "Create" }],
        removed: [{ role: "button", name: "Create" }],
      },
    );
    const recording = recordingFor(
      test,
      { [CREATE]: [recorded] },
      { 'the page heading is "Dashboard"': HEADING },
    );
    const renamed = { ...createButton, name: "Create it", text: "Create it" };
    const session = fakeSession({
      locators: { [loc(fallback)]: renamed },
      effect: () => ({
        post: { changed: true, added: [{ role: "alert", name: "", text: "Declined" }] },
      }),
    });
    const { result } = await replay(test, recording, session);
    expect(result.status).toBe("passed");
    const after = result.patches[0]?.after[0];
    expect(after?.expectPost).toEqual({
      appeared: [{ role: "button", name: "Create it" }],
      removed: [{ role: "button", name: "Create it" }],
    });
    // Accepted, the next replay finds its own effect under the new name.
    const next = applyPatches(recording, result.patches).recording;
    const again = await replay(
      test,
      next,
      fakeSession({
        locators: { [loc(fallback)]: renamed },
        effect: () => ({
          post: { changed: true, added: [{ role: "alert", name: "", text: "Declined" }] },
        }),
      }),
    );
    expect(again.result.status).toBe("passed");
    expect(again.result.heals).toEqual([]);
  });
});
