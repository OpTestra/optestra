import type { Action, ActionOutcome, Observation, ObservedElement } from "@testament/browser";
import { renderForModel } from "@testament/browser";
import type { ModelCall } from "@testament/contract";
import {
  type BudgetMeter,
  type ImagePart,
  type ModelCallRecord,
  type Models,
  type TextPart,
  toModelCall,
} from "@testament/models";
import type { Command, Fingerprint, Locator, RecordedAction } from "@testament/recording";
import { toTemplate } from "@testament/recording";
import type { ExpandedStep } from "@testament/spec";
import { commandOf, fingerprintOf, pageTemplate } from "./commands.js";
import { checkGuards, type GuardContext } from "./guards.js";
import prompt from "./planner-prompt.json" with { type: "json" };
import { PLANNER_TOOLS, type PlannerToolCall, parseToolCall } from "./tools.js";
import type { ActionReport, AuthorLimits, AuthorSession, StopReason } from "./types.js";
import { describeVariables, harnessValue, type StepVariables } from "./variables.js";

// The agent loop for one action step (LOOP-1). Observe → ask the planner → run
// its tool calls through the harness → repeat, until step_done, step_impossible
// or a limit. The model's word is not proof (VER-5): step_done is accepted only
// if the harness saw a real change.

export const PROMPT_VERSION: string = prompt.version;

/** Actions that may legitimately leave the page unchanged. */
// upload: attaching a file often shows nothing until the form is sent (the next step).
const NO_EFFECT_OK = new Set(["hover", "scroll", "waitFor", "press", "upload"]);

/** The page's elements in order (refs and focus left out), to notice reordering such as a sort. */
function orderSignature(observation: Observation): string {
  return JSON.stringify(observation.elements.map((e) => [e.role, e.name, e.text ?? ""]));
}

export interface AgentContext {
  session: AuthorSession;
  models: Models;
  budget: BudgetMeter | undefined;
  guards: GuardContext;
  limits: AuthorLimits;
  /** Guard lines for the prompt. */
  guardLines: string[];
  signal: AbortSignal;
  tags: Record<string, string>;
}

export interface ActionStepResult {
  status: "recorded" | "failed" | "stopped";
  reason?: StopReason;
  message?: string;
  commands: Command[];
  reasoning?: string;
  actions: ActionReport[];
  modelCalls: ModelCall[];
  records: ModelCallRecord[];
  refusals: string[];
  /** "provider/model" that answered last. */
  model?: string;
}

interface Executed {
  outcome: ActionOutcome;
  recorded: RecordedAction;
  command: Command;
  /** The harness saw a change, or the elements' order changed (e.g. a table sort). */
  effect: boolean;
}

function describeElement(element: ObservedElement | undefined): string {
  if (!element) return "";
  const name = element.name || element.text || "";
  return ` (${element.role}${name ? ` ${JSON.stringify(name.slice(0, 60))}` : ""})`;
}

function summarize(outcome: ActionOutcome, variables: StepVariables): string {
  const parts: string[] = [outcome.status + (outcome.reason ? ` (${outcome.reason})` : "")];
  if (outcome.message) parts.push(outcome.message);
  const post = outcome.post;
  if (post.urlAfter !== post.urlBefore) parts.push(`page changed to ${post.urlAfter}`);
  const shown = (list: typeof post.added) =>
    list
      .slice(0, 6)
      .map(
        (e) =>
          `${e.role}${e.name ? ` "${pageTemplate(e.name, variables.pageList)}"` : ""}${e.text ? `: "${pageTemplate(e.text, variables.pageList).slice(0, 60)}"` : ""}`,
      )
      .join(", ");
  if (post.added.length) parts.push(`appeared: ${shown(post.added)}`);
  if (post.removed.length) parts.push(`removed: ${shown(post.removed)}`);
  if (post.dialogs.length)
    parts.push(`dialogs: ${post.dialogs.map((d) => `${d.type} "${d.message}"`).join(", ")}`);
  if (outcome.status === "ok" && !post.changed) parts.push("NO visible change");
  return parts.join("; ");
}

/** Relative URL for recordings when the target is on the current origin. */
function portableUrl(url: string, current: string): string {
  try {
    const target = new URL(url, current);
    const here = new URL(current);
    if (target.origin === here.origin) return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    // keep as given
  }
  return url;
}

function frameIsBlank(observation: Observation): boolean {
  return observation.frames.some(
    (_, index) =>
      index > 0 && !observation.elements.some((e) => e.frame === index && e.role !== "iframe"),
  );
}

