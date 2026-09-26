import { z } from "zod";
import { type ChoiceQuestion, defineTask, type Evidence, untrusted } from "../task.js";
import { normalizeText, SIGNALS, similarity, words } from "./shared.js";

/**
 * duplicate_or_new (DIA-4): is this failure one of the run's existing failure
 * groups ("one broken login breaks 20 tests"), or a new one? The options are
 * the current groups' ids plus `new`, so the question depends on the input.
 */

const STOP = SIGNALS.duplicate_or_new.stopWords;

export const failureSignatureSchema = z.object({
  testId: z.string().min(1).max(300),
  /** The test result's headline (DIA-3). */
  headline: z.string().max(500),
  /** The failing step's text, as written. */
  stepText: z.string().max(500),
  /** The flows (`Use:`) the failing step came from, outermost first. */
  flowChain: z.array(z.string().max(200)).max(10),
  /** The page path at the failure, when known (e.g. /login). */
  route: z.string().max(300).nullable(),
  cause: z.enum(["product_bug", "test_drift", "environment", "test_data", "blocked"]).nullable(),
});
export type FailureSignature = z.infer<typeof failureSignatureSchema>;

export const duplicateOrNewInput = z.object({
  failure: failureSignatureSchema,
  /** The run's failure groups so far, each described by its first failure. */
  groups: z
    .array(
      failureSignatureSchema.extend({
        /** Group id: g1, g2, … */
        id: z.string().regex(/^g\d+$/),
        size: z.number().int().min(1),
      }),
    )
    .max(50),
});
export type DuplicateOrNewInput = z.infer<typeof duplicateOrNewInput>;

const choice = (options: readonly string[]): ChoiceQuestion => ({
  kind: "choice",
  instructions:
    "Is this failure the same problem as one of the existing failure groups? Answer that group's id when the same underlying breakage explains both (the same broken page, flow or feature), or new when it is a different problem.",
  options,
});

/** Normalized signature parts, for comparing failures. */
export function signatureKeys(f: FailureSignature) {
  return {
    headline: normalizeText(f.headline),
    // Step text keeps its quoted element names: "Click 'Invite'" ≠ "Click 'Checkout'".
    step: f.stepText.toLowerCase().replace(/\s+/g, " ").trim(),
    flow: f.flowChain.join(" > ").toLowerCase(),
    route:
      f.route
        ?.replace(/[?#].*$/, "")
        .replace(/\/\d+(?=\/|$)/g, "/<n>")
        .toLowerCase() ?? null,
    words: words(normalizeText(`${f.headline} ${f.stepText}`), STOP).filter(
      (w) => !w.startsWith("<"),
    ),
  };
}

export const duplicateOrNew = defineTask({
  name: "duplicate_or_new",
  version: 1,
  description: "Is this failure a duplicate of an existing failure group, or new?",
  phase: "after",
  input: duplicateOrNewInput,
  // The real options come from questionsFor (the run's groups); this is the shape.
  questions: { group: choice(["g1", "new"]) },
  questionsFor: (input) => ({ group: choice([...input.groups.map((g) => g.id), "new"]) }),
  rules({ failure, groups }) {
    const pick = (group: string, confidence: number, evidence: Evidence[]) => ({
      answers: { group },
      confidence,
      evidence,
    });
    if (groups.length === 0)
      return pick("new", 0.99, [{ signal: "first_failure", detail: "no failure groups yet" }]);
    const mine = signatureKeys(failure);
    const scored = groups.map((g) => ({ g, k: signatureKeys(g) }));
    // Inside the same flow step (e.g. every test that uses the login flow breaks at its step 2).
    if (mine.flow) {
      const sameFlow = scored.find(({ k }) => k.flow === mine.flow && k.step === mine.step);
      if (sameFlow)
        return pick(sameFlow.g.id, 0.95, [
          {
            signal: "same_flow_step",
            detail: `${failure.flowChain.join(" > ")}: "${failure.stepText}"`,
          },
        ]);
    }
    const sameHeadline = scored.filter(
      ({ k }) => k.headline === mine.headline && mine.headline !== "",
    );
    const sameRoute = sameHeadline.find(({ k }) => mine.route !== null && k.route === mine.route);
    if (sameRoute)
      return pick(sameRoute.g.id, 0.93, [
        { signal: "same_headline", detail: mine.headline },
        { signal: "same_route", detail: failure.route ?? "" },
      ]);
    const sameStep = sameHeadline.find(({ k }) => k.step === mine.step);
    if (sameStep)
      return pick(sameStep.g.id, 0.88, [
        { signal: "same_headline", detail: mine.headline },
        { signal: "same_step_text", detail: failure.stepText },
      ]);
    if (sameHeadline[0])
      return pick(sameHeadline[0].g.id, 0.65, [{ signal: "same_headline", detail: mine.headline }]);
    // Nothing shared: no same page, step or flow, and few words in common.
    const unrelated = scored.every(
      ({ k }) =>
        !(mine.route !== null && k.route === mine.route) &&
        k.step !== mine.step &&
        !(mine.flow !== "" && k.flow === mine.flow) &&
        similarity(k.words, mine.words) < 0.2,
    );
    if (unrelated)
      return pick("new", 0.88, [
        { signal: "no_similar_group", detail: `compared with ${groups.length} group(s)` },
      ]);
    return null;
  },
  state({ failure, groups }) {
    const describe = (f: FailureSignature) =>
      [
        `headline: ${f.headline}`,
        `failing step: ${f.stepText}`,
        `flows: ${f.flowChain.join(" > ") || "none"}`,
        `page: ${f.route ?? "unknown"}`,
        `cause: ${f.cause ?? "unknown"}`,
      ].join("\n");
    return [
      untrusted("this-failure", describe(failure)),
      ...groups.map((g) => untrusted(`group ${g.id} (${g.size} tests)`, describe(g))),
    ].join("\n");
  },
  evidence({ failure, groups }) {
    return [
      { signal: "signature", detail: normalizeText(failure.headline) },
      { signal: "groups_compared", detail: String(groups.length) },
    ];
  },
  onEscalate: "human",
});
