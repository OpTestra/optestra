# @testament/decide

The decision layer: the one place every small typed decision goes through
("is this the same button?", "was this failure the app or the network?").
Rules answer first. A decision model answers only what rules can't. Below a
confidence threshold the decision escalates instead of guessing.

## Entry points

| Import | Use | Runs in |
|---|---|---|
| `@testament/decide` | task contract, `createDecisions` (decide, race, batch), backend interface, `mockBackend`, `memoryCache`, metrics, the `decisions` config section, built-in tasks | browser and Node |
| `@testament/decide/node` | `fileCache(projectDir)` (`.testament/decisions/`) and `createLabelStore(projectDir)` (`.testament/labels/`) | Node |

Importing the main entry registers the `decisions` config section.

## Guarantees

1. **Decisions never decide a verdict (LRN-8).** A task may not ask a question
   whose id, options or levels contain `passed failed healed flaky blocked pass
   fail verdict`, or whose instructions judge whether a test passed. `createDecisions`
   refuses such a task (`taskProblems`), and a test checks every registered task.
   `DecisionRecord` has no verdict field, and `decidedBy` can't name a decision.
2. **Rules first, always available (LRN-7).** With no backend (the default), every
   call returns an answer or an escalation. Nothing else in the engine needs this layer.
3. **Never guess below threshold.** If neither rules nor model reach the threshold,
   the result is `status: "escalated"`. The best below-threshold answer is offered
   as `best`, and it must never be treated as a decision.
4. **Hard time limits.** Every decision has one. On timeout the backend call is
   aborted and the result is an escalation that carries the rules answer as `best`.
5. **Everything is audited.** Every decision (including escalations) calls
   `onDecision(record, meta)` with a contract `DecisionRecord`. The runner emits
   `decision.made` from it. The only exception is a decision aborted by its caller,
   for example one that lost a race: it made no decision, so there is no record.
6. **No network here.** Backends are passed in through the `DecisionBackend` interface.

`decide`, `race` and `decideBatch` never throw. Unknown tasks, invalid input,
throwing rules, failing backends and throwing audit hooks all end in an answer or
an escalation.

## The pipeline

```
input ─► zod parse ─► rules(input)
            │            │ confidence ≥ threshold ─────────────► decided (source "rules")
            │            ▼
            │     backend configured and time left?
            │            │ no ─────────────────────────────────► escalated (undecided | below_threshold)
            │            ▼
            │     cache hit? ─► else backend.answer(state, questions, { signal, timeoutMs: time left })
            │            │ confidence ≥ threshold ─────────────► decided (source = backend id)
            │            ▼
            └──────────► escalated (below_threshold | timeout | backend_error), best = the better of rules / model
```

Escalation reasons: `undecided`, `below_threshold`, `timeout`, `backend_error`,
`invalid_input`, `disabled`, `unknown_task`, `aborted`. Every escalation also
carries the task's `onEscalate` (`fixer | human | block`), which tells the caller
what to do next.

```ts
import { createDecisions } from "@testament/decide";
import { fileCache } from "@testament/decide/node";

const decisions = createDecisions({
  config,                       // resolved config; only `decisions` is read
  backend: null,                // DEC-1 builds Jev/Kev/Laya from config
  cache: fileCache(projectDir),
  onDecision: (record, { testId, attempt }) =>
    writer.emit({ type: "decision.made", testId, attempt, decision: record }),
});

const result = await decisions.decide("page_is_error", { status, title, heading, text });
if (result.status === "decided") result.answers.is_error; // boolean, typed from the task
else result.onEscalate;                                   // "fixer"
```

- **`race(task, input, alternative, ctx)`** is for decisions made during the run.
  The decision and `alternative(signal)` (for example a fingerprint re-find) run
  at the same time. The first confident result wins, and the other side is
  aborted through its `AbortSignal`. `alternative` resolves `null` when it isn't
  confident. The result is `{ winner: "decision" | "alternative" | "none" }`.
  The alternative is the caller's own code, so it must enforce its own time limit.
- **`decideBatch(items, ctx)`** is for decisions made after the run. Rules and
  cache settle what they can. Everything left goes to the backend in **one**
  request, with question ids prefixed by the item index (`0.is_error`,
  `1.is_error`) and one state section per item. Each item still gets its own
  result and record. The batch's time limit is the tightest one among its members.
