import { defaultRegistry } from "@testament/config";
import { type DecisionRecord, ulid } from "@testament/contract";
import { type BackendAnswer, type DecisionBackend, validAnswer } from "./backend.js";
import { type CachedDecision, cacheKey, type DecisionCache } from "./cache.js";
import { taskProblems } from "./guard.js";
import { type DecisionMetrics, MetricsCollector } from "./metrics.js";
import type { DecisionsSettings } from "./section.js";
import {
  type AnyTask,
  type Answers,
  DEFAULT_TIME_LIMIT_MS,
  type DecisionPhase,
  type EscalateTo,
  type InputOf,
  type Questions,
  type QuestionsOf,
} from "./task.js";
import { BUILT_IN_TASKS, type DecisionTasks } from "./tasks/index.js";

/** Why a decision escalated instead of answering. */
export type EscalationReason =
  /** Rules couldn't tell and no backend is configured. */
  | "undecided"
  /** The best answer (rules or model) is below the threshold. */
  | "below_threshold"
  /** The time limit passed before the backend answered. */
  | "timeout"
  /** The backend failed, threw or answered something invalid. */
  | "backend_error"
  /** The input didn't match the task's schema. */
  | "invalid_input"
  /** Turned off in `decisions.tasks.<name>.enabled`. */
  | "disabled"
  /** No task with that name is registered. */
  | "unknown_task"
  /** The caller aborted it (e.g. it lost a race). No record is written. */
  | "aborted";

export interface ScoredAnswer<Q extends Questions = Questions> {
  answers: Answers<Q>;
  confidence: number;
  /** "rules" or the backend id. */
  source: string;
}

export interface Decided<Q extends Questions = Questions> extends ScoredAnswer<Q> {
  status: "decided";
  /** True when a model answer came from the cache. */
  cached: boolean;
  latencyMs: number;
  /** The contract record passed to `onDecision`. */
  record: DecisionRecord;
}

export interface Escalated<Q extends Questions = Questions> {
  status: "escalated";
  reason: EscalationReason;
  /** What the caller should do: call the fixer, ask a human, or block. */
  onEscalate: EscalateTo;
  /** The best answer seen, below threshold. Never act on it as a decision. */
  best?: ScoredAnswer<Q>;
  latencyMs: number;
  /** Null when aborted (an aborted decision is not a decision and is not recorded). */
  record: DecisionRecord | null;
}

export type DecisionResult<Q extends Questions = Questions> = Decided<Q> | Escalated<Q>;

export interface DecisionContext {
  /** Abort the decision (a race loser). Aborting cancels any backend call. */
  signal?: AbortSignal;
  /** Passed to `onDecision` so the runner can place the `decision.made` event. */
  testId?: string | null;
  attempt?: number | null;
  /** Skip the cache for this call: neither read nor write (evals). */
  bypassCache?: boolean;
}

export interface DecisionMeta {
  task: string;
  phase: DecisionPhase | null;
  testId: string | null;
  attempt: number | null;
  reason: EscalationReason | null;
  cached: boolean;
}

/** Called once per decision with its contract record. The runner emits `decision.made` from it. */
export type OnDecision = (record: DecisionRecord, meta: DecisionMeta) => void;

export interface DecisionsOptions {
  /** The resolved config (only `decisions` is read). Defaults to the built-in defaults. */
  config?: { decisions: DecisionsSettings };
  /** Extra tasks on top of the built-ins (DEC-2 adds built-ins instead). */
  tasks?: readonly AnyTask[];
  /** The decision model. None (the default) means rules only. DEC-1 builds this from config. */
  backend?: DecisionBackend | null;
  /** Where model answers are cached. Ignored when `decisions.cache.enabled` is false. */
  cache?: DecisionCache | null;
  onDecision?: OnDecision;
  /** Skip the cache for every call (evals, Bench). */
  bypassCache?: boolean;
  /** Monotonic clock in ms, for latencies. */
  now?: () => number;
  /** Epoch ms, for cache TTL. */
  wallClock?: () => number;
}

