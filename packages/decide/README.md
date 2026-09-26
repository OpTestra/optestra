# @testament/decide

The decision layer: the one place every small typed decision goes through
("is this the same button?", "was this failure the app or the network?").
Rules answer first. A decision model answers only what rules can't. Below a
confidence threshold the decision escalates instead of guessing.

## Entry points

| Import | Use | Runs in |
|---|---|---|
| `@testament/decide` | task contract, `createDecisions` (decide, race, batch), backend interface, `mockBackend`, `memoryCache`, metrics, the `decisions` config section, built-in tasks | browser and Node |
| `@testament/decide/node` | `fileCache(projectDir)` (`.testament/decisions/`), `createLabelStore(projectDir)` (`.testament/labels/`), and the decision model backends: `createProjectDecisions`, `resolveDecisionBackend`, `createSystemOneBackend`, Ollaya setup (`ollayaStatus`, `pullModel`), `checkSystemOne` / `checkLaya`, `benchBackend` | Node |

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
6. **Narrow network.** The main entry makes no network calls; backends are passed in
   through the `DecisionBackend` interface. The only file that talks to a network is
   `src/node/systemone/transport.ts` (a guard test enforces this). It pins every request
   to the configured backend's host. Before any state leaves, the redactor scrubs it.
   Nothing is ever downloaded during a run.

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
import { createProjectDecisions } from "@testament/decide/node";

// What a run does: the backend comes from config (auto → Jev if JEV_API_KEY is set,
// else rules only). The cache lives on disk. The warm-up loads Laya before the first
// 100 ms decision, and it is never recorded.
const { decisions, selection, warmUp } = createProjectDecisions({
  config,                       // resolved config: decisions + secrets are read
  projectDir,
  sources,                      // secret sources (env, .env, keychain…)
  onDecision: (record, { testId, attempt, backend }) =>
    writer.emit({ type: "decision.made", testId, attempt, decision: record }),
});
await warmUp();                 // { ok, ms, failure?, fix? }; a failure only means rules fallback

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
  backend: auto          # auto (default): Jev if JEV_API_KEY is set, else rules only
                         # none: rules only · jev | kev | laya: that model, explicitly
  jev:  { baseUrl: https://api.typesafe.ai, model: jev-latest, keySecret: JEV_API_KEY, priceUsdPerMillionInputTokens: 0.042 }
  kev:  { baseUrl: http://127.0.0.1:8009, model: kev-latest, priceUsdPerMillionInputTokens: 0 }   # keySecret: optional
  laya: { baseUrl: http://127.0.0.1:11435, model: "laya:typed-decisions",
          priceUsdPerMillionInputTokens: 0, keepAlive: 30m, warmUpTimeoutMs: 15000 }   # keySecret: optional
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

## Decision model backends

All three speak TypeSafe's System One API, so one client serves them all:
`createSystemOneBackend({ id, baseUrl, model, apiKey?, flavor })`. The wire
differences live in one module, `src/node/systemone/wire.ts`. It is tested
against recorded responses in `fixtures/systemone/` (see its README for which
examples are recorded and which come from docs).

| | Jev | Kev | Laya |
|---|---|---|---|
| Who runs it | TypeSafe AI (hosted) | you (open, Apache-2.0) | you, through Ollaya (open weights, Apache-2.0) |
| Chosen by | `auto` when `JEV_API_KEY` is set, or `backend: jev` | `backend: kev` only | `backend: laya` only |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | `POST <kev>/v1/systemone` | `POST http://127.0.0.1:11435/api/decide` (+ `keep_alive`, `state_truncated`) |
| Key | `JEV_API_KEY` (bearer; allowed only on its API host) | optional (`KEV_API_KEY` on the server → set `kev.keySecret`) | optional (`OLLAYA_API_KEY` → set `laya.keySecret`) |
| Speed on this Mac (page_is_error, one question) | p50 ≈ 380 ms, p95 ≈ 1.4 s | not measured (no server here) | p50 ≈ 84 ms warm; first load ≈ 2.3 s (warm-up) |
| Cost | $0.042 per million input tokens (≈ 350 tokens per decision) | your hardware | free, local |
| Accuracy notes | good untrained | 4B/9B close to Jev on classification | **untrained**: expect more escalations until LRN-9 training |

**What data is sent (SAF-5):** only the task's `state` (for `page_is_error`:
the HTTP status and the page's title, main heading and a visible-text sample,
marked untrusted) and the question text. Both pass through the redactor first,
so declared secrets never leave. Nothing else is sent: no screenshots, no URLs
beyond what the state contains, no test files, no keys except the backend's own.

- **Jev:** the state goes to TypeSafe AI in the US. TypeSafe says it doesn't
  train on requests; zero data retention is on their enterprise plan.
- **Kev** and **Laya:** the state stays on the machine or server you run them on.
  The default Laya host is Ollaya on 127.0.0.1.

**Setup:**
- **Jev:** set `JEV_API_KEY` in the environment or `.env`. `auto` picks it up.
- **Kev:** `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009`, then `backend: kev`.
- **Laya:**
  1. Install Ollaya (the desktop app, or `curl -fsSL https://ollaya.dev/install.sh | sh`).
  2. Run `testament decider setup laya`. It finds Ollaya and lists its models. If
     the model is missing, it shows the download size and asks before pulling it
     (`--yes` skips the question).
  3. Set `backend: laya`.

  Testament never installs Ollaya, and it never pulls a model during a run.

**Failures degrade and never break a run.** Each of these ends as a
`BackendFailure`, and the pipeline then returns the rules answer or an escalation:
- timeouts
- `429`, `529`, `5xx`
- an unknown option, a confidence outside 0–1 or malformed JSON
- Ollaya not running, or the model not pulled

The failure reason is in `DecisionMeta.backend.failure`. When `warmUp()` fails,
it returns the exact fix: open Ollaya.app, or run `decider setup laya`. Nothing
is retried inside a decision's time limit.

**Run cost:** `backend.usage()` returns requests, failures, input and output
tokens, the cost in USD (input tokens × `priceUsdPerMillionInputTokens`) and the
number of truncated states.

## CLI

- `testament decisions [--json]` shows the backend (e.g. `auto → none (rules only; set JEV_API_KEY to use Jev)`), the threshold, the cache and every task, with its effective threshold, limit, phase, escalation and questions.
- `testament decisions --check` checks all three backends: whether the key is valid (`GET /v1/models`, no tokens spent), whether the backend is reachable, and whether the model is installed. It shows the fix for each problem, and exits 2 only if the selected backend is unusable.
- `testament decisions --bench [--backend jev|kev|laya|all] [--n 50]` runs `page_is_error` on fixed unclear inputs after a warm-up, with the cache off. It prints p50/p95, the share within 100 ms, the error rate, decided/escalated counts and agreement with the expected answers. Laya's during-run target (p50 < 100 ms) is reported as met or missed.
- `testament decider setup laya [--model …] [--yes]` sets up Laya (see above). `setup jev` and `setup kev` print the steps.
- `testament decisions --stats <runDir> [--json]` prints metrics per task, built from the run's `decision.made` events (or from its documents when there are no events).
