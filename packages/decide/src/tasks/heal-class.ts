import { z } from "zod";
import { defineTask, type Evidence, untrusted } from "../task.js";
import { SIGNALS, words } from "./shared.js";

/**
 * heal_class (HEAL-6): is a heal cosmetic (the same control, restyled or moved)
 * or a behaviour change (a different control or a different meaning)? The
 * contract's HealProposal classification. Rules never answer `unknown`; that is
 * what a model may say, and what `classifyHeal` records when nobody can tell.
 */

const H = SIGNALS.heal_class;
const VERBS = new Set(H.actionVerbs);
const OPPOSITES = H.opposites.map(([a, b]) => [a ?? "", b ?? ""] as const);
const SYNONYMS = H.synonyms;
const FILLER = new Set(H.rewordFiller);

export const HEAL_CLASSES = ["cosmetic", "behavior_change", "unknown"] as const;

export const elementFactsSchema = z.object({
  /** The locator as recorded, e.g. getByRole('button', { name: 'Add to cart' }). */
  locator: z.string().max(500),
  role: z.string().max(60).nullable(),
  /** Accessible name. */
  name: z.string().max(300).nullable(),
  text: z.string().max(300).nullable(),
  tag: z.string().max(30).nullable(),
  testId: z.string().max(200).nullable(),
  position: z.object({ x: z.number(), y: z.number() }).nullable(),
});
export type ElementFacts = z.infer<typeof elementFactsSchema>;

export const healClassInput = z.object({
  before: elementFactsSchema,
  after: elementFactsSchema,
  /** What the heal changed (contract HealChange targets: locator, action, wait). */
  changes: z
    .array(
      z.object({
        target: z.enum(["locator", "action", "wait"]),
        before: z.string().max(500),
        after: z.string().max(500),
      }),
    )
    .min(1)
    .max(10),
  /** The healer's signals (text_match, role_match, position, …) with scores. */
  signals: z.array(z.object({ name: z.string().max(40), score: z.number().min(0).max(1) })).max(20),
  /** Where the heal happened, so the answer can point at it. */
  attempt: z.number().int().min(1).nullable(),
  stepIndex: z.number().int().min(0).nullable(),
});
export type HealClassInput = z.infer<typeof healClassInput>;

/** Name with case, punctuation and whitespace ignored. */
export const looseName = (name: string | null) =>
  name === null
    ? null
    : name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

const phrase = (text: string) => ` ${text} `;
export function opposite(a: string, b: string): [string, string] | undefined {
  const left = phrase(a);
  const right = phrase(b);
  for (const [x, y] of OPPOSITES) {
    if (left.includes(phrase(x)) && right.includes(phrase(y))) return [x, y];
    if (left.includes(phrase(y)) && right.includes(phrase(x))) return [y, x];
  }
  return undefined;
}

/** Both names say the same thing in different words (from the synonyms list). */
export function synonymous(a: string, b: string): string[] | undefined {
  const swap = (text: string, from: string, to: string) =>
    phrase(text).replaceAll(phrase(from), phrase(to)).trim();
  for (const group of SYNONYMS) {
    const head = group[0] ?? "";
    let left = a;
    let right = b;
    for (const word of group) {
      left = swap(left, word, head);
      right = swap(right, word, head);
    }
    if (left === right && (a !== left || b !== right)) return group;
  }
  return undefined;
}

