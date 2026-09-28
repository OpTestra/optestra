import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckResult,
  EventSchema,
  exitCodeFor,
  foldEvents,
  type HealProposal,
  type StepResult,
} from "@testament/contract";
import type { EmitInput } from "@testament/contract/node";
import { groupFailures } from "@testament/decide";
import { describe, expect, it } from "vitest";
import { chaptersVtt, consoleErrors } from "./evidence.js";
import { recentAiUsage } from "./history.js";
import { type AttemptRecord, decideVerdict, fallbackCause } from "./verdict.js";

const RUN = "01J00000000000000000000000";
const T0 = "2026-09-27T10:00:00.000Z";

function step(
  index: number,
  status: StepResult["status"],
  extra: Partial<StepResult> = {},
): StepResult {
  return {
    index,
    key: `k${index}`,
    text: `step ${index}`,
    kind: "action",
    status,
    recovery: "replay",
    locator: null,
    postState: null,
    startedAt: T0,
    durationMs: 1,
    settledMs: 0,
    screenshots: { before: null, after: null },
    error: status === "failed" ? "boom" : null,
    checkIds: [],
    modelCallIds: [],
    decisionIds: [],
    healIds: [],
    ...extra,
  };
}

function check(id: string, passed: boolean, soft = false): CheckResult {
  return {
    id,
    stepIndex: 1,
    expectation: `line ${id}`,
    generated: { description: `Checked ${id}`, code: "{}" },
    kind: "text",
    soft,
    passed,
    expected: "Dashboard",
    actual: passed ? "Dashboard" : "Something went wrong",
  };
}

const heal: HealProposal = {
  id: "h1",
  stepIndex: 0,
  stepKey: "k0",
  changes: [{ target: "locator", before: "a", after: "b" }],
  diff: "-a\n+b",
  signals: [],
  confidence: 0.9,
  classification: "cosmetic",
  status: "pending",
  policy: "review",
};

const passedAttempt = (attempt: number, extra: Partial<AttemptRecord> = {}): AttemptRecord => ({
  attempt,
  status: "passed",
  steps: [step(0, "passed"), step(1, "passed", { kind: "expect", checkIds: [`c${attempt}`] })],
  checks: [check(`c${attempt}`, true), check(`s${attempt}`, false, true)],
  heals: [],
  failure: null,
  blocked: null,
  ...extra,
});

const failedAttempt = (attempt: number): AttemptRecord => ({
  attempt,
  status: "failed",
  steps: [step(0, "passed"), step(1, "failed", { kind: "expect", checkIds: [`f${attempt}`] })],
  checks: [check(`f${attempt}`, false)],
  heals: [],
  failure: {
    decider: { kind: "check", attempt, checkId: `f${attempt}` },
    headline: 'Step 2 "x": expected "Dashboard", found "Something went wrong".',
  },
  blocked: null,
});

const blockedAttempt: AttemptRecord = {
  attempt: 1,
  status: "blocked",
  steps: [step(0, "blocked")],
  checks: [],
  heals: [],
  failure: null,
  blocked: {
    reason: "missing_secret",
    message: "Secret SHOP_PASSWORD is not available.",
    stepIndex: 0,
  },
};

