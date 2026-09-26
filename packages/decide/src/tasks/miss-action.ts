import { z } from "zod";
import { defineTask, type Evidence } from "../task.js";

/**
 * miss_action (HEAL-1, REP-5): a stored step missed during replay; what next?
 * The healing ladder, cheapest and safest first:
 *
 *   1. block            the page is an error page, the app is down, a 5xx or a
 *                       network failure, or the action was refused (a blocked
 *                       reason): not a test problem, don't heal around it
 *   2. no_heal          the element was the right one but the page didn't react
 *                       (post-state mismatch): an app problem; healing would hide it
 *   3. replay_fallback  a stored fallback locator matched and same_element says same
 *   4. refind           rankCandidates found one clear best match (no AI)
 *   5. no_heal          the test's heal policy is strict: no AI allowed
 *   6. call_fixer       a fixer model is available and budget is left
 *   7. block            otherwise (ai_unavailable or budget_exceeded)
 *
 * `no_heal` means "don't repair: the step stays failed". The brief called it
 * `fail`; that is a verdict word the no-verdict guard forbids, and deciding the
 * verdict is the checks' job anyway.
 */

export const MISS_ACTIONS = [
  "replay_fallback",
  "refind",
  "call_fixer",
  "block",
  "no_heal",
] as const;
export type MissAction = (typeof MISS_ACTIONS)[number];

export const missActionInput = z.object({
  /** Why the stored step missed. */
  missReason: z.enum([
    "not_found",
    "multiple_matches",
    "fingerprint_mismatch",
    "action_refused",
    "post_state_mismatch",
  ]),
  /** A refused action's reason (a contract BlockedReason, e.g. disallowed_domain, missing_secret). */
  refusal: z.string().max(60).nullable(),
  /** For post_state_mismatch: was the element acted on the recorded one? */
  usedElement: z.enum(["same", "not_same", "unknown"]).nullable(),
  fallbacks: z.object({
    total: z.number().int().min(0),
    matched: z.number().int().min(0),
    /** same_element's answer for the best matching fallback (null when none matched). */
    sameElement: z.enum(["same", "not_same", "unknown"]).nullable(),
  }),
  /** rankCandidates' outcome over the live page. */
  ranking: z.object({
    outcome: z.enum(["match", "ambiguous", "none", "not_run"]),
    bestScore: z.number().min(-1).max(1).nullable(),
  }),
  page: z.object({
    /** page_is_error's answer for the current page, when decided. */
    isError: z.boolean().nullable(),
    /** The app didn't answer at all (document request failed). */
    appDown: z.boolean(),
    serverErrors: z.number().int().min(0),
    networkFailures: z.number().int().min(0),
  }),
  policy: z.enum(["strict", "review", "auto"]),
  /** USD left in the run budget; null when there is no cap. */
  budgetLeftUsd: z.number().nullable(),
  fixerAvailable: z.boolean(),
});
export type MissActionInput = z.infer<typeof missActionInput>;

/** The blocked reason a `block` answer maps to (contract BlockedReason). */
export function blockedReasonFor(input: MissActionInput): string {
  if (input.missReason === "action_refused" && input.refusal) return input.refusal;
  if (
    input.page.appDown ||
    input.page.isError ||
    input.page.serverErrors ||
    input.page.networkFailures
  )
    return "app_down";
  if (!input.fixerAvailable) return "ai_unavailable";
  return "budget_exceeded";
}

