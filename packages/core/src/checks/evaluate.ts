import type {
  CheckEvaluation,
  LocatorSpec,
  PageCopy,
  RequestMark,
  Session,
} from "@testament/browser";
import type { BudgetMeter, ModelCallRecord, Models } from "@testament/models";
import type { CheckOp } from "@testament/recording";
import { z } from "zod";
import prompt from "./check-prompt.json" with { type: "json" };

// Evaluating a check: every deterministic op runs in the harness
// (`session.check`, no model). A `soft_judgment` asks a model about a
// screenshot; its result is marked `warnOnly` and can never make a test pass
// (VER-3).

/** The harness calls checks need. A LOOP-0 Session satisfies it. */
export type CheckSession = Pick<Session, "check" | "observe" | "screenshot" | "pageCopy">;

export interface EvaluateOptions {
  values?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** The copy taken as the current action step began: network checks count requests since then. */
  since?: RequestMark | PageCopy | undefined;
  /** Needed only for soft judgments. */
  models?: Models | undefined;
  budget?: BudgetMeter | undefined;
  signal?: AbortSignal | undefined;
  tags?: Record<string, string>;
}

export interface EvaluatedCheck extends CheckEvaluation {
  /** A model's judgment: it may warn, never pass a test. */
  warnOnly?: true;
  record?: ModelCallRecord;
  model?: string;
}

const Judgment = z.object({ answer: z.enum(["yes", "no", "unsure"]), reason: z.string() });

export async function evaluateCheck(
  session: CheckSession,
  op: CheckOp,
  options: EvaluateOptions = {},
): Promise<EvaluatedCheck> {
  if (op.type !== "soft_judgment") {
    return session.check(op, {
      ...(options.values ? { values: options.values } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.since ? { since: options.since } : {}),
    });
  }
  const started = Date.now();
  const base = {
    passed: false,
    expected: op.question,
    actual: null,
    attempts: 1,
    seen: "",
    warnOnly: true as const,
  };
  if (!options.models) {
    return { ...base, status: "unsupported", ms: 0, message: "A soft judgment needs an AI model." };
  }
  const shot = await session.screenshot({
    forModel: true,
    ...(op.screenshot === "element" && op.target ? { target: op.target as LocatorSpec } : {}),
  });
  if (shot.status !== "ok") {
    return {
      ...base,
      status: "error",
      ms: Date.now() - started,
      message: shot.message ?? "No screenshot.",
    };
  }
  const reply = await options.models.complete("planner", {
    system: prompt.judge.system,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt.judge.user.replace("{question}", JSON.stringify(op.question)),
          },
          { type: "image", data: shot.bytes, mediaType: shot.contentType },
        ],
      },
    ],
    output: Judgment,
    maxOutputTokens: 200,
    temperature: 0,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.budget ? { budgets: [options.budget] } : {}),
    tags: { ...options.tags, purpose: "soft-judgment" },
  });
  if (!reply.ok || !reply.object) {
    return {
      ...base,
      status: "error",
      ms: Date.now() - started,
      message: reply.ok ? "No answer." : reply.message,
      record: reply.record,
    };
  }
  const passed = reply.object.answer === "yes";
  return {
    ...base,
    status: passed ? "passed" : "failed",
    passed,
    actual: `${reply.object.answer}: ${reply.object.reason}`,
    ms: Date.now() - started,
    record: reply.record,
    model: `${reply.provider}/${reply.model}`,
  };
}