export function healSignals(input: HealClassInput) {
  const { before, after } = input;
  const roleKnown = before.role !== null && after.role !== null;
  const roleChanged = roleKnown && before.role?.toLowerCase() !== after.role?.toLowerCase();
  const nameBefore = looseName(before.name ?? before.text);
  const nameAfter = looseName(after.name ?? after.text);
  const nameKnown = nameBefore !== null && nameAfter !== null;
  const sameName = nameKnown && nameBefore === nameAfter;
  const wordsBefore = nameBefore ? words(nameBefore, H.stopWords) : [];
  const wordsAfter = nameAfter ? words(nameAfter, H.stopWords) : [];
  const shared = wordsBefore.filter((w) => wordsAfter.includes(w));
  const verbBefore = wordsBefore[0] && VERBS.has(wordsBefore[0]) ? wordsBefore[0] : null;
  const verbAfter = wordsAfter[0] && VERBS.has(wordsAfter[0]) ? wordsAfter[0] : null;
  const opposed = nameKnown ? opposite(nameBefore ?? "", nameAfter ?? "") : undefined;
  const synonyms =
    nameKnown && !sameName ? synonymous(nameBefore ?? "", nameAfter ?? "") : undefined;
  // One name is the other plus filler words only ('Save' → 'Save now'), never new content ('Delete' → 'Delete account').
  const [shorter, longer] =
    wordsBefore.length <= wordsAfter.length ? [wordsBefore, wordsAfter] : [wordsAfter, wordsBefore];
  const subset =
    shared.length > 0 &&
    shorter.every((w) => longer.includes(w)) &&
    longer.filter((w) => !shorter.includes(w)).every((w) => FILLER.has(w));
  const actionChanged = input.changes.some((c) => c.target === "action");
  const onlyWaits = input.changes.every((c) => c.target === "wait");
  const ref: Evidence["ref"] =
    input.attempt !== null && input.stepIndex !== null
      ? { kind: "step", attempt: input.attempt, stepIndex: input.stepIndex }
      : undefined;
  return {
    roleKnown,
    roleChanged,
    nameKnown,
    sameName,
    nameBefore,
    nameAfter,
    shared,
    verbBefore,
    verbAfter,
    opposed,
    synonyms,
    subset,
    actionChanged,
    onlyWaits,
    ref,
  };
}