export const missAction = defineTask({
  name: "miss_action",
  version: 1,
  description: "A stored step missed during replay: which healing step comes next?",
  phase: "during",
  input: missActionInput,
  questions: {
    action: {
      kind: "choice",
      instructions:
        "A replayed step could not use its stored element. What should happen next? block: the app is broken or the action was refused. no_heal: don't repair (the right element did nothing, or the policy forbids AI). replay_fallback: use the stored fallback locator that matched the same element. refind: use the one clear match found on the page. call_fixer: ask the fixer model to repair the step.",
      options: MISS_ACTIONS,
    },
  },
  rules(input) {
    const pick = (action: MissAction, confidence: number, evidence: Evidence[]) => ({
      answers: { action },
      confidence,
      evidence,
    });
    const p = input.page;
    // 1. The app is broken: an environment or product problem, not the test's.
    if (p.appDown || p.isError === true || p.serverErrors > 0 || p.networkFailures > 0)
      return pick("block", 0.95, [
        {
          signal: "page_unhealthy",
          detail: [
            p.appDown ? "app down" : "",
            p.isError ? "error page" : "",
            p.serverErrors ? `${p.serverErrors}×5xx` : "",
            p.networkFailures ? `${p.networkFailures} network failure(s)` : "",
          ]
            .filter(Boolean)
            .join(", "),
        },
      ]);
    if (input.missReason === "action_refused")
      return pick("block", 0.97, [
        { signal: "action_refused", detail: input.refusal ?? "refused" },
      ]);
    // 2. The right element did nothing: an app problem that healing would hide.
    if (input.missReason === "post_state_mismatch" && input.usedElement === "same")
      return pick("no_heal", 0.9, [
        { signal: "post_state_mismatch", detail: "the page didn't reflect the action" },
        { signal: "element_verified_same", detail: "same_element: same" },
      ]);
    // 3–4. Healing without AI.
    if (input.fallbacks.matched > 0 && input.fallbacks.sameElement === "same")
      return pick("replay_fallback", 0.95, [
        {
          signal: "fallback_matched",
          detail: `${input.fallbacks.matched} of ${input.fallbacks.total} fallbacks matched`,
        },
        { signal: "element_verified_same", detail: "same_element: same" },
      ]);
    if (input.ranking.outcome === "match")
      return pick("refind", 0.92, [
        {
          signal: "clear_best_match",
          detail: `best score ${input.ranking.bestScore ?? "?"}, clearly ahead`,
        },
      ]);
    const tried: Evidence = {
      signal: "no_heal_without_ai",
      detail: `fallbacks ${input.fallbacks.matched}/${input.fallbacks.total} (${input.fallbacks.sameElement ?? "none"}), re-find ${input.ranking.outcome}`,
    };
    // 5. No AI allowed.
    if (input.policy === "strict")
      return pick("no_heal", 0.97, [
        tried,
        { signal: "policy_strict", detail: "heal policy is strict" },
      ]);
    // 6. The fixer model.
    const budgetLeft = input.budgetLeftUsd === null || input.budgetLeftUsd > 0;
    if (input.fixerAvailable && budgetLeft)
      return pick("call_fixer", 0.92, [
        tried,
        {
          signal: "fixer_available",
          detail:
            input.budgetLeftUsd === null
              ? "no budget cap"
              : `$${input.budgetLeftUsd.toFixed(2)} left`,
        },
      ]);
    // 7. Nothing left to try.
    return pick("block", 0.95, [
      tried,
      input.fixerAvailable
        ? { signal: "budget_exceeded", detail: "no budget left" }
        : { signal: "ai_unavailable", detail: "no fixer model available" },
    ]);
  },
  state(input) {
    return [
      `Missed because: ${input.missReason}${input.refusal ? ` (${input.refusal})` : ""}`,
      input.usedElement ? `Element acted on was the recorded one: ${input.usedElement}` : "",
      `Fallback locators: ${input.fallbacks.total}, matched: ${input.fallbacks.matched}, same element: ${input.fallbacks.sameElement ?? "n/a"}`,
      `Re-find over the page: ${input.ranking.outcome}${input.ranking.bestScore !== null ? ` (best score ${input.ranking.bestScore})` : ""}`,
      `Page: error page ${input.page.isError ?? "unknown"}, app down ${input.page.appDown}, ${input.page.serverErrors}×5xx, ${input.page.networkFailures} network failures`,
      `Heal policy: ${input.policy}; fixer model available: ${input.fixerAvailable}; budget left: ${input.budgetLeftUsd === null ? "no cap" : `$${input.budgetLeftUsd}`}`,
    ]
      .filter(Boolean)
      .join("\n");
  },
  evidence(input) {
    return [
      { signal: "miss_reason", detail: input.missReason },
      { signal: "policy", detail: input.policy },
    ];
  },
  onEscalate: "fixer",
});