type TaskName = keyof DecisionTasks & string;
type TaskRef = TaskName | AnyTask | (string & {});
type QuestionsFor<T> = T extends TaskName
  ? QuestionsOf<DecisionTasks[T]>
  : T extends AnyTask
    ? QuestionsOf<T>
    : Questions;
type InputFor<T> = T extends TaskName
  ? InputOf<DecisionTasks[T]>
  : T extends AnyTask
    ? InputOf<T>
    : unknown;

export interface BatchItem {
  task: TaskRef;
  input: unknown;
  testId?: string | null;
  attempt?: number | null;
}

export type RaceResult<A, Q extends Questions = Questions> =
  | { winner: "decision"; decision: Decided<Q> }
  | { winner: "alternative"; value: A }
  | { winner: "none"; decision: Escalated<Q> };

export interface EffectiveTaskSettings {
  enabled: boolean;
  threshold: number;
  timeLimitMs: number;
}

export interface Decisions {
  /** Rules → backend (if configured, with the time left) → escalate. Never throws. */
  decide<T extends TaskRef>(
    task: T,
    input: InputFor<T>,
    ctx?: DecisionContext,
  ): Promise<DecisionResult<QuestionsFor<T>>>;
  /**
   * During-run decisions: run the decision and `alternative` (e.g. a fingerprint
   * re-find) at once; the first confident result wins and the other is aborted.
   * `alternative` resolves null/undefined when it isn't confident.
   */
  race<T extends TaskRef, A>(
    task: T,
    input: InputFor<T>,
    alternative: (signal: AbortSignal) => Promise<A | null | undefined>,
    ctx?: DecisionContext,
  ): Promise<RaceResult<A, QuestionsFor<T>>>;
  /** After-run decisions: the ones rules can't settle go to the backend in ONE request. */
  decideBatch(items: readonly BatchItem[], ctx?: DecisionContext): Promise<DecisionResult[]>;
  /** Registered tasks by name. */
  readonly tasks: ReadonlyMap<string, AnyTask>;
  /** Threshold, time limit and enabled flag after config overrides. */
  settingsFor(task: AnyTask): EffectiveTaskSettings;
  readonly backend: DecisionBackend | null;
  /** Per-task counters since this instance was created. */
  metrics(): DecisionMetrics;
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

function builtInSettings(): DecisionsSettings {
  return defaultRegistry.defaults().decisions as DecisionsSettings;
}

/** Threshold, time limit and enabled flag for a task: config override → task default → project default. */
export function taskSettings(task: AnyTask, settings: DecisionsSettings): EffectiveTaskSettings {
  const override = settings.tasks[task.name] ?? {};
  return {
    enabled: override.enabled ?? true,
    threshold: override.threshold ?? task.threshold ?? settings.threshold,
    timeLimitMs: override.timeLimitMs ?? task.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS[task.phase],
  };
}

/** Every question answered with a valid value, confidence in 0–1. */
function validRules(task: AnyTask, result: unknown): result is ScoredAnswer {
  if (!result || typeof result !== "object") return false;
  const { answers, confidence } = result as {
    answers?: Record<string, unknown>;
    confidence?: number;
  };
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return false;
  if (!answers || typeof answers !== "object") return false;
  return Object.entries(task.questions).every(([id, q]) =>
    validAnswer(q, { kind: q.kind, value: answers[id] as string | boolean, confidence }),
  );
}

type Stage =
  | { kind: "answer"; answer: ScoredAnswer; cached: boolean }
  | { kind: "failure"; reason: "timeout" | "backend_error" | "aborted" };

interface Pending {
  index: number;
  task: AnyTask;
  input: unknown;
  settings: EffectiveTaskSettings;
  rules: ScoredAnswer | null;
  key: string | null;
  testId: string | null;
  attempt: number | null;
}

export function createDecisions(options: DecisionsOptions = {}): Decisions {
  const settings = options.config?.decisions ?? builtInSettings();
  const backend = options.backend ?? null;
  const cache = settings.cache.enabled ? (options.cache ?? null) : null;
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => Date.now());
  const collector = new MetricsCollector();

