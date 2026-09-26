import { z } from "zod";
import { defineTask, type Evidence, untrusted } from "../task.js";

/**
 * flaky_or_real (DIA-2, DIA-5): is this failure likely intermittent? Advice only:
 * the flaky VERDICT stays deterministic (failed, then passed on retry). This
 * answer feeds quarantine suggestions and retry hints, never a verdict. The
 * question id is `intermittent` because "flaky" is a verdict word.
 */

export const flakyOrRealInput = z.object({
  /** This test's attempts in this run, in order. */
  attempts: z
    .array(
      z.object({
        attempt: z.number().int().min(1),
        status: z.enum(["passed", "failed", "blocked"]),
        /** The failure cause decided for this attempt, when known. */
        cause: z
          .enum(["product_bug", "test_drift", "environment", "test_data", "blocked"])
          .nullable(),
        /** What failed and how (e.g. "check:c1|expected <money>, found <money>"); null when it passed. */
        signature: z.string().max(500).nullable(),
      }),
    )
    .min(1)
    .max(10),
  /** This test's recent verdicts, most recent first (not including this run). */
  history: z
    .array(
      z.object({
        verdict: z.enum(["passed", "healed", "failed", "flaky", "blocked"]),
        /** The failure signature in that run, when it failed. */
        signature: z.string().max(500).nullable(),
      }),
    )
    .max(50),
});
export type FlakyOrRealInput = z.infer<typeof flakyOrRealInput>;

const yes = (confidence: number, evidence: Evidence[]) => ({
  answers: { intermittent: true },
  confidence,
  evidence,
});
const no = (confidence: number, evidence: Evidence[]) => ({
  answers: { intermittent: false },
  confidence,
  evidence,
});

export function flakySignals(input: FlakyOrRealInput) {
  const failed = input.attempts.filter((a) => a.status === "failed");
  const passedAfterFail = input.attempts.some(
    (a, i) =>
      a.status === "passed" && input.attempts.slice(0, i).some((b) => b.status === "failed"),
  );
  const signatures = new Set(failed.map((a) => a.signature ?? "?"));
  const sameEachAttempt =
    failed.length >= 2 && failed.length === input.attempts.length && signatures.size === 1;
  const differentEachAttempt = failed.length >= 2 && signatures.size > 1;
  const environment = input.attempts.some((a) => a.cause === "environment");
  const history = input.history.filter((h) => h.verdict !== "blocked");
  const historyFailed = history.filter((h) => h.verdict === "failed" || h.verdict === "flaky");
  const historyPassed = history.filter((h) => h.verdict === "passed" || h.verdict === "healed");
  const historyFlaky = history.filter((h) => h.verdict === "flaky").length;
  const current = failed[0]?.signature ?? null;
  const historySame =
    historyFailed.length >= 2 &&
    historyFailed.length === history.length &&
    historyFailed.every((h) => h.verdict === "failed" && h.signature === current);
  // Verdict flips in the recent history: pass, fail, pass… (at least two changes).
  let flips = 0;
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1]?.verdict === "failed";
    const b = history[i]?.verdict === "failed";
    if (a !== b) flips++;
  }
  const newlyBroken =
    sameEachAttempt && history.length >= 3 && historyPassed.length === history.length;
  return {
    failed,
    passedAfterFail,
    sameEachAttempt,
    differentEachAttempt,
    environment,
    history,
    historyFailed,
    historyFlaky,
    historySame,
    flips,
    newlyBroken,
  };
}

export const flakyOrReal = defineTask({
  name: "flaky_or_real",
  version: 1,
  description: "Is this failure likely intermittent, or real and repeatable? (advice only)",
  phase: "after",
  input: flakyOrRealInput,
  questions: {
    intermittent: {
      kind: "noul",
      instructions:
        "This failure is intermittent: it comes and goes (timing, infrastructure, test order) rather than failing the same way every time it is run.",
    },
  },
  rules(input) {
    const s = flakySignals(input);
    if (s.failed.length === 0) return null; // Nothing failed: nothing to judge.
    if (s.passedAfterFail)
      return yes(0.95, [{ signal: "passed_on_retry", detail: "failed, then passed on retry" }]);
    if (s.sameEachAttempt && s.historySame)
      return no(0.95, [
        {
          signal: "same_failure_every_attempt",
          detail: `${s.failed.length} attempts, same failure`,
        },
        {
          signal: "same_failure_in_history",
          detail: `last ${s.historyFailed.length} runs failed the same way`,
        },
      ]);
    if (s.newlyBroken)
      return no(0.9, [
        {
          signal: "same_failure_every_attempt",
          detail: `${s.failed.length} attempts, same failure`,
        },
        { signal: "passed_before", detail: `passed in the last ${s.history.length} runs` },
      ]);
    if (s.failed.length === 1 && s.historySame)
      return no(0.85, [
        {
          signal: "same_failure_in_history",
          detail: `last ${s.historyFailed.length} runs failed the same way`,
        },
      ]);
    if (s.environment && s.sameEachAttempt)
      // The same environment failure every attempt (an outage): neither clearly intermittent nor real.
      return null;
    if (s.differentEachAttempt)
      return yes(0.85, [
        { signal: "different_failure_each_attempt", detail: "the attempts failed differently" },
      ]);
    if (s.environment)
      return yes(0.85, [
        { signal: "environment_cause", detail: "an attempt failed for environment reasons" },
      ]);
    if (s.flips >= 3 || s.historyFlaky >= 2)
      return yes(0.85, [
        {
          signal: "verdict_flips_in_history",
          detail: `${s.flips} verdict changes and ${s.historyFlaky} flaky runs in the last ${s.history.length}`,
        },
      ]);
    if (s.sameEachAttempt && s.history.length === 0)
      return no(0.82, [
        {
          signal: "same_failure_every_attempt",
          detail: `${s.failed.length} attempts, same failure`,
        },
      ]);
    if (s.sameEachAttempt && s.flips <= 1)
      return no(0.8, [
        {
          signal: "same_failure_every_attempt",
          detail: `${s.failed.length} attempts, same failure`,
        },
        {
          signal: "stable_history",
          detail: `${s.flips} verdict change(s) in the last ${s.history.length} runs`,
        },
      ]);
    return null;
  },
  state(input) {
    // Failure signatures are built from page text, so they are untrusted.
    return [
      "Attempts this run:",
      untrusted(
        "attempts",
        input.attempts
          .map(
            (a) =>
              `#${a.attempt} ${a.status}${a.cause ? ` (${a.cause})` : ""}${a.signature ? ` — ${a.signature}` : ""}`,
          )
          .join("\n"),
      ),
      input.history.length
        ? `Recent runs, newest first:\n${untrusted(
            "history",
            input.history
              .map((h) => `${h.verdict}${h.signature ? ` — ${h.signature}` : ""}`)
              .join("\n"),
          )}`
        : "No history for this test.",
    ].join("\n");
  },
  evidence(input) {
    const s = flakySignals(input);
    const out: Evidence[] = [
      { signal: "attempts", detail: input.attempts.map((a) => a.status).join(", ") },
    ];
    if (s.history.length)
      out.push({ signal: "history", detail: s.history.map((h) => h.verdict).join(", ") });
    return out;
  },
  onEscalate: "human",
});
