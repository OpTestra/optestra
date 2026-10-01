import type { BudgetMeter, ModelCallRecord, Models } from "@optestra/models";
import { type CheckOp, CheckOpSchema } from "@optestra/recording";
import { z } from "zod";
import type { Observation } from "../target/harness.js";
import { isScreen, renderForModel } from "../target/render.js";
import prompt from "./check-prompt.json" with { type: "json" };

// The AI check compiler (LOOP-2): only for lines the phrase rules can't map.
// The planner answers with a typed CheckOp through structured output; the page
// goes in as untrusted content (SAF-3), exactly like LOOP-1's prompts. Its op is
// then sanity-tested like any other; nothing it says is taken as a verdict.

export const CHECK_PROMPT_VERSION: string = prompt.version;

const HARD_OPS = new Set(["text", "url", "element_state", "count", "value", "network"]);

type Option = (typeof CheckOpSchema.options)[number];

function opSchema(soft: boolean) {
  const options = CheckOpSchema.options.filter(
    (option: Option) =>
      HARD_OPS.has(option.shape.type.value) ||
      (soft && option.shape.type.value === "soft_judgment"),
  ) as unknown as [Option, Option, ...Option[]];
  return z.object({
    faithful: z.boolean(),
    reason: z.string(),
    check: z.discriminatedUnion("type", options).nullable(),
  });
}

export interface AiCompileInput {
  /** The line as a template (`{{refs}}` by name). */
  line: string;
  soft: boolean;
  observation: Observation;
  /** Rules whose phrase matched but failed, or "none". */
  tried: string[];
  /** Why an earlier op was rejected (the sanity test), for the one regeneration. */
  feedback?: string;
  /** `{{ref}}` → value, for the prompt. */
  values: Readonly<Record<string, string>>;
}

export interface AiCompileContext {
  models: Models;
  budget?: BudgetMeter | undefined;
  signal?: AbortSignal | undefined;
  tags?: Record<string, string>;
}

export type AiCompileResult =
  | { ok: true; op: CheckOp; record: ModelCallRecord; model: string }
  | { ok: false; message: string; record?: ModelCallRecord; model?: string };

export async function compileByAi(
  input: AiCompileInput,
  ctx: AiCompileContext,
): Promise<AiCompileResult> {
  const variables = Object.entries(input.values)
    .map(([ref, value]) => `- {{${ref}}} = ${JSON.stringify(value)}`)
    .join("\n");
  const user = prompt.user
    .replace("{kind}", input.soft ? "Soft:" : "Expect:")
    .replace("{line}", JSON.stringify(input.line))
    .replace("{tried}", input.tried.length ? input.tried.join(", ") : "none matched")
    .replace(
      "{feedback}",
      input.feedback ? `\nA previous check was rejected: ${input.feedback}\n` : "",
    )
    .replace("{variables}", variables || "(none)")
    .replace("{page}", renderForModel(input.observation));
  const reply = await ctx.models.complete("planner", {
    // On an app screen the same ops apply, with Android's words for them (MOB-1).
    system:
      prompt.system.replace("{soft}", input.soft ? prompt.soft : "") +
      (isScreen(input.observation) ? prompt.android : ""),
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    output: opSchema(input.soft),
    maxOutputTokens: 600,
    temperature: 0,
    cache: true,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.budget ? { budgets: [ctx.budget] } : {}),
    tags: { ...ctx.tags, purpose: "check" },
  });
  if (!reply.ok)
    return { ok: false, message: `${reply.message} ${reply.fix}`.trim(), record: reply.record };
  const model = `${reply.provider}/${reply.model}`;
  const answer = reply.object;
  if (!answer?.faithful || !answer.check) {
    return {
      ok: false,
      message: `The AI compiler found no faithful check: ${answer?.reason || "no reason given"}`,
      record: reply.record,
      model,
    };
  }
  const op = answer.check as CheckOp;
  if (op.type === "soft_judgment" && !input.soft) {
    return {
      ok: false,
      message: "soft_judgment is only allowed on Soft: lines.",
      record: reply.record,
      model,
    };
  }
  if (/(?<!\\)\{\{\s*secret\./.test(JSON.stringify(op))) {
    return {
      ok: false,
      message: "The AI compiler put a secret in a check; refused.",
      record: reply.record,
      model,
    };
  }
  return { ok: true, op, record: reply.record, model };
}