  const tasks = new Map<string, AnyTask>();
  for (const task of [...BUILT_IN_TASKS, ...(options.tasks ?? [])]) {
    const problems = taskProblems(task);
    if (problems.length > 0)
      throw new Error(`Decision task "${task.name}" is invalid: ${problems.join("; ")}`);
    if (tasks.has(task.name)) throw new Error(`Decision task "${task.name}" is registered twice`);
    tasks.set(task.name, task);
  }

  const settingsFor = (task: AnyTask) => taskSettings(task, settings);

  function emit(
    record: DecisionRecord,
    meta: DecisionMeta,
    outcome: "rules" | "model" | "escalated",
  ) {
    collector.add(record.task, outcome, record.latencyMs, meta.cached);
    try {
      options.onDecision?.(record, meta);
    } catch {
      // The audit hook must never break a decision.
    }
  }

  function decided(
    start: number,
    task: AnyTask,
    answer: ScoredAnswer,
    cached: boolean,
    item: { testId: string | null; attempt: number | null },
  ): Decided {
    const latencyMs = round(now() - start);
    const record: DecisionRecord = {
      id: ulid(),
      task: task.name,
      answer: answer.answers,
      confidence: answer.confidence,
      source: answer.source,
      latencyMs,
      escalated: false,
    };
    emit(
      record,
      { task: task.name, phase: task.phase, ...item, reason: null, cached },
      answer.source === "rules" ? "rules" : "model",
    );
    return { status: "decided", ...answer, cached, latencyMs, record };
  }

  function escalated(
    start: number,
    taskName: string,
    task: AnyTask | undefined,
    reason: EscalationReason,
    best: ScoredAnswer | null,
    cached: boolean,
    item: { testId: string | null; attempt: number | null },
  ): Escalated {
    const latencyMs = round(now() - start);
    const onEscalate = task?.onEscalate ?? "fixer";
    const base = { status: "escalated" as const, reason, onEscalate, latencyMs };
    const withBest = best ? { ...base, best } : base;
    if (reason === "aborted") return { ...withBest, record: null };
    const record: DecisionRecord = {
      id: ulid(),
      task: taskName || "unknown",
      answer: best?.answers ?? null,
      confidence: best?.confidence ?? 0,
      source: best?.source ?? "none",
      latencyMs,
      escalated: true,
    };
    emit(
      record,
      { task: record.task, phase: task?.phase ?? null, ...item, reason, cached },
      "escalated",
    );
    return { ...withBest, record };
  }

  const better = (a: ScoredAnswer | null, b: ScoredAnswer | null) =>
    !a ? b : !b ? a : b.confidence > a.confidence ? b : a;