/** Folds a run with one test: the contract's own verdict rules (schema refinements) must accept it. */
function fold(attempts: AttemptRecord[], cause: string | null = null) {
  const verdict = decideVerdict(attempts);
  const events: EmitInput[] = [
    {
      type: "run.started",
      engineVersion: "0",
      project: "p",
      environment: null,
      target: "web",
      trigger: "cli",
      mode: "replay-only",
    },
    {
      type: "test.started",
      testId: "t",
      file: "tests/t.test.md",
      name: "t",
      matrix: { target: "web", browser: "chromium", device: null },
    },
  ];
  for (const a of attempts) {
    events.push({ type: "attempt.started", testId: "t", attempt: a.attempt });
    for (const s of a.steps)
      events.push({ type: "step.finished", testId: "t", attempt: a.attempt, step: s });
    for (const c of a.checks)
      events.push({ type: "check.evaluated", testId: "t", attempt: a.attempt, check: c });
    for (const h of a.heals)
      events.push({ type: "heal.proposed", testId: "t", attempt: a.attempt, heal: h });
    events.push({ type: "attempt.finished", testId: "t", attempt: a.attempt, status: a.status });
  }
  events.push({
    type: "test.finished",
    testId: "t",
    verdict: verdict.verdict,
    decidedBy: verdict.decidedBy,
    failureCause: (verdict.verdict === "blocked" ? "blocked" : cause) as never,
    headline: verdict.headline,
    checkedSummary: verdict.checkedSummary,
  });
  events.push({ type: "run.finished" });
  const full = events.map((e, seq) =>
    EventSchema.parse({ ...e, seq, ts: T0, runId: RUN, contractVersion: "1.1" }),
  );
  return { verdict, folded: foldEvents(full) };
}

describe("verdicts (HEAL-2): decided by code, accepted by the contract", () => {
  it("passed: every hard check passed; a soft check never decides", () => {
    const { verdict, folded } = fold([passedAttempt(1)]);
    expect(verdict.verdict).toBe("passed");
    expect(verdict.decidedBy).toEqual([{ kind: "check", attempt: 1, checkId: "c1" }]);
    expect(folded.tests[0]?.verdict).toBe("passed");
    expect(verdict.checkedSummary).toEqual(["Checked c1", "Checked s1 (soft): failed"]);
  });

  it("healed: passed with a heal proposal in the final attempt", () => {
    const { verdict, folded } = fold([passedAttempt(1, { heals: [heal] })]);
    expect(verdict.verdict).toBe("healed");
    expect(folded.tests[0]?.verdict).toBe("healed");
  });

  it("failed: the failing check decides, with a cause", () => {
    const { verdict } = fold([failedAttempt(1), failedAttempt(2)], "product_bug");
    expect(verdict.verdict).toBe("failed");
    expect(verdict.decidedBy).toEqual([{ kind: "check", attempt: 2, checkId: "f2" }]);
    expect(verdict.headline).toMatch(/expected "Dashboard", found "Something went wrong"/);
  });

  it("flaky: failed, then passed on the retry (DIA-2); deciders from both attempts", () => {
    const { verdict, folded } = fold([failedAttempt(1), passedAttempt(2)], "environment");
    expect(verdict.verdict).toBe("flaky");
    expect(verdict.failedAttempt).toBe(1);
    expect(verdict.decidedBy).toEqual([
      { kind: "check", attempt: 1, checkId: "f1" },
      { kind: "check", attempt: 2, checkId: "c2" },
    ]);
    expect(folded.run.totals.flaky).toBe(1);
  });

  it("blocked: only for couldn't-run reasons, named in decidedBy", () => {
    const { verdict, folded } = fold([blockedAttempt]);
    expect(verdict.verdict).toBe("blocked");
    expect(verdict.decidedBy).toEqual([
      {
        kind: "blocked",
        reason: "missing_secret",
        message: "Secret SHOP_PASSWORD is not available.",
      },
    ]);
    expect(folded.tests[0]?.failureCause).toBe("blocked");
  });

  it("a step failure decides when no check ran", () => {
    const attempt: AttemptRecord = {
      ...failedAttempt(1),
      checks: [],
      steps: [
        step(0, "failed", {
          postState: { status: "mismatch", expected: "a dialog", observed: "nothing" },
        }),
      ],
      failure: {
        decider: { kind: "step", attempt: 1, stepIndex: 0 },
        headline: "nothing happened",
      },
    };
    const { verdict } = fold([attempt], "product_bug");
    expect(verdict.decidedBy).toEqual([{ kind: "step", attempt: 1, stepIndex: 0 }]);
    expect(fallbackCause(attempt.failure as never, attempt.steps)).toBe("product_bug");
    expect(
      fallbackCause({ decider: { kind: "step", attempt: 1, stepIndex: 0 }, headline: "" }, [
        step(0, "failed", { error: "Element not found: the button 'Buy'" }),
      ]),
    ).toBe("test_drift");
  });

  it("exit codes follow the verdicts (CLI-5)", () => {
    const code = (
      attempts: AttemptRecord[],
      cause: string | null = null,
      healedCountsAsPass = false,
    ) => exitCodeFor(fold(attempts, cause).folded.run, { healedCountsAsPass });
    expect(code([passedAttempt(1)])).toBe(0);
    expect(code([failedAttempt(1)], "product_bug")).toBe(1);
    expect(code([failedAttempt(1), passedAttempt(2)], "environment")).toBe(1);
    expect(code([passedAttempt(1, { heals: [heal] })])).toBe(1);
    expect(code([passedAttempt(1, { heals: [heal] })], null, true)).toBe(0);
    expect(code([blockedAttempt])).toBe(2);
  });
});

