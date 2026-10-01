import {
  type Command,
  CommandSchema,
  describeLocator,
  type Fingerprint,
  type Locator,
  type Recording,
} from "@optestra/recording";
import { z } from "zod";
import type { ElementFacts } from "../target/harness.js";

// What a heal changes in the recording (HEAL-3, LRN-3): a splice of one step's
// commands, never a check. Written next to the proposal in the run folder
// (`tests/<id>/<attempt>/heals/<healId>.json`) so an accepted heal can be
// applied later exactly as it was proved in the run. Keys are never changed.

export const HEAL_PATCH_VERSION = 1;

export const HealPatchSchema = z.object({
  patchVersion: z.literal(HEAL_PATCH_VERSION),
  healId: z.string(),
  testId: z.string(),
  /** Project-relative test file. */
  testPath: z.string(),
  attempt: z.number().int().min(1),
  stepIndex: z.number().int().min(0),
  /** The recording entry this changes (StepRecording.key; unchanged by the heal). */
  stepKey: z.string(),
  textKey: z.string(),
  level: z.enum(["fallback", "refind", "fixer"]),
  /** The first command replaced (0-based). */
  from: z.number().int().min(0),
  /** The commands replaced, as recorded (the apply refuses when they changed since). */
  before: z.array(CommandSchema),
  /** What replaces them. */
  after: z.array(CommandSchema),
  /**
   * The inputs the run's decisions saw, for labels on accept/reject (LRN-9).
   * Stored as-is so the label trains on the same view.
   */
  labels: z
    .object({
      sameElement: z.unknown().optional(),
      missAction: z.unknown().optional(),
      healClass: z.unknown().optional(),
      /** The miss_action answer that led to this heal. */
      action: z.enum(["replay_fallback", "refind", "call_fixer"]).optional(),
    })
    .default({}),
});
export type HealPatch = z.infer<typeof HealPatchSchema>;

/** One command as a person reads it in a diff: `click the "Create" button`. */
export function describeCommand(command: Command): string {
  const action = command.action as Command["action"] & {
    target?: Locator;
    value?: string;
    option?: string;
    url?: string;
    key?: string;
    text?: string;
    files?: string[];
    direction?: string;
    orientation?: string;
    decision?: string;
  };
  const parts: string[] = [action.type];
  if (action.target) parts.push(describeLocator(action.target));
  if (action.value !== undefined) parts.push(`with ${JSON.stringify(action.value)}`);
  if (action.option !== undefined) parts.push(`option ${JSON.stringify(action.option)}`);
  if (action.url !== undefined) parts.push(action.url);
  if (action.key !== undefined) parts.push(action.key);
  if (action.text !== undefined) parts.push(JSON.stringify(action.text));
  if (action.files?.length) parts.push(action.files.join(", "));
  // Android (MOB-1): swipe up, rotate landscape, permission allow.
  for (const word of [action.direction, action.orientation, action.decision])
    if (word !== undefined) parts.push(word);
  return parts.join(" ");
}

/** The recorded command after a no-AI locator heal: the new target first, the element's facts now. */
export function relocatedCommand(command: Command, locator: Locator, facts: ElementFacts): Command {
  const old = command.fingerprint;
  const same = (a: Locator) => JSON.stringify(a) === JSON.stringify(locator);
  const fingerprint: Fingerprint | null = old
    ? {
        primary: locator,
        fallbacks: [old.primary, ...old.fallbacks].filter((l) => !same(l)),
        role: facts.role,
        name: facts.name,
        tag: facts.tag,
        attributes: facts.attributes,
        anchorText: facts.anchorText,
        framePath: facts.framePath as Fingerprint["framePath"],
        box: facts.box,
      }
    : null;
  // The recorded effect may name the element itself (it appeared, went away):
  // under its new name, or the next replay can't match its own effect.
  const rename = (list: Command["expectPost"]["appeared"]) =>
    list?.map((e) =>
      old && e.role === old.role && e.name === old.name && facts.name !== old.name
        ? { ...e, name: facts.name }
        : e,
    );
  const expectPost: Command["expectPost"] = {
    ...command.expectPost,
    ...(command.expectPost.appeared ? { appeared: rename(command.expectPost.appeared) } : {}),
    ...(command.expectPost.removed ? { removed: rename(command.expectPost.removed) } : {}),
  };
  return {
    ...command,
    action: { ...command.action, target: locator } as Command["action"],
    fingerprint,
    expectPost,
  };
}

/** The diff of a patch, one line per command: `- click …` / `+ click …`. */
export function patchDiff(
  stepIndex: number,
  from: number,
  before: readonly Command[],
  after: readonly Command[],
  how: string,
): string {
  const lines = [
    `step ${stepIndex + 1}, command ${from + 1}${before.length > 1 ? `–${from + before.length}` : ""} (${how})`,
  ];
  for (const command of before) lines.push(`- ${describeCommand(command)}`);
  for (const command of after) lines.push(`+ ${describeCommand(command)}`);
  return lines.join("\n");
}

export interface ApplyResult {
  recording: Recording;
  applied: string[];
  /** Heals that no longer fit the recording (it changed since the run), with why. */
  conflicts: { healId: string; reason: string }[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies accepted heal patches to a recording. Only the patched steps'
 * commands change: every other step, every check, every key stays as it was
 * (HEAL-3). Patches on the same step apply from the last command backwards.
 */
export function applyPatches(recording: Recording, patches: readonly HealPatch[]): ApplyResult {
  const steps = recording.steps.map((s) => ({ ...s, commands: [...s.commands] }));
  const applied: string[] = [];
  const conflicts: ApplyResult["conflicts"] = [];
  const ordered = [...patches].sort((a, b) => b.from - a.from);
  for (const patch of ordered) {
    const step = steps.find((s) => s.key === patch.stepKey);
    if (!step) {
      conflicts.push({ healId: patch.healId, reason: "the step is no longer in the recording" });
      continue;
    }
    const current = step.commands.slice(patch.from, patch.from + patch.before.length);
    if (current.length !== patch.before.length || !same(current, patch.before)) {
      conflicts.push({
        healId: patch.healId,
        reason: "the step's recording changed since this run (re-run to heal it again)",
      });
      continue;
    }
    step.commands.splice(patch.from, patch.before.length, ...patch.after);
    applied.push(patch.healId);
  }
  return {
    recording: { ...recording, steps, checks: recording.checks },
    applied: patches.map((p) => p.healId).filter((id) => applied.includes(id)),
    conflicts,
  };
}
