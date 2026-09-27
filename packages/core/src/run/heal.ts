import type { HealPolicy, HealProposal } from "@testament/contract";
import type { Evidence, SameElementAnswer } from "@testament/decide";
import { type Command, describeLocator, type Locator } from "@testament/recording";
import { describeCommand, patchDiff } from "../heal/patch.js";

// A heal found without AI (HEAL-1 level 1: a stored fallback locator, or a
// re-find over the page from the fingerprint). It changes how the step is
// done (the locator), never what is expected (HEAL-3). A fixer heal (HEAL-1
// level 2) changes the step's actions from the missed one on. Under `review`
// every heal is a pending proposal: the recording is not changed until a
// person accepts it (the `heal` command).

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
    level: input.how,
  };
}

export interface FixerHealInput {
  id: string;
  stepIndex: number;
  stepKey: string;
  /** The first command the fixer replaced. */
  from: number;
  before: readonly Command[];
  after: readonly Command[];
  /** same_element between the missed element and the one the fixer used, when both exist. */
  answer: SameElementAnswer | null;
  policy: HealPolicy;
}

const targetOf = (command: Command | undefined): Locator | undefined =>
  (command?.action as { target?: Locator } | undefined)?.target;

/** The heal proposal for a step the fixer redid: its actions, and its element when that moved. */
export function fixerProposal(input: FixerHealInput): HealProposal {
  const changes: HealProposal["changes"] = [];
  const oldTarget = targetOf(input.before[0]);
  const newTarget = targetOf(input.after.find((c) => targetOf(c)));
  if (oldTarget && newTarget && JSON.stringify(oldTarget) !== JSON.stringify(newTarget))
    changes.push({
      target: "locator",
      before: describeLocator(oldTarget),
      after: describeLocator(newTarget),
    });
  // The same actions on another element are a locator change only; anything
  // else (other actions, values, more or fewer of them) is an action change.
  const untargeted = (commands: readonly Command[]) =>
    JSON.stringify(commands.map((c) => ({ ...c.action, target: undefined })));
  if (untargeted(input.before) !== untargeted(input.after) || changes.length === 0)
    changes.push({
      target: "action",
      before: input.before.map(describeCommand).join("; ") || "(nothing)",
      after: input.after.map(describeCommand).join("; ") || "(nothing)",
    });
  const score = input.answer ? (Math.max(-1, Math.min(1, input.answer.score)) + 1) / 2 : 0.5;
  return {
    id: input.id,
    stepIndex: input.stepIndex,
    stepKey: input.stepKey,
    changes,
    diff: patchDiff(
      input.stepIndex,
      input.from,
      input.before,
      input.after,
      "redone by the fixer model",
    ),
    signals: input.answer ? healSignals(input.answer.evidence) : [],
    confidence: Math.round(score * 1000) / 1000,
    classification: "unknown",
    status: "pending",
    policy: input.policy,
    level: "fixer",
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
