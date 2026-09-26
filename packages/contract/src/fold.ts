import { z } from "zod";
import type { CheckResult } from "./check.js";
import type { ArtifactRef, Tokens } from "./common.js";
import type { AttemptStatus } from "./enums.js";
import type { Event, EventOf } from "./events.js";
import type { HealProposal } from "./heal.js";
import { runLayout } from "./layout.js";
import type { DecisionRecord, ModelCall } from "./records.js";
import { type Run, RunSchema } from "./run.js";
import type { StepResult } from "./step.js";
import { type AiUsage, type TestResult, TestResultSchema } from "./test-result.js";

export class FoldError extends Error {
  override name = "FoldError";
}

export interface FoldResult {
  run: Run;
  tests: TestResult[];
}

interface AttemptState {
  start: EventOf<"attempt.started">;
  finish?: EventOf<"attempt.finished">;
  steps: StepResult[];
  checks: CheckResult[];
  modelCalls: ModelCall[];
  decisions: DecisionRecord[];
  heals: HealProposal[];
  artifacts: ArtifactRef[];
}

interface TestState {
  start: EventOf<"test.started">;
  attempts: Map<number, AttemptState>;
  finish?: EventOf<"test.finished">;
}

const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

function elapsed(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  if (ms < 0) throw new FoldError(`time goes backwards: ${to} is before ${from}`);
  return ms;
}

function usage(calls: readonly ModelCall[]): Omit<AiUsage, "recent"> {
  const tokens: Tokens = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  let costUsd = 0;
  let unpricedCalls = 0;
  for (const call of calls) {
    tokens.input += call.tokens.input;
    tokens.output += call.tokens.output;
    tokens.cached += call.tokens.cached;
    tokens.cacheWrite += call.tokens.cacheWrite;
    if (call.costUsd === null) unpricedCalls++;
    else costUsd += call.costUsd;
  }
  return { calls: calls.length, costUsd: roundUsd(costUsd), unpricedCalls, tokens };
}