function renderStepPrompt(
  step: ExpandedStep,
  variables: StepVariables,
  guardLines: string[],
  history: string[],
  page: string,
): string {
  return prompt.step
    .replace("{number}", String(step.number ?? step.index + 1))
    .replace("{text}", step.display)
    .replace("{variables}", describeVariables(variables))
    .replace("{guards}", guardLines.length ? guardLines.map((g) => `- ${g}`).join("\n") : "(none)")
    .replace("{history}", history.length ? history.join("\n") : "(nothing yet)")
    .replace("{page}", page);
}

export async function runActionStep(
  ctx: AgentContext,
  step: ExpandedStep,
  variables: StepVariables,
): Promise<ActionStepResult> {
  const result: ActionStepResult = {
    status: "failed",
    commands: [],
    actions: [],
    modelCalls: [],
    records: [],
    refusals: [],
  };
  const executed: Executed[] = [];
  const history: string[] = [];
  let actions = 0;
  let calls = 0;
  let consecutiveFailures = 0;
  let wantScreenshot = false;
  let nudged = false;
  let actedSinceObserve = 0;
  let lastRefusalWasGuard = false;

  const end = (status: ActionStepResult["status"], reason?: StopReason, message?: string) => {
    result.status = status;
    if (reason) result.reason = reason;
    if (message) result.message = message;
    return result;
  };
  const note = (line: string) => history.push(`${history.length + 1}. ${line}`);

  for (;;) {
    if (ctx.signal.aborted) return end("stopped", "timeout", "The test's time limit was reached.");
    if (calls >= ctx.limits.modelCallsPerStep) {
      return end(
        "failed",
        "limit_reached",
        `The step used its ${ctx.limits.modelCallsPerStep} model calls without finishing.`,
      );
    }

    const observation = await ctx.session.observe();
    actedSinceObserve = 0;
    const needShot = wantScreenshot || observation.truncated || frameIsBlank(observation);
    wantScreenshot = false;
    const content: Array<TextPart | ImagePart> = [
      {
        type: "text",
        text: renderStepPrompt(
          step,
          variables,
          ctx.guardLines,
          history,
          renderForModel(observation),
        ),
      },
    ];
    if (needShot) {
      const shot = await ctx.session.screenshot({ forModel: true });
      if (shot.status === "ok")
        content.push({ type: "image", data: shot.bytes, mediaType: shot.contentType });
    }

    const reply = await ctx.models.complete("planner", {
      system: prompt.system,
      messages: [{ role: "user", content }],
      tools: PLANNER_TOOLS,
      maxOutputTokens: 500,
      temperature: 0,
      cache: true,
      signal: ctx.signal,
      ...(ctx.budget ? { budgets: [ctx.budget] } : {}),
      tags: { ...ctx.tags, step: String(step.number ?? step.index + 1) },
    });
    calls++;
    result.records.push(reply.record);
    result.modelCalls.push(toModelCall(reply.record));
    if (!reply.ok) {
      if (ctx.signal.aborted)
        return end("stopped", "timeout", "The test's time limit was reached.");
      if (reply.reason === "budget_exceeded")
        return end("stopped", "budget_exceeded", reply.message);
      return end("stopped", "ai_unavailable", `${reply.message} ${reply.fix}`.trim());
    }
    result.model = `${reply.provider}/${reply.model}`;

    if (reply.toolCalls.length === 0) {
      note("(you replied without calling a tool; always call exactly the tools you need)");
      if (++consecutiveFailures >= ctx.limits.consecutiveFailures) {
        return end("failed", "limit_reached", "The model kept answering without using the tools.");
      }
      continue;
    }

    for (const raw of reply.toolCalls) {
      const parsed = parseToolCall(raw.name, raw.input);
      if (!parsed.ok) {
        note(`${raw.name}: ${parsed.error}`);
        result.actions.push({
          tool: raw.name,
          description: raw.name,
          status: "invalid",
          message: parsed.error,
        });
        if (++consecutiveFailures >= ctx.limits.consecutiveFailures) {
          return end(
            "failed",
            "limit_reached",
            `${ctx.limits.consecutiveFailures} invalid or failed actions in a row.`,
          );
        }
        break;
      }
      const call = parsed.call;

      if (call.name === "look") {
        wantScreenshot = true;
        note("look: a screenshot comes with the next snapshot");
        break;
      }
      if (call.name === "step_impossible") {
        const reason = lastRefusalWasGuard ? "guard_refused" : "step_impossible";
        return end("failed", reason, pageTemplate(call.input.reason, variables.pageList));
      }
      if (call.name === "step_done") {
        const verdict = acceptDone(executed);
        if (verdict === "accept") {
          result.commands = executed.map((e) => e.command);
          result.reasoning = pageTemplate(call.input.visible_effect, variables.pageList).slice(
            0,
            300,
          );
          return end("recorded");
        }
        if (verdict === "nothing_done" && !nudged) {
          nudged = true;
          note(prompt.nudge);
          break;
        }
        return end(
          "failed",
          "no_visible_effect",
          verdict === "nothing_done"
            ? "The model said the step was done without doing anything."
            : "The action had no visible effect: the page didn't change after it.",
        );
      }

      // An action on the page.
      if (actions >= ctx.limits.actionsPerStep) {
        return end(
          "failed",
          "limit_reached",
          `The step used its ${ctx.limits.actionsPerStep} actions without finishing.`,
        );
      }
      const planned = await plan(ctx, call, observation, variables);
      if ("error" in planned) {
        note(`${planned.description}: ${planned.error}`);
        result.actions.push({
          tool: call.name,
          description: planned.description,
          status: planned.guard ? "guard_refused" : "invalid",
          message: planned.error,
        });
        if (planned.guard) {
          result.refusals.push(planned.error);
          lastRefusalWasGuard = true;
        }
        if (++consecutiveFailures >= ctx.limits.consecutiveFailures) {
          return end(
            "failed",
            lastRefusalWasGuard ? "guard_refused" : "limit_reached",
            `${ctx.limits.consecutiveFailures} refused or failed actions in a row. Last: ${planned.error}`,
          );
        }
        break;
      }

      actions++;
      actedSinceObserve++;
      const outcome = await ctx.session.act(planned.action);
      const report: ActionReport = {
        tool: call.name,
        description: planned.description,
        status: outcome.status,
        changed: outcome.post.changed,
        settledMs: outcome.settledMs,
      };
      if (outcome.reason) report.reason = outcome.reason;
      if (outcome.message) report.message = outcome.message;
      result.actions.push(report);
      note(`${planned.description} → ${summarize(outcome, variables)}`);
      for (const refusal of outcome.post.refused)
        result.refusals.push(`${refusal.type} ${refusal.url}`);

      if (
        outcome.status === "refused" &&
        (outcome.reason === "disallowed_domain" || outcome.reason === "missing_secret")
      ) {
        return end("stopped", outcome.reason, outcome.message);
      }
      if (outcome.status !== "ok") {
        lastRefusalWasGuard = false;
        if (++consecutiveFailures >= ctx.limits.consecutiveFailures) {
          return end(
            "failed",
            "limit_reached",
            `${ctx.limits.consecutiveFailures} failed actions in a row. Last: ${outcome.message ?? outcome.status}`,
          );
        }
        break;
      }
      consecutiveFailures = 0;
      lastRefusalWasGuard = false;
      const command = commandOf(planned.recorded, planned.fingerprint, outcome, variables.pageList);
      let effect = outcome.post.changed;
      // The harness compares elements as a set, so reordering (a sort) looks like no change.
      // Compare the order with the snapshot this action was planned on (only valid for the
      // first action since that snapshot). Observing resets the refs, so stop this reply here.
      if (!effect && actedSinceObserve === 1) {
        const after = await ctx.session.observe();
        if (orderSignature(after) !== orderSignature(observation)) {
          effect = true;
          report.changed = true;
          const last = history.length - 1;
          history[last] = (history[last] ?? "").replace(
            "NO visible change",
            "the page changed: its elements were reordered",
          );
        }
        executed.push({ outcome, recorded: planned.recorded, command, effect });
        break;
      }
      executed.push({ outcome, recorded: planned.recorded, command, effect });
      // The page moved on: the rest of this reply's refs may be stale.
      if (outcome.post.urlAfter !== outcome.post.urlBefore) break;
    }
  }
}