describe("failure groups (DIA-4)", () => {
  it("groups tests whose login flow failed the same way into one issue", async () => {
    const results = ["a", "b", "c"].map((id) => {
      const { folded } = fold([failedAttempt(1)], "product_bug");
      const test = folded.tests[0] as NonNullable<(typeof folded.tests)[0]>;
      return {
        ...test,
        testId: id,
        headline:
          'Step 1 (Use: flows/login.test.md), its step 5 "the page heading is "Dashboard"": expected "Dashboard", found "Something went wrong".',
      };
    });
    const groups = await groupFailures(results, {
      context: () => ({
        stepFlows: { 1: ["flows/login.test.md"] },
        attempts: { 1: { route: "/error" } },
      }),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.testIds).toEqual(["a", "b", "c"]);
  });
});

describe("evidence and history", () => {
  it("writes WebVTT chapters, one cue per step", () => {
    const vtt = chaptersVtt([
      { index: 0, title: "Go to /login", startMs: 0, endMs: 420 },
      { index: 1, title: "a --> b", startMs: 420, endMs: 61_500 },
    ]);
    expect(vtt).toBe(
      "WEBVTT\nKind: chapters\n\nstep-1\n00:00:00.000 --> 00:00:00.420\n1. Go to /login\n\nstep-2\n00:00:00.420 --> 00:01:01.500\n2. a → b\n",
    );
  });

  it("reads console errors from the harness log", () => {
    expect(
      consoleErrors(
        "t [log] hi\nt [error] Failed to load /api/x\nt [pageerror] TypeError: x is undefined",
      ),
    ).toEqual(["t [error] Failed to load /api/x", "t [pageerror] TypeError: x is undefined"]);
  });

  it("counts a test's AI calls over its last runs (LRN-5)", () => {
    const dir = mkdtempSync(join(tmpdir(), "history-"));
    try {
      const run = (id: string, calls: number) => {
        mkdirSync(join(dir, "runs", id), { recursive: true });
        writeFileSync(
          join(dir, "runs", id, "run.json"),
          JSON.stringify({ tests: [{ testId: "t", aiCalls: calls }] }),
        );
      };
      run("01J00000000000000000000001", 4);
      run("01J00000000000000000000002", 0);
      run("01J00000000000000000000003", 1);
      mkdirSync(join(dir, "runs", "01J00000000000000000000004")); // still running: no run.json
      expect(recentAiUsage(dir).get("t")).toEqual({ runs: 3, calls: 5 });
      expect(recentAiUsage(dir, { limit: 2 }).get("t")).toEqual({ runs: 2, calls: 1 });
      expect(recentAiUsage(dir, { exclude: "01J00000000000000000000003" }).get("t")).toEqual({
        runs: 2,
        calls: 4,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
