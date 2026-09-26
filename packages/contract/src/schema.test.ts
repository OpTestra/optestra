import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures.test-support.js";
import {
  BlockedReasonSchema,
  HealProposalSchema,
  parseEvent,
  RunSchema,
  type TestResult,
  TestResultSchema,
} from "./index.js";

const load = (name: string, rel: string) =>
  JSON.parse(readFileSync(join(fixture(name), rel), "utf8"));
const runOf = (name: string) => load(name, "run.json");
const testOf = (name: string, index = 0): TestResult => load(name, runOf(name).tests[index].result);

const heal = () => testOf("healed").attempts[0]?.heals[0] as Record<string, unknown>;

describe("versioning", () => {
  it("accepts any 1.x and rejects another major", () => {
    const run = runOf("all-passed");
    expect(RunSchema.safeParse({ ...run, contractVersion: "1.42" }).success).toBe(true);
    expect(RunSchema.safeParse({ ...run, contractVersion: "2.0" }).success).toBe(false);
  });

  it("ignores unknown fields at every level", () => {
    const test = testOf("all-passed") as unknown as Record<string, unknown> & TestResult;
    const extended = {
      ...test,
      futureField: 1,
      attempts: test.attempts.map((a) => ({
        ...a,
        futureField: [1],
        steps: a.steps.map((s) => ({ ...s, x: 1 })),
      })),
    };
    const parsed = TestResultSchema.parse(extended);
    expect(parsed).toEqual(test);
  });

  it("accepts blocked reasons added by a newer minor, but not junk", () => {
    expect(BlockedReasonSchema.safeParse("sso_required").success).toBe(true);
    expect(BlockedReasonSchema.safeParse("Not A Reason").success).toBe(false);
  });

  it("parses event types from a newer minor as unknown, not invalid", () => {
    const base = { seq: 3, ts: "2026-09-26T09:00:00.000Z", runId: runOf("all-passed").runId };
    expect(parseEvent({ ...base, type: "video.chapter" })).toEqual({
      kind: "unknown",
      type: "video.chapter",
      seq: 3,
    });
    expect(parseEvent({ ...base, type: "step.finished" }).kind).toBe("invalid");
  });
});

describe("HealProposal (HEAL-3)", () => {
  it("accepts locator, action and wait changes", () => {
    expect(HealProposalSchema.safeParse(heal()).success).toBe(true);
    for (const target of ["action", "wait"])
      expect(
        HealProposalSchema.safeParse({ ...heal(), changes: [{ target, before: "a", after: "b" }] })
          .success,
      ).toBe(true);
  });

  it("rejects any change to an expectation", () => {
    const attempts = [
      [{ target: "expectation", before: "Total is $90.00", after: "Total is $100.00" }],
      [{ target: "check", before: "a", after: "b" }],
      [{ target: "locator", before: "a", after: "b", expectation: "Total is $100.00" }],
      [],
    ];
    for (const changes of attempts)
      expect(HealProposalSchema.safeParse({ ...heal(), changes }).success).toBe(false);
  });
});

describe("verdicts come from checks (guarantee 3)", () => {
  const problems = (test: unknown) =>
    TestResultSchema.safeParse(test).error?.issues.map((i) => i.message) ?? [];

  it("every golden test result satisfies the verdict rules", () => {
    for (const name of [
      "all-passed",
      "healed",
      "failed-product-bug",
      "flaky",
      "blocked-missing-secret",
      "blocked-budget-exceeded",
      "android",
    ])
      for (const [index] of runOf(name).tests.entries())
        expect(problems(testOf(name, index))).toEqual([]);
  });

  it("rejects a pass decided by a failing check", () => {
    const test = testOf("failed-product-bug");
    expect(problems({ ...test, verdict: "passed", failureCause: null })).toContainEqual(
      expect.stringContaining("failing or blocked decider"),
    );
  });

  it("rejects a pass decided by a soft check alone", () => {
    const test = testOf("all-passed");
    const attempts = test.attempts.map((a) => ({
      ...a,
      checks: a.checks.map((c) => ({ ...c, soft: true })),
    }));
    expect(problems({ ...test, attempts })).toContainEqual(expect.stringContaining("soft check"));
  });

  it("rejects a decider that points at nothing", () => {
    const test = testOf("all-passed");
    expect(
      problems({ ...test, decidedBy: [{ kind: "check", attempt: 1, checkId: "c99" }] }),
    ).toContainEqual(expect.stringContaining('"c99" missing'));
  });

  it("rejects a failure without a failing check or step, and a pass hiding a failed attempt", () => {
    expect(
      problems({ ...testOf("all-passed"), verdict: "failed", failureCause: "product_bug" }),
    ).toContainEqual(expect.stringContaining("needs a failing check or step"));
    expect(
      problems({ ...testOf("flaky"), verdict: "passed", failureCause: null, failureEvidence: [] }),
    ).toContainEqual(expect.stringContaining("is flaky"));
  });

  it("rejects blocked without a blocked reason, and passed with a pending heal", () => {
    expect(
      problems({ ...testOf("all-passed"), verdict: "blocked", failureCause: "blocked" }),
    ).toContainEqual(expect.stringContaining("needs a blocked reason"));
    expect(problems({ ...testOf("healed"), verdict: "passed", headline: null })).toContainEqual(
      expect.stringContaining("healed, not passed"),
    );
  });

  it("has no decider kind for models or decisions", () => {
    const test = testOf("healed");
    const decider = { kind: "decision", attempt: 1, decisionId: "d1" };
    expect(TestResultSchema.safeParse({ ...test, decidedBy: [decider] }).success).toBe(false);
  });
});