export const healClass = defineTask({
  name: "heal_class",
  version: 1,
  description: "Is this heal cosmetic (same control, restyled or moved) or a behaviour change?",
  phase: "after",
  input: healClassInput,
  questions: {
    classification: {
      kind: "choice",
      instructions:
        "A test step was repaired to use a different element. cosmetic: it is the same control with the same meaning, only its look, label wording, position, CSS or test id changed. behavior_change: it is a different control or its meaning changed (a different action, the opposite action, a different destination). unknown: the facts don't say.",
      options: HEAL_CLASSES,
    },
  },
  rules(input) {
    const s = healSignals(input);
    const at = (e: Evidence): Evidence => (s.ref ? { ...e, ref: s.ref } : e);
    const pick = (
      classification: "cosmetic" | "behavior_change",
      confidence: number,
      evidence: Evidence[],
    ) => ({
      answers: { classification },
      confidence,
      evidence: evidence.map(at),
    });
    const names = `'${input.before.name ?? input.before.text ?? "?"}' → '${input.after.name ?? input.after.text ?? "?"}'`;
    if (s.onlyWaits)
      return pick("cosmetic", 0.92, [
        { signal: "only_waits_changed", detail: "only timing changed" },
      ]);
    if (s.actionChanged)
      return pick("behavior_change", 0.88, [
        {
          signal: "action_changed",
          detail: input.changes
            .filter((c) => c.target === "action")
            .map((c) => `${c.before} → ${c.after}`)
            .join("; "),
        },
      ]);
    if (s.roleChanged)
      return pick("behavior_change", 0.9, [
        { signal: "role_changed", detail: `${input.before.role} → ${input.after.role}` },
      ]);
    if (s.opposed)
      return pick("behavior_change", 0.93, [
        { signal: "opposite_action", detail: `${s.opposed[0]} → ${s.opposed[1]}` },
      ]);
    if (s.sameName && (s.roleKnown || input.before.tag === input.after.tag))
      return pick("cosmetic", 0.92, [
        { signal: "same_role", detail: input.after.role ?? input.after.tag ?? "" },
        { signal: "same_name", detail: `'${input.after.name ?? input.after.text}'` },
        { signal: "locator_changed", detail: `${input.before.locator} → ${input.after.locator}` },
      ]);
    if (!s.nameKnown || !s.roleKnown) return null;
    if (s.synonyms)
      return pick("cosmetic", 0.85, [
        { signal: "same_role", detail: input.after.role ?? "" },
        { signal: "synonymous_name", detail: `${names} (${s.synonyms.join(" / ")})` },
      ]);
    // Two different action verbs that aren't synonyms: a different action.
    if (s.verbBefore && s.verbAfter && s.verbBefore !== s.verbAfter)
      return pick("behavior_change", 0.85, [{ signal: "different_action_verb", detail: names }]);
    // No words in common may still be a synonym the list doesn't know ('Cart' → 'Bag'): no guess.
    if (s.subset && s.verbBefore === s.verbAfter)
      return pick("cosmetic", 0.82, [
        { signal: "same_role", detail: input.after.role ?? "" },
        { signal: "name_reworded", detail: names },
      ]);
    // Same role, partly the same words ('Add to cart' → 'Add to bag'): a model or a human decides.
    return null;
  },
  state({ before, after, changes, signals }) {
    const facts = (e: typeof before) =>
      [
        `locator: ${e.locator}`,
        `role: ${e.role ?? "?"}`,
        `accessible name: ${e.name ?? "?"}`,
        `text: ${e.text ?? "?"}`,
        `tag: ${e.tag ?? "?"}`,
        `test id: ${e.testId ?? "?"}`,
        `position: ${e.position ? `${Math.round(e.position.x)},${Math.round(e.position.y)}` : "?"}`,
      ].join("\n");
    return [
      untrusted("element-before", facts(before)),
      untrusted("element-after", facts(after)),
      `Changed: ${changes.map((c) => c.target).join(", ")}`,
      `Healer signals: ${signals.map((g) => `${g.name} ${g.score.toFixed(2)}`).join(", ") || "none"}`,
    ].join("\n");
  },
  evidence(input) {
    const s = healSignals(input);
    const out: Evidence[] = [
      {
        signal: s.roleChanged ? "role_changed" : "same_role",
        detail: `${input.before.role ?? "?"} → ${input.after.role ?? "?"}`,
      },
      {
        signal: s.sameName ? "same_name" : "name_changed",
        detail: `'${input.before.name ?? "?"}' → '${input.after.name ?? "?"}'`,
      },
    ];
    return s.ref ? out.map((e) => ({ ...e, ref: s.ref })) : out;
  },
  onEscalate: "human",
});

/**
 * Element facts from a Playwright-style locator string, when the recording
 * doesn't carry them: getByRole('button', { name: 'Save' }), getByText('Save'),
 * getByLabel, getByPlaceholder, getByTestId, or a CSS locator('…').
 */
export function factsFromLocator(locator: string): ElementFacts {
  const facts: ElementFacts = {
    locator,
    role: null,
    name: null,
    text: null,
    tag: null,
    testId: null,
    position: null,
  };
  const role = /getByRole\(\s*(['"`])(.*?)\1(?:\s*,\s*\{[^}]*?name\s*:\s*(['"`])(.*?)\3)?/.exec(
    locator,
  );
  if (role) {
    facts.role = role[2] ?? null;
    facts.name = role[4] ?? null;
    return facts;
  }
  const simple = /getBy(Text|Label|Placeholder|TestId|AltText|Title)\(\s*(['"`])(.*?)\2/.exec(
    locator,
  );
  if (simple) {
    const value = simple[3] ?? null;
    if (simple[1] === "TestId") facts.testId = value;
    else if (simple[1] === "Text") facts.text = value;
    else facts.name = value;
    return facts;
  }
  const css = /^(?:locator\(\s*['"`])?([a-z][a-z0-9]*)?/i.exec(locator.trim());
  if (css?.[1] && !/^getBy/.test(locator)) facts.tag = css[1].toLowerCase();
  return facts;
}