function validated<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FoldError(`${what} is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Replays an event stream into the final Run and TestResult documents. The run
 * writer uses this to write run.json, so folding a run's events.ndjson always
 * reproduces its documents exactly. Throws FoldError on an incomplete or
 * inconsistent stream. Events of unknown types must be filtered out first
 * (readRun does this).
 */
export function foldEvents(events: readonly Event[]): FoldResult {
  let started: EventOf<"run.started"> | undefined;
  let finished: EventOf<"run.finished"> | undefined;
  let lastSeq = -1;
  const tests = new Map<string, TestState>();
  const runCalls: ModelCall[] = [];
  const runDecisions: DecisionRecord[] = [];
  const runArtifacts: ArtifactRef[] = [];

  const test = (testId: string, event: Event): TestState => {
    const state = tests.get(testId);
    if (!state) throw new FoldError(`seq ${event.seq}: ${event.type} for unknown test "${testId}"`);
    if (state.finish)
      throw new FoldError(`seq ${event.seq}: ${event.type} after test "${testId}" finished`);
    return state;
  };
  const attempt = (testId: string, n: number, event: Event, open = true): AttemptState => {
    const state = test(testId, event).attempts.get(n);
    if (!state)
      throw new FoldError(
        `seq ${event.seq}: ${event.type} for unknown attempt ${n} of "${testId}"`,
      );
    if (open && state.finish)
      throw new FoldError(
        `seq ${event.seq}: ${event.type} after attempt ${n} of "${testId}" finished`,
      );
    return state;
  };
  /** Model calls, decisions and artifacts go to their attempt, or to the run. */
  const holder = (event: { testId: string | null; attempt: number | null } & Event) => {
    if (event.testId === null) {
      if (event.attempt !== null) throw new FoldError(`seq ${event.seq}: attempt without testId`);
      return null;
    }
    if (event.attempt === null) throw new FoldError(`seq ${event.seq}: testId without attempt`);
    return attempt(event.testId, event.attempt, event, false);
  };

  for (const event of events) {
    if (event.seq <= lastSeq) throw new FoldError(`seq ${event.seq} does not follow ${lastSeq}`);
    lastSeq = event.seq;
    if (!started) {
      if (event.type !== "run.started") throw new FoldError("the first event must be run.started");
    } else if (event.runId !== started.runId) {
      throw new FoldError(`seq ${event.seq}: runId ${event.runId} does not match ${started.runId}`);
    }
    if (finished) throw new FoldError(`seq ${event.seq}: ${event.type} after run.finished`);

    switch (event.type) {
      case "run.started":
        if (started) throw new FoldError(`seq ${event.seq}: second run.started`);
        started = event;
        break;
      case "test.started":
        if (tests.has(event.testId))
          throw new FoldError(`seq ${event.seq}: test "${event.testId}" started twice`);
        tests.set(event.testId, { start: event, attempts: new Map() });
        break;
      case "attempt.started": {
        const state = test(event.testId, event);
        if (state.attempts.has(event.attempt) || event.attempt !== state.attempts.size + 1)
          throw new FoldError(
            `seq ${event.seq}: attempt ${event.attempt} of "${event.testId}" is out of order`,
          );
        for (const previous of state.attempts.values())
          if (!previous.finish)
            throw new FoldError(`seq ${event.seq}: attempt started before the last one finished`);
        state.attempts.set(event.attempt, {
          start: event,
          steps: [],
          checks: [],
          modelCalls: [],
          decisions: [],
          heals: [],
          artifacts: [],
        });
        break;
      }
      case "step.started":
        attempt(event.testId, event.attempt, event);
        break;
      case "step.finished":
        attempt(event.testId, event.attempt, event).steps.push(event.step);
        break;
      case "check.evaluated":
        attempt(event.testId, event.attempt, event).checks.push(event.check);
        break;
      case "heal.proposed":
        attempt(event.testId, event.attempt, event).heals.push(event.heal);
        break;
      case "model.called":
        (holder(event)?.modelCalls ?? runCalls).push(event.call);
        break;
      case "decision.made":
        (holder(event)?.decisions ?? runDecisions).push(event.decision);
        break;
      case "artifact.written":
        (holder(event)?.artifacts ?? runArtifacts).push(event.artifact);
        break;
      case "attempt.finished":
        attempt(event.testId, event.attempt, event).finish = event;
        break;
      case "test.finished": {
        const state = test(event.testId, event);
        for (const a of state.attempts.values())
          if (!a.finish)
            throw new FoldError(
              `seq ${event.seq}: test finished with attempt ${a.start.attempt} open`,
            );
        state.finish = event;
        break;
      }
      case "run.finished":
        for (const [testId, state] of tests)
          if (!state.finish)
            throw new FoldError(`seq ${event.seq}: run finished with test "${testId}" open`);
        finished = event;
        break;
      case "log":
        break;
    }
  }
  if (!started) throw new FoldError("no run.started event");
  if (!finished) throw new FoldError("no run.finished event: the run is not complete");
  const runStart = started;

  const results = [...tests.values()].map((state): TestResult => {
    const finish = state.finish as EventOf<"test.finished">;
    const attempts = [...state.attempts.values()].map((a) => {
      const end = a.finish as EventOf<"attempt.finished">;
      return {
        attempt: a.start.attempt,
        status: end.status satisfies AttemptStatus,
        startedAt: a.start.ts,
        durationMs: elapsed(a.start.ts, end.ts),
        steps: a.steps,
        checks: a.checks,
        modelCalls: a.modelCalls,
        decisions: a.decisions,
        heals: a.heals,
        artifacts: a.artifacts,
      };
    });
    return validated(
      TestResultSchema,
      {
        contractVersion: runStart.contractVersion,
        runId: runStart.runId,
        testId: state.start.testId,
        file: state.start.file,
        name: state.start.name,
        tags: state.start.tags,
        matrix: state.start.matrix,
        verdict: finish.verdict,
        decidedBy: finish.decidedBy,
        failureCause: finish.failureCause,
        failureEvidence: finish.failureEvidence,
        headline: finish.headline,
        checkedSummary: finish.checkedSummary,
        startedAt: state.start.ts,
        durationMs: elapsed(state.start.ts, finish.ts),
        ai: { ...usage(attempts.flatMap((a) => a.modelCalls)), recent: finish.recentAi },
        attempts,
      },
      `test "${state.start.testId}"`,
    );
  });

  const allCalls = [
    ...results.flatMap((t) => t.attempts.flatMap((a) => a.modelCalls)),
    ...runCalls,
  ];
  const total = usage(allCalls);
  const count = (verdict: TestResult["verdict"]) =>
    results.filter((t) => t.verdict === verdict).length;
  const run = validated(
    RunSchema,
    {
      contractVersion: runStart.contractVersion,
      runId: runStart.runId,
      engineVersion: runStart.engineVersion,
      project: runStart.project,
      environment: runStart.environment,
      target: runStart.target,
      trigger: runStart.trigger,
      mode: runStart.mode,
      startedAt: runStart.ts,
      finishedAt: finished.ts,
      durationMs: elapsed(runStart.ts, finished.ts),
      blocked: finished.blocked,
      totals: {
        tests: results.length,
        passed: count("passed"),
        healed: count("healed"),
        failed: count("failed"),
        flaky: count("flaky"),
        blocked: count("blocked"),
      },
      cost: {
        usd: total.costUsd,
        unpricedCalls: total.unpricedCalls,
        aiCalls: total.calls,
        tokens: total.tokens,
      },
      git: runStart.git,
      tests: results.map((t) => ({
        testId: t.testId,
        name: t.name,
        file: t.file,
        verdict: t.verdict,
        headline: t.headline,
        durationMs: t.durationMs,
        attempts: t.attempts.length,
        aiCalls: t.ai.calls,
        costUsd: t.ai.costUsd,
        result: runLayout.testResult(t.testId),
      })),
      modelCalls: runCalls,
      decisions: runDecisions,
      artifacts: runArtifacts,
    },
    "run",
  );
  return { run, tests: results };
}