function acceptDone(executed: Executed[]): "accept" | "nothing_done" | "no_effect" {
  if (executed.length === 0) return "nothing_done";
  if (executed.some((e) => e.effect)) return "accept";
  return executed.every((e) => NO_EFFECT_OK.has(e.recorded.type)) ? "accept" : "no_effect";
}

type Planned =
  | {
      action: Action;
      recorded: RecordedAction;
      fingerprint: Fingerprint | null;
      description: string;
    }
  | { error: string; description: string; guard?: boolean };

/** Checks and translates one tool call: ref → element, value → template, guards. */
async function plan(
  ctx: AgentContext,
  call: Exclude<PlannerToolCall, { name: "look" | "step_done" | "step_impossible" }>,
  observation: Observation,
  variables: StepVariables,
): Promise<Planned> {
  const input = call.input as { ref?: string };
  const element = input.ref ? observation.elements.find((e) => e.ref === input.ref) : undefined;
  const on = input.ref ? `${input.ref}${describeElement(element)}` : "";
  let description = `${call.name}${on ? ` ${on}` : ""}`;
  if (input.ref && !element)
    return { error: `There is no element ${input.ref} in the current snapshot.`, description };

  // Values as templates; what the harness types.
  let template: string | undefined;
  let value: string | { secret: string } | undefined;
  if (
    call.name === "fill" ||
    call.name === "select" ||
    call.name === "goto" ||
    (call.name === "wait_for" && call.input.text !== undefined)
  ) {
    const typed =
      call.name === "fill"
        ? call.input.value
        : call.name === "select"
          ? call.input.option
          : call.name === "goto"
            ? call.input.url
            : (call.input.text as string);
    template = toTemplate(typed, variables.list);
    const resolved = harnessValue(template, variables);
    description += ` ${JSON.stringify(template)}`;
    if (!resolved.ok) return { error: resolved.error, description };
    if (typeof resolved.value !== "string" && call.name !== "fill") {
      return { error: "Secrets can only be typed into fields (fill).", description };
    }
    value = resolved.value;
  }

  const target = element
    ? {
        role: element.role,
        name: element.name,
        ...(element.text !== undefined ? { text: element.text } : {}),
      }
    : undefined;
  const decision = checkGuards(
    {
      type: call.name === "wait_for" ? "waitFor" : call.name,
      ...(target ? { target } : {}),
      ...(call.name === "goto" && typeof value === "string" ? { url: value } : {}),
    },
    ctx.guards,
  );
  if (!decision.allowed) return { error: decision.message, description, guard: true };

  // The locator and fingerprint are read before acting: the element may be gone after.
  let locator: Locator | undefined;
  let fingerprint: Fingerprint | null = null;
  if (input.ref) {
    const found = fingerprintOf(await ctx.session.candidates(input.ref));
    if (!found) return { error: `Element ${input.ref} is no longer on the page.`, description };
    locator = found.primary;
    fingerprint = found.fingerprint;
  }
  const ref = input.ref ? { ref: input.ref } : undefined;
  const need = <T>(v: T | undefined): T => v as T;

  switch (call.name) {
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
    case "hover":
      return {
        action: { type: call.name, target: need(ref) },
        recorded: { type: call.name, target: need(locator) },
        fingerprint,
        description,
      };
    case "fill":
      return {
        action: { type: "fill", target: need(ref), value: need(value) },
        recorded: { type: "fill", target: need(locator), value: need(template) },
        fingerprint,
        description,
      };
    case "select":
      return {
        action: { type: "select", target: need(ref), option: value as string },
        recorded: { type: "select", target: need(locator), option: need(template) },
        fingerprint,
        description,
      };
    case "press":
      description = `press ${call.input.key}${on ? ` in ${on}` : ""}`;
      return {
        action: { type: "press", key: call.input.key, ...(ref ? { target: ref } : {}) },
        recorded: { type: "press", key: call.input.key, ...(locator ? { target: locator } : {}) },
        fingerprint,
        description,
      };
    case "scroll":
      return {
        action: {
          type: "scroll",
          ...(ref ? { target: ref } : {}),
          ...(call.input.direction ? { direction: call.input.direction } : {}),
        },
        recorded: {
          type: "scroll",
          ...(locator ? { target: locator } : {}),
          ...(call.input.direction ? { direction: call.input.direction } : {}),
        },
        fingerprint,
        description,
      };
    case "upload":
      description += ` ${JSON.stringify(call.input.file)}`;
      return {
        action: { type: "upload", target: need(ref), files: call.input.file },
        recorded: { type: "upload", target: need(locator), files: [call.input.file] },
        fingerprint,
        description,
      };
    case "goto":
      return {
        action: { type: "goto", url: value as string },
        recorded: { type: "goto", url: portableUrl(need(template), ctx.session.url) },
        fingerprint: null,
        description,
      };
    case "back":
    case "reload":
      return {
        action: { type: call.name },
        recorded: { type: call.name },
        fingerprint: null,
        description,
      };
    case "wait_for": {
      const timeoutMs = call.input.seconds ? Math.round(call.input.seconds * 1000) : undefined;
      return {
        action: {
          type: "waitFor",
          ...(typeof value === "string" ? { text: value } : {}),
          ...(ref ? { target: ref } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
        recorded: {
          type: "waitFor",
          ...(template !== undefined ? { text: template } : {}),
          ...(locator ? { target: locator } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
        fingerprint,
        description,
      };
    }
  }
}