  /** Waits for `work` until `ms` passes or `signal` aborts; aborts `controller` either way. */
  async function withDeadline<T>(
    ms: number,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | "timeout" | "aborted"> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
      onAbort = () => resolve("aborted");
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([work(controller.signal), stop]);
      if (outcome === "timeout" || outcome === "aborted") controller.abort(outcome);
      return outcome;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  function toScored(
    task: AnyTask,
    raw: Record<string, BackendAnswer>,
    prefix: string,
    source: string,
  ): ScoredAnswer | null {
    const answers: Record<string, unknown> = {};
    let confidence = 1;
    for (const [id, question] of Object.entries(task.questions)) {
      const answer = raw[prefix + id];
      if (!validAnswer(question, answer) || !answer) return null;
      answers[id] = answer.value;
      confidence = Math.min(confidence, answer.confidence);
    }
    return { answers: answers as Answers<Questions>, confidence, source };
  }

  /** Cache reads, then one backend request for everything still open. */
  async function backendStage(
    active: DecisionBackend,
    pending: Pending[],
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Map<number, Stage>> {
    const out = new Map<number, Stage>();
    const ask: Pending[] = [];
    for (const item of pending) {
      const hit = item.key ? await cache?.get(item.key).catch(() => undefined) : undefined;
      const fresh = hit && wallClock() - hit.storedAt <= settings.cache.ttlSeconds * 1000;
      const answer =
        fresh && hit
          ? toScored(
              item.task,
              Object.fromEntries(
                Object.entries(item.task.questions).map(([id, q]) => [
                  id,
                  { kind: q.kind, value: hit.answers[id], confidence: hit.confidence },
                ]),
              ) as Record<string, BackendAnswer>,
              "",
              hit.source,
            )
          : null;
      if (answer) out.set(item.index, { kind: "answer", answer, cached: true });
      else ask.push(item);
    }
    if (ask.length === 0) return out;

    // One item keeps its own question ids; a batch prefixes them with the item index.
    const single = ask.length === 1;
    const prefixOf = (item: Pending) => (single ? "" : `${item.index}.`);
    const questions: Questions = {};
    const states: string[] = [];
    for (const item of ask) {
      let state: string;
      try {
        state = item.task.state(item.input);
      } catch {
        out.set(item.index, { kind: "failure", reason: "backend_error" });
        continue;
      }
      states.push(single ? state : `### Decision ${item.index}: ${item.task.name}\n${state}`);
      for (const [id, q] of Object.entries(item.task.questions)) {
        questions[prefixOf(item) + id] = single
          ? q
          : { ...q, instructions: `[Decision ${item.index}] ${q.instructions}` };
      }
    }
    const asked = ask.filter((item) => !out.has(item.index));
    if (asked.length === 0) return out;

    let response: Awaited<ReturnType<DecisionBackend["answer"]>>;
    try {
      response = await active.answer(
        { state: states.join("\n\n"), questions },
        { signal, timeoutMs },
      );
    } catch (error) {
      response = { ok: false, failure: { reason: "backend_error", message: String(error) } };
    }
    for (const item of asked) {
      const answer = response.ok
        ? toScored(item.task, response.answers, prefixOf(item), active.id)
        : null;
      if (!answer) {
        out.set(item.index, {
          kind: "failure",
          reason: signal.aborted ? "aborted" : "backend_error",
        });
        continue;
      }
      out.set(item.index, { kind: "answer", answer, cached: false });
      if (item.key) {
        const entry: CachedDecision = { ...answer, storedAt: wallClock() };
        void cache?.set(item.key, entry).catch(() => {});
      }
    }
    return out;
  }

  async function decideBatch(
    items: readonly BatchItem[],
    ctx: DecisionContext = {},
  ): Promise<DecisionResult[]> {
    const start = now();
    const results: DecisionResult[] = new Array(items.length);
    const pending: Pending[] = [];
    const useCache = cache !== null && !ctx.bypassCache && !options.bypassCache;

    items.forEach((item, index) => {
      const meta = {
        testId: item.testId ?? ctx.testId ?? null,
        attempt: item.attempt ?? ctx.attempt ?? null,
      };
      const task = typeof item.task === "string" ? tasks.get(item.task) : item.task;
      const name = typeof item.task === "string" ? item.task : item.task.name;
      if (!task) {
        results[index] = escalated(start, name, undefined, "unknown_task", null, false, meta);
        return;
      }
      const effective = settingsFor(task);
      if (!effective.enabled) {
        results[index] = escalated(start, name, task, "disabled", null, false, meta);
        return;
      }
      const parsed = task.input.safeParse(item.input);
      if (!parsed.success) {
        results[index] = escalated(start, name, task, "invalid_input", null, false, meta);
        return;
      }
      let rules: ScoredAnswer | null = null;
      try {
        const raw = task.rules(parsed.data);
        if (validRules(task, raw)) rules = { ...raw, source: "rules" };
      } catch {
        // A throwing rule is an undecided rule.
      }
      if (rules && rules.confidence >= effective.threshold) {
        results[index] = decided(start, task, rules, false, meta);
        return;
      }
      if (!backend) {
        results[index] = escalated(
          start,
          name,
          task,
          rules ? "below_threshold" : "undecided",
          rules,
          false,
          meta,
        );
        return;
      }
      pending.push({
        index,
        task,
        input: parsed.data,
        settings: effective,
        rules,
        key: useCache ? cacheKey(task.name, task.version, parsed.data, backend.id) : null,
        ...meta,
      });
    });

    if (pending.length > 0 && backend) {
      // The batch gets the tightest time limit of its members, minus the time already spent.
      const limit = Math.min(...pending.map((p) => p.settings.timeLimitMs)) - (now() - start);
      const outcome =
        limit <= 0
          ? ("timeout" as const)
          : await withDeadline(limit, ctx.signal, (signal) =>
              backendStage(backend, pending, signal, limit),
            );
      for (const item of pending) {
        const stage: Stage =
          typeof outcome === "string"
            ? { kind: "failure", reason: outcome }
            : (outcome.get(item.index) ?? { kind: "failure", reason: "backend_error" });
        const meta = { testId: item.testId, attempt: item.attempt };
        if (stage.kind === "answer" && stage.answer.confidence >= item.settings.threshold) {
          results[item.index] = decided(start, item.task, stage.answer, stage.cached, meta);
        } else if (stage.kind === "answer") {
          results[item.index] = escalated(
            start,
            item.task.name,
            item.task,
            "below_threshold",
            better(item.rules, stage.answer),
            stage.cached,
            meta,
          );
        } else {
          results[item.index] = escalated(
            start,
            item.task.name,
            item.task,
            stage.reason,
            item.rules,
            false,
            meta,
          );
        }
      }
    }
    return results;
  }

  const api: Decisions = {
    tasks,
    backend,
    settingsFor,
    metrics: () => collector.snapshot(),
    decideBatch,
    async decide(task, input, ctx = {}) {
      const [result] = await decideBatch([{ task, input }], ctx);
      return result as DecisionResult<never>;
    },
    race(task, input, alternative, ctx = {}) {
      const decisionAbort = new AbortController();
      const alternativeAbort = new AbortController();
      const onOuterAbort = () => {
        decisionAbort.abort();
        alternativeAbort.abort();
      };
      if (ctx.signal?.aborted) onOuterAbort();
      else ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });

      const decision = api.decide(task, input, { ...ctx, signal: decisionAbort.signal });
      const other = (async () => {
        try {
          return (await alternative(alternativeAbort.signal)) ?? null;
        } catch {
          return null;
        }
      })();

      return new Promise((resolve) => {
        let decisionResult: DecisionResult | undefined;
        let alternativeDone = false;
        let alternativeValue: unknown = null;
        const done = (result: RaceResult<unknown>) => {
          ctx.signal?.removeEventListener("abort", onOuterAbort);
          resolve(result as never);
        };
        void decision.then((result) => {
          decisionResult = result;
          if (result.status === "decided") {
            alternativeAbort.abort();
            done({ winner: "decision", decision: result });
          } else if (alternativeDone) {
            done(
              alternativeValue !== null
                ? { winner: "alternative", value: alternativeValue }
                : { winner: "none", decision: result },
            );
          }
        });
        void other.then((value) => {
          alternativeDone = true;
          alternativeValue = value;
          if (value !== null) {
            if (!decisionResult) decisionAbort.abort();
            if (decisionResult?.status !== "decided") done({ winner: "alternative", value });
          } else if (decisionResult && decisionResult.status === "escalated") {
            done({ winner: "none", decision: decisionResult });
          }
        });
      });
    },
  };
  return api;
}
