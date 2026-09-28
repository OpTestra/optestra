import type { BudgetMeter, ModelCallRecord, Models } from "@testament/models";
import { type CheckOp, describeCheck, type Sanity } from "@testament/recording";
import type { PageCopy } from "../target/harness.js";
import { compileByAi } from "./ai.js";
import { type CheckSession, type EvaluatedCheck, evaluateCheck } from "./evaluate.js";
import { compileByRules, type Probe } from "./rules.js";
import { sanityTest } from "./sanity.js";

// Compiling one Expect/Soft line into a stored check (LOOP-2): rules first, the
// AI compiler only for what rules can't map. Every op is then evaluated once on
// the page and sanity-tested (VER-6); a check that proves nothing is
// regenerated once by the AI compiler, then flagged for the user. The line is
// never changed; a line that can't be compiled faithfully stays `pending` with
// the reason, rather than getting a weaker check.

export interface CheckLine {
  /** The line as a template (`{{refs}}` by name, secrets as `{{secret.NAME}}`). */
  text: string;
  soft: boolean;
}

export interface CompileContext {
  session: CheckSession;
  /** Absent: rules only. */
  models?: Models | undefined;
  budget?: BudgetMeter | undefined;
  signal?: AbortSignal | undefined;
  tags?: Record<string, string>;
  /** Values of the line's references (never secrets). */
  values: Readonly<Record<string, string>>;
  /**
   * Copy of the page taken as the preceding action step began: the sanity
   * test's before-state, and where network checks start counting requests.
   */
  before?: PageCopy | undefined;
  /** How long the authoring evaluation waits for the check to pass (default 5000 ms). */
  timeoutMs?: number;
}

export interface CompiledCheck {
  op: CheckOp;
  generatedBy: "rules" | "ai";
  rule?: string;
  /** describeCheck(op): what is checked, in plain English (EVD-3). */
  summary: string;
  /** The one evaluation while authoring; null when the op isn't compiled. */
  evaluation: EvaluatedCheck | null;
  sanity: Sanity | null;
  /** For the user: why the line has no trustworthy check. */
  problem?: string;
  records: ModelCallRecord[];
  /** "provider/model" of the AI compiler, when it was used. */
  model?: string;
}

export interface VerifiedCheck {
  evaluation: EvaluatedCheck;
  sanity: Sanity;
}

/** Evaluates an op once on the page and sanity-tests it. Used for every op, exact ones included. */
export async function verifyCheck(op: CheckOp, ctx: CompileContext): Promise<VerifiedCheck> {
  const evaluation = await evaluateCheck(ctx.session, op, {
    values: ctx.values,
    timeoutMs: ctx.timeoutMs ?? 5_000,
    since: ctx.before,
    models: ctx.models,
    budget: ctx.budget,
    signal: ctx.signal,
    ...(ctx.tags ? { tags: ctx.tags } : {}),
  });
  const sanity = await sanityTest(ctx.session, {
    op,
    values: ctx.values,
    now: evaluation,
    before: ctx.before,
  });
  return { evaluation, sanity };
}

function sanityProblem(sanity: Sanity): string {
  const where = [
    sanity.empty.result === "passed" ? "on an empty page" : "",
    sanity.before.result === "passed" ? "before the preceding action" : "",
  ]
    .filter(Boolean)
    .join(" and ");
  return `This check also passes ${where}, so it can't show that the step worked. Make the expectation more specific.`;
}

function pending(problem: string, records: ModelCallRecord[], model?: string): CompiledCheck {
  const op: CheckOp = { type: "pending" };
  return {
    op,
    generatedBy: "rules",
    summary: describeCheck(op),
    evaluation: null,
    sanity: null,
    problem,
    records,
    ...(model ? { model } : {}),
  };
}

export async function compileCheck(line: CheckLine, ctx: CompileContext): Promise<CompiledCheck> {
  const records: ModelCallRecord[] = [];
  let model: string | undefined;
  const observation = await ctx.session.observe();
  const probe: Probe = async (op, options) => {
    const result = await ctx.session.check(op, {
      timeoutMs: options?.timeoutMs ?? 0,
      values: ctx.values,
      // Since the step began: a toast it showed counts even once it's gone (Android).
      ...(ctx.before ? { since: ctx.before } : {}),
    });
    return {
      passed: result.passed,
      ...(result.matched !== undefined ? { matched: result.matched } : {}),
    };
  };
  const ai = async (tried: string[], feedback?: string) => {
    if (!ctx.models) return undefined;
    const result = await compileByAi(
      {
        line: line.text,
        soft: line.soft,
        observation: feedback ? await ctx.session.observe() : observation,
        tried,
        values: ctx.values,
        ...(feedback ? { feedback } : {}),
      },
      {
        models: ctx.models,
        budget: ctx.budget,
        signal: ctx.signal,
        ...(ctx.tags ? { tags: ctx.tags } : {}),
      },
    );
    if (result.record) records.push(result.record);
    if (result.model) model = result.model;
    return result;
  };

  const rules = await compileByRules(line.text, { observation, probe });
  let op: CheckOp;
  let generatedBy: "rules" | "ai";
  let rule: string | undefined;
  if (rules.ok) {
    op = rules.op;
    generatedBy = "rules";
    rule = rules.rule;
  } else if (rules.reason === "secret") {
    return pending(rules.message, records);
  } else {
    const result = await ai(rules.tried);
    if (!result)
      return pending(`${rules.message} No AI model is available to compile it.`, records);
    if (!result.ok) return pending(`${rules.message} ${result.message}`, records, model);
    op = result.op;
    generatedBy = "ai";
  }

  let verified = await verifyCheck(op, ctx);
  let problem: string | undefined;
  if (verified.evaluation.status === "refused" || verified.evaluation.status === "error") {
    problem =
      verified.evaluation.message ?? `The check could not run (${verified.evaluation.status}).`;
  }
  if (verified.sanity.provesNothing) {
    // Regenerate once, then flag the line for the user.
    const feedback = `${JSON.stringify(op)} ${sanityProblem(verified.sanity)}`;
    const retry = await ai(rule ? [rule] : [], feedback);
    if (retry?.ok) {
      const again = await verifyCheck(retry.op, ctx);
      if (!again.sanity.provesNothing) {
        op = retry.op;
        generatedBy = "ai";
        rule = undefined;
        verified = again;
      }
    }
    if (verified.sanity.provesNothing) problem = sanityProblem(verified.sanity);
  }
  return {
    op,
    generatedBy,
    ...(rule ? { rule } : {}),
    summary: describeCheck(op),
    evaluation: verified.evaluation,
    sanity: verified.sanity,
    ...(problem ? { problem } : {}),
    records,
    ...(model ? { model } : {}),
  };
}