- **`metrics()`** returns counters per task: `total`, `rules`, `model`,
  `escalated`, `cacheHits`, their percentages, and `p50Ms`/`p95Ms` latency.
  `metricsFromRecords(records)` computes the same numbers from a run folder
  (`cacheHits` is `null` there, because records don't carry it).

## Writing a task

A task is one spec. Add the file under `src/tasks/`, list it in
`BUILT_IN_TASKS`, and add it to the `DecisionTasks` interface so that
`decide("name", input)` is typed. The pipeline needs no change.

```ts
export const pageIsError = defineTask({
  name: "page_is_error",          // snake_case; config key, record task, cache key, label file
  version: 1,                     // bump when meaning changes: old cache entries stop matching
  description: "Is the current page an error page?",
  phase: "during",                // "during" (fast, raced) | "after" (batched)
  input: z.object({ status: z.number().int().nullable(), title: z.string(), heading: z.string(), text: z.string() }),
  questions: {
    is_error: { kind: "noul", instructions: "This page is an error page ..." },
  },
  rules(input) {                  // pure, well under 1 ms; null = can't tell
    if (input.status !== null && input.status >= 500) return { answers: { is_error: true }, confidence: 0.97 };
    return null;
  },
  state(input) {                  // what a model sees; page text wrapped in untrusted()
    return [`HTTP status: ${input.status}`, untrusted("page-title", input.title)].join("\n");
  },
  onEscalate: "fixer",
  // threshold?: 0.9,  timeLimitMs?: 150   (defaults: project threshold; 100 ms during / 2000 ms after)
});
```

The question kinds map to what System One decision models (Jev, Kev, Laya) answer:

| Kind | Declares | Answer value |
|---|---|---|
| `choice` | `options: [...]` (at least 2) | one option |
| `score` | `levels: [...]` ordered low → high (at least 2) | one level |
| `noul` | a statement in `instructions` | `true` / `false` |

A backend answers every question as `{ kind, value, confidence, probabilities? }`.
The decision's confidence is the lowest confidence across its questions. A rules
answer returns every question plus one confidence. A rules answer below the
threshold is still useful: it goes to the backend, and it becomes `best` if the
decision escalates.

## Config (`decisions`)

```yaml
decisions:
  backend: none          # none = rules only (default). DEC-1 adds jev | kev | laya.
  threshold: 0.8         # project default
  tasks:
    page_is_error: { threshold: 0.9, timeLimitMs: 150, enabled: true }
  cache: { enabled: true, ttlSeconds: 604800 }
```

For each task, the first setting found applies:
- threshold: `tasks.<name>.threshold`, then the task's own `threshold`, then `decisions.threshold`.
- time limit: `tasks.<name>.timeLimitMs`, then the task's `timeLimitMs`, then the phase default.

`enabled: false` makes the task escalate with reason `disabled`. The section can
be overridden per environment. `testament decisions` lists the effective values
and warns about override names that match no task.

## Cache

Only model answers are cached. Rules answers are instant, so they never are.
The key is `cacheKey(task, version, input, backendId)`: canonical JSON of the
zod-parsed input with sorted keys. `fileCache` stores one file per key, named by
the key's sha256, under `.testament/decisions/`. An entry older than `ttlSeconds`
is a miss. `bypassCache` (on the instance or on a single call) skips both reads
and writes, for evals. Cache writes never slow a decision down.

## Labelled examples (LRN-9)

```ts
const labels = createLabelStore(projectDir);
labels.recordLabel(pageIsError, input, { is_error: true }, { source: "confirmed" }); // approved | rejected | confirmed
labels.readLabels("page_is_error");
```

Each call appends one line to `.testament/labels/<task>.jsonl`, with the task
version, source, time, parsed input and answers. Every line passes through the
redactor (the process-wide one by default). If the answers don't fit the task's
questions, the call throws. Training (`testament train`) and evals come later.

## CLI

- `testament decisions [--json]` shows the backend, the threshold, the cache and every task, with its effective threshold, limit, phase, escalation and questions.
- `testament decisions --stats <runDir> [--json]` prints metrics per task, built from the run's `decision.made` events (or from its documents when there are no events).
