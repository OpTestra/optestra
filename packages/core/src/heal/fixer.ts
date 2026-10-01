import type { Command, StepRecording } from "@optestra/recording";
import type { ExpandedStep } from "@optestra/spec";
import {
  type ActionStepResult,
  type AgentContext,
  type AgentPrompt,
  runActionStep,
} from "../author/agent.js";
import type { AuthorLimits } from "../author/types.js";
import type { StepVariables } from "../author/variables.js";
import androidPrompt from "./fixer-android-prompt.json" with { type: "json" };
import prompt from "./fixer-prompt.json" with { type: "json" };
import { describeCommand } from "./patch.js";

// The fixer (HEAL-1 level 2): when no heal without AI is safe, the `fixer`
// model redoes the ONE missed step on the page as it is now. It is the
// author's agent loop in a "single step, heal" mode: the same closed tool set,
// the same untrusted-page rules and guards, the same VER-5 acceptance, with
// the step's recording as context and its own smaller limits. It ends as soon
// as the harness sees the step's recorded effect (`doneWhen`), so the checks
// that follow see the page while it still shows it. It never sees
// or changes a check, and never replans the test.

export const FIXER_PROMPT_VERSION: string = prompt.version;

export const FIXER_PROMPT: AgentPrompt = prompt;
/** The fixer prompt for an app screen (MOB-1). */
export const ANDROID_FIXER_PROMPT: AgentPrompt = androidPrompt;

/** The fixer's own limits: one step, a few actions (guarantee 2). */
export const FIXER_LIMITS: AuthorLimits = {
  actionsPerStep: 4,
  modelCallsPerStep: 6,
  consecutiveFailures: 2,
};

export interface FixerMiss {
  /** The step's recording. */
  recorded: StepRecording;
  /** The command that missed (0-based); earlier ones already ran in this attempt. */
  command: number;
  /** Why it missed, as the replay said it ("Element not found: the "Create" button"). */
  reason: string;
}

function fingerprintLine(command: Command): string {
  const fp = command.fingerprint;
  if (!fp) return "";
  const where = fp.anchorText ? `, in "${fp.anchorText.slice(0, 60)}"` : "";
  return ` [was: ${fp.role} "${fp.name.slice(0, 60)}"${where}]`;
}

/** The fixer's view of the recorded step: what was done before, what is done now, what missed. */
export function fixerContext(miss: FixerMiss): string {
  const lines = ["Recorded actions for this step (from the last good run):"];
  miss.recorded.commands.forEach((command, i) => {
    const state =
      i < miss.command ? "already done now" : i === miss.command ? "MISSED now" : "not done yet";
    lines.push(`${i + 1}. ${describeCommand(command)}${fingerprintLine(command)} (${state})`);
  });
  lines.push("", `Why it missed: ${miss.reason}`);
  return lines.join("\n");
}

/** Runs the fixer on one missed step. Success: the new commands for the missed action onwards. */
export function runFixer(
  ctx: Omit<AgentContext, "role" | "prompt" | "context" | "limits"> & { limits?: AuthorLimits },
  step: ExpandedStep,
  variables: StepVariables,
  miss: FixerMiss,
): Promise<ActionStepResult> {
  return runActionStep(
    {
      ...ctx,
      limits: ctx.limits ?? FIXER_LIMITS,
      role: "fixer",
      prompt: ctx.target === "android" ? ANDROID_FIXER_PROMPT : FIXER_PROMPT,
      context: fixerContext(miss),
      tags: { ...ctx.tags, purpose: "heal" },
    },
    step,
    variables,
  );
}
