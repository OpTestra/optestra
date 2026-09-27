import type { HealPolicy, HealProposal } from "@testament/contract";
import type { Evidence, SameElementAnswer } from "@testament/decide";
import { describeLocator, type Locator } from "@testament/recording";

// A heal found without AI (HEAL-1 level 1: a stored fallback locator, or a
// re-find over the page from the fingerprint). It changes how the step is
// done (the locator), never what is expected (HEAL-3). In LOOP-4 every heal is
// a pending proposal: the recording is not changed (HEAL adds review/accept).

/** DEC-3 signal names → the contract's heal signals. */
const SIGNAL_NAMES: Record<string, string> = {
  role: "role_match",
  name: "text_match",
  text: "text_match",
  test_id: "test_id",
  attributes: "attributes",
  anchor: "anchor_text",
  position: "position",
  frame: "frame",
};

/** The same_element evidence as heal signals (score 0 … 1). */
export function healSignals(evidence: readonly Evidence[]): HealProposal["signals"] {
  const signals: HealProposal["signals"] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (item.score === undefined) continue;
    const name = SIGNAL_NAMES[item.signal] ?? item.signal.replace(/[^a-z0-9_]/g, "_");
    if (!/^[a-z][a-z0-9_]*$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    signals.push({
      name,
      score: Math.round(((Math.max(-1, Math.min(1, item.score)) + 1) / 2) * 1000) / 1000,
      detail: (item.detail ?? "").slice(0, 300),
    });
  }
  return signals;
}

export interface HealInput {
  id: string;
  stepIndex: number;
  stepKey: string;
  /** Which command of the step (0-based). */
  command: number;
  before: Locator;
  after: Locator;
  how: "fallback" | "refind";
  answer: SameElementAnswer;
  policy: HealPolicy;
}

/** The heal proposal (classification is filled in by heal_class). */
export function healProposal(input: HealInput): HealProposal {
  const before = describeLocator(input.before);
  const after = describeLocator(input.after);
  const how =
    input.how === "fallback"
      ? "a stored fallback locator found the same element"
      : "re-found from the recorded fingerprint";
  return {
    id: input.id,
    stepIndex: input.stepIndex,
    stepKey: input.stepKey,
    changes: [{ target: "locator", before, after }],
    diff: [
      `step ${input.stepIndex + 1}, command ${input.command + 1} (${how}, no AI)`,
      `- target: ${JSON.stringify(input.before)}`,
      `+ target: ${JSON.stringify(input.after)}`,
    ].join("\n"),
    signals: healSignals(input.answer.evidence),
    confidence: Math.max(0, Math.min(1, input.answer.confidence)),
    classification: "unknown",
    status: "pending",
    policy: input.policy,
  };
}

/** heal_class's element facts, from a fingerprint (before) or the live element (after). */
export function healFacts(element: {
  role: string;
  name: string;
  tag: string;
  attributes: Record<string, string>;
  box: { x: number; y: number } | null;
  text?: string;
}) {
  return {
    role: element.role || null,
    name: element.name || null,
    text: element.text || null,
    tag: element.tag || null,
    testId: element.attributes["data-testid"] ?? null,
    position: element.box ? { x: element.box.x, y: element.box.y } : null,
  };
}
