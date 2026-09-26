import type { DecisionBackend } from "../../backend.js";
import { createDecisions } from "../../decide.js";
import type { DecisionsSettings } from "../../section.js";
import type { PageIsErrorInput } from "../../tasks/page-is-error.js";

/**
 * Fixed `page_is_error` inputs the rules can't settle (so every one reaches the
 * backend), with the answer a person would give.
 */
export const BENCH_INPUTS: readonly { input: PageIsErrorInput; expected: boolean }[] = [
  {
    input: { status: 403, title: "Acme", heading: "", text: "Please sign in to continue." },
    expected: false,
  },
  {
    input: { status: null, title: "Acme Shop", heading: "", text: "Loading your cart…" },
    expected: false,
  },
  {
    input: {
      status: 200,
      title: "Acme Shop",
      heading: "Help",
      text: "Page not found? Contact our support team.",
    },
    expected: false,
  },
  {
    input: {
      status: 200,
      title: "Acme",
      heading: "",
      text: "We can't find the page you're looking for. Go home.",
    },
    expected: true,
  },
  {
    input: {
      status: 400,
      title: "Acme",
      heading: "",
      text: "The request could not be understood by the server.",
    },
    expected: true,
  },
  {
    input: {
      status: null,
      title: "Acme Shop",
      heading: "",
      text: "Something went wrong. Please try again later.",
    },
    expected: true,
  },
  {
    input: { status: 401, title: "Sign in", heading: "", text: "Enter your email and password." },
    expected: false,
  },
  {
    input: {
      status: 200,
      title: "Acme",
      heading: "",
      text: "Error: cannot read properties of undefined (reading 'items')",
    },
    expected: true,
  },
  {
    input: { status: 302, title: "Redirecting", heading: "", text: "Redirecting you to checkout." },
    expected: false,
  },
  {
    input: {
      status: 200,
      title: "Checkout",
      heading: "",
      text: "Your order could not be placed due to an internal error.",
    },
    expected: true,
  },
];

export interface BenchResult {
  backend: string;
  /** Decisions measured (after the warm-up). */
  n: number;
  warmUpMs: number | null;
  p50Ms: number;
  p95Ms: number;
  /** Share of decisions where the backend failed (timeout, 429, unreachable, bad response). */
  errorRate: number;
  decided: number;
  escalated: number;
  /** Decided answers that match the expected answer. */
  agreement: number;
  /** Share of decisions that finished within the during-run limit (100 ms by default). */
  withinDuringLimit: number;
  duringLimitMs: number;
  failures: Record<string, number>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1] ?? 0;
}

/**
 * Runs `page_is_error` `n` times over `BENCH_INPUTS` against one backend, after
 * a warm-up, with the cache off and a generous time limit so raw latency is
 * measured; `withinDuringLimit` says how many would have met the real limit.
 */
export async function benchBackend(
  backend: DecisionBackend,
  settings: DecisionsSettings,
  options: { n?: number; timeLimitMs?: number; duringLimitMs?: number } = {},
): Promise<BenchResult> {
  const n = options.n ?? 50;
  const duringLimitMs = options.duringLimitMs ?? 100;
  const timeLimitMs = options.timeLimitMs ?? 10_000;
  let warmUpMs: number | null = null;
  if (backend.warmUp) {
    const start = performance.now();
    await backend.warmUp({ timeoutMs: settings.laya.warmUpTimeoutMs });
    warmUpMs = Math.round(performance.now() - start);
  } else {
    // One unmeasured call opens the connection, as a run's first decision would.
    await backend.answer(
      {
        state: "Warm-up.",
        questions: { ready: { kind: "noul", instructions: "This is a warm-up." } },
      },
      { signal: new AbortController().signal, timeoutMs: timeLimitMs },
    );
  }

  const failures: Record<string, number> = {};
  const decisions = createDecisions({
    config: {
      decisions: {
        ...settings,
        tasks: { ...settings.tasks, page_is_error: { enabled: true, timeLimitMs } },
      },
    },
    backend,
    bypassCache: true,
    onDecision: (_record, meta) => {
      if (meta.backend?.failure)
        failures[meta.backend.failure] = (failures[meta.backend.failure] ?? 0) + 1;
    },
  });
  const latencies: number[] = [];
  let decided = 0;
  let agreement = 0;
  for (let i = 0; i < n; i++) {
    const item = BENCH_INPUTS[i % BENCH_INPUTS.length];
    if (!item) continue;
    const start = performance.now();
    const result = await decisions.decide("page_is_error", item.input);
    latencies.push(performance.now() - start);
    if (result.status === "decided") {
      decided++;
      if (result.answers.is_error === item.expected) agreement++;
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const errors = Object.values(failures).reduce((a, b) => a + b, 0);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    backend: backend.id,
    n,
    warmUpMs,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    errorRate: n ? round((errors / n) * 100) / 100 : 0,
    decided,
    escalated: n - decided,
    agreement,
    withinDuringLimit: n
      ? round((latencies.filter((l) => l <= duringLimitMs).length / n) * 100) / 100
      : 0,
    duringLimitMs,
    failures,
  };
}
