# @optestra/decide

The decision layer: the one place every small typed decision goes through
("is this the same button?", "was this failure the app or the network?").
Rules answer first. A decision model answers only what rules can't. Below a
confidence threshold the decision escalates instead of guessing.

## Entry points

| Import | Use | Runs in |
|---|---|---|
| `@optestra/decide` | task contract, `createDecisions` (decide, race, batch), backend interface, `mockBackend`, `memoryCache`, metrics, the `decisions` config section, built-in tasks | browser and Node |
| `@optestra/decide/node` | `fileCache(projectDir)` (`.optestra/decisions/`), `createLabelStore(projectDir)` (`.optestra/labels/`), and the decision model backends: `createProjectDecisions`, `resolveDecisionBackend`, `createSystemOneBackend`, Ollaya setup (`ollayaStatus`, `pullModel`), `checkSystemOne` / `checkLaya`, `benchBackend` | Node |

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
import { createProjectDecisions } from "@optestra/decide/node";

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
  backend: auto          # shorthand for both phases: auto | none | jev | kev | laya
  during: auto           # auto → what `backend` names; if that is auto too: rules only
  after: auto            # auto → what `backend` names; if that is auto too: Jev when JEV_API_KEY is set, else rules only
  skipAfterTimeouts: 3   # stop calling a backend for a task after 3 timeouts in one run
  jev:  { baseUrl: https://api.typesafe.ai, model: jev-latest, keySecret: JEV_API_KEY,
          priceUsdPerMillionInputTokens: 0.042, expectedLatencyMs: 400 }
  kev:  { baseUrl: http://127.0.0.1:8009, model: kev-latest, priceUsdPerMillionInputTokens: 0,
          expectedLatencyMs: 500 }   # keySecret: optional
  laya: { baseUrl: http://127.0.0.1:11435, model: "laya:typed-decisions", priceUsdPerMillionInputTokens: 0,
          expectedLatencyMs: 90, keepAlive: 30m, warmUpTimeoutMs: 15000 }   # keySecret: optional
  threshold: 0.8         # project default
  tasks:
    page_is_error: { threshold: 0.9, timeLimitMs: 150, enabled: true }
  cache: { enabled: true, ttlSeconds: 604800 }
```

For each task, the first setting found applies:
- threshold: `tasks.<name>.threshold`, then the task's own `threshold`, then `decisions.threshold`.
- time limit: `tasks.<name>.timeLimitMs`, then the task's `timeLimitMs`, then the phase default.

### Per-phase routing (DEC-2)

Decisions made during a run have about 100 ms, and decisions made after it have
about 2 s. Each phase therefore gets its own backend:

| `backend` | `during` | `after` | During-run tasks | After-run tasks |
|---|---|---|---|---|
| auto | auto | auto | rules only | Jev if `JEV_API_KEY` is set, else rules only |
| laya | auto | auto | laya | laya |
| jev | auto | auto | jev (but see below: 400 ms > 100 ms, so skipped) | jev |
| auto | laya | auto | laya | Jev if its key is set |

Routing never slows a run. A task never calls a backend if the backend's
`expectedLatencyMs` is above the task's time limit (`skipped: "too_slow"`).
A backend that times out on a task `skipAfterTimeouts` times in one run stops
being called for that task (`skipped: "timeouts"`). Either way the task falls
back to its rules or escalates. The skip reason appears in `DecisionMeta.backend`,
in the result, and in the metrics (`backendSkipped: { too_slow, timeouts }`).
`createDecisions({ backends: { during, after } })` sets the backends in code;
`backend` alone sets both.

`enabled: false` makes the task escalate with reason `disabled`. The section can
be overridden per environment. `optestra decisions` lists the effective values
and warns about override names that match no task.

## Cache

Only model answers are cached. Rules answers are instant, so they never are.
The key is `cacheKey(task, version, input, backendId)`: canonical JSON of the
zod-parsed input with sorted keys. `fileCache` stores one file per key, named by
the key's sha256, under `.optestra/decisions/`. An entry older than `ttlSeconds`
is a miss. `bypassCache` (on the instance or on a single call) skips both reads
and writes, for evals. Cache writes never slow a decision down.

## Labelled examples (LRN-9)

```ts
const labels = createLabelStore(projectDir);
labels.recordLabel(pageIsError, input, { is_error: true }, { source: "confirmed" }); // approved | rejected | confirmed
labels.readLabels("page_is_error");
```

Each call appends one line to `.optestra/labels/<task>.jsonl`, with the task
version, source, time, parsed input and answers. Every line passes through the
redactor (the process-wide one by default). If the answers don't fit the task's
questions, the call throws. Training (`optestra train`) and evals come later.

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
  2. Run `optestra decider setup laya`. It finds Ollaya and lists its models. If
     the model is missing, it shows the download size and asks before pulling it
     (`--yes` skips the question).
  3. Set `backend: laya`.

  Optestra never installs Ollaya, and it never pulls a model during a run.

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

## The after-run decisions (DEC-2)

These four tasks label, group and explain. None of them sets a verdict (LRN-8).
Each decided answer carries `evidence`: named signals, with contract
`EvidenceRef`s when they point at a step or check. That way the report can show
"why this label" (DIA-1, HEAL-6). The rules' word lists and patterns live in
`src/tasks/signals.json`. Page and app text in every state is wrapped in
`untrusted()`, and the backend client redacts it before it leaves.

### failure_cause (DIA-1)

- **Question:** choice `cause`: `product_bug | test_drift | environment | test_data`.
  The contract's `blocked` cause is never a decision. It follows from a blocked
  reason, so `failureCauseCase` / `classifyFailure` set it deterministically,
  with the blocked reason and step as evidence. It would also trip the
  no-verdict guard.
- **Input** (built by `failureCauseCase(result, context)`):
  - verdict (failed or flaky) and a summary of each attempt;
  - the failing step: kind, recovery, error, element not found, post-state, flow;
  - the failing check: expected and actual;
  - requests around the failure, with other sites' requests marked `thirdParty`;
  - console errors;
  - the page (untrusted) and `page_is_error`'s answer.
  Without runner observations, requests are read from the step error ("GET /api/search returned 503").
- **Rules, in order:**
  1. App unreachable (document request failed, connection refused or DNS error) → environment.
  2. Infrastructure trouble (5xx, network failure, 429 or timeout text) that went away on retry → environment.
  3. 429 → environment. Network failures → environment when they repeat or went away; else escalate.
     Gateway errors only (502/503/504) → environment.
  4. A test-data phrase ("already exists", "coupon expired", "no such user", …) on a page with no 5xx → test_data.
  5. An error page or a 5xx: gone on retry → environment; the same on every attempt → product_bug;
     a single attempt → escalate.
  6. A 404/410 page → escalate (a broken link or a removed URL the test uses).
  7. A failure on a healthy page that passed on retry → escalate.
  8. On a healthy page:
     - a JS crash in the console → product_bug;
     - element not found → test_drift, but escalate while the page says it is still loading;
     - the action did nothing (post-state mismatch) → product_bug when it repeats, else escalate;
     - a hard check failed → product_bug.
- **Used for:** the test's `failureCause` and `failureEvidence`, the headline, and routing a failure to the right person.

### flaky_or_real (DIA-2, DIA-5): advice only

- **Question:** noul `intermittent` ("this failure comes and goes"). "Flaky" is a
  verdict word, so the id avoids it. The flaky *verdict* stays deterministic:
  failed, then passed on retry.
- **Input** (`flakyInput(result, context)`): each attempt's status, cause and failure
  signature, plus recent history (verdict and signature, newest first).
- **Rules:**
  - passed on retry → yes;
  - the same failure on every attempt and in history → no;
  - newly broken (the same failure every attempt, history all passes) → no;
  - a single attempt that failed exactly as in recent runs → no;
  - the same environment failure on every attempt (an outage) → escalate;
  - a different failure each attempt, an environment cause, or history that flips → yes;
  - the same failure every attempt with stable or no history → no.
- **Used for:** quarantine suggestions and retry hints. Never a verdict.

### duplicate_or_new (DIA-4)

- **Question:** choice `group`: the run's failure group ids (`g1`, `g2`, …) plus `new`.
  The options come from the input (`questionsFor`), and the no-verdict guard runs on them too.
- **Input** (`signatureFromTestResult`): headline, failing step text, flow chain,
  route and cause, for this failure and each group's first failure.
- **Rules:**
  - no groups yet → new;
  - the same step inside the same flow chain (the login flow) → that group;
  - the same normalized headline (numbers, quoted values, ids and money ignored) on the same route → that group;
  - the same headline and step text → that group;
  - the same headline only → escalate;
  - nothing in common (no shared route, step or flow, and word similarity under 0.2) → new.
- **Used for:** "one broken login breaks 20 tests": `groupFailures(results)`.

### heal_class (HEAL-6)

- **Question:** choice `classification`: `cosmetic | behavior_change | unknown`
  (the contract's HealProposal classification). The rules never answer
  `unknown`; that is what `classifyHeal` records when nothing is confident.
- **Input** (`healInput(proposal, facts?)`): the element facts before and after
  (role, accessible name, text, tag, test id, position), read from Playwright-style
  locators unless the recording gives them; the changes; the healer's signals.
- **Rules:**
  - only waits changed → cosmetic;
  - the action changed, the role changed, or the opposite action (Save → Cancel, Log in → Log out) → behavior_change;
  - the same role and the same name (ignoring case, punctuation and whitespace) → cosmetic;
  - synonyms (Continue → Next, Cart → Bag, Log in → Sign in) → cosmetic;
  - two different action verbs that aren't synonyms (Delete → Archive) → behavior_change;
  - the same words plus filler only (Save → Save now) → cosmetic;
  - anything else escalates ('Add to cart' → 'Add to wishlist', 'Delete' → 'Delete account',
    'Pricing' → 'Plans', a test-id-only locator).
- **Used for:** heal review (a cosmetic heal can be auto-accepted under the `auto` policy;
  a behaviour change always needs review).

### Helpers for the runner (browser-safe)

| Helper | Returns |
|---|---|
| `inputFromTestResult(result, context?)` | `{ failureCause: FailureCauseCase, flakyOrReal: input \| null }` |
| `failureCauseCase(result, context?)` / `classifyFailure(result, { decisions, context })` | failure_cause's input or the deterministic `blocked`; the decided cause with evidence |
| `flakyInput(result, context?)` | flaky_or_real's input |
| `groupFailures(results, { decisions, context })` | `FailureGroup[]`: id, members, first failure, why each member joined, `uncertain` |
| `classifyHeal(proposal, { decisions, before?, after?, attempt? })` | `{ classification, decided, source, confidence, evidence }` |

`context` is what the runner saw beyond the contract documents:
- requests and console errors per attempt;
- the page and `page_is_error`'s answer;
- the route;
- whether the element was not found;
- each step's flow chain (from SPEC's `ExpandedStep.flowPath`);
- the test's history.

With no `decisions`, the helpers use the rules alone.

### Evals (LRN-10 foundation)

`evals/<task>.jsonl` holds the labelled cases for each after-run task (at least
40 each). They come from three sources: the contract fixtures, the shop fixture's
manifest (the expected cause for each scenario and variant), and hand-written
realistic cases, including tricky ones where guessing would be wrong. The labels
are what a careful triager would answer. Rebuild the sets with
`pnpm --filter ./packages/decide build:evals`. `decisions --eval` scores them.
**False labels** (decided but wrong) are what matter: escalating is always allowed.

Rules-only baseline (`evals/baseline.json`; a test holds the rules to it):

| Task | Cases | Decided | Escalated | False labels |
|---|---|---|---|---|
| failure_cause | 50 | 45 (90%) | 5 | 0 |
| flaky_or_real | 42 | 40 (95.2%) | 2 | 0 |
| duplicate_or_new | 43 | 39 (90.7%) | 4 | 0 |
| heal_class | 43 | 37 (86%) | 6 | 0 |
| same_element | 67 | 57 (85.1%) | 10 | 0 |
| miss_action | 41 | 41 (100%) | 0 | 0 |

After changing rules or cases, run `pnpm --filter ./packages/decide eval:baseline`.

Measured with real models on the development Mac (2026-09-26; `decisions --eval --backend …`).
Decided counts are "decided / cases"; false labels were 0 in every run shown.
Jev's counts vary by one or two between runs, so ranges are given.

| Task | Rules → Jev | Jev alone (rules off) | Rules → Laya | Laya alone |
|---|---|---|---|---|
| failure_cause | 47/50 (+2 by Jev) | 34–35/50 | 45/50 (+0) | 0/50 |
| flaky_or_real | 40/42 (+0) | 11–15/42 | 40/42 (+0) | 0/42 |
| duplicate_or_new | 42/43 (+3) | 35–36/43 | 39/43 (+0) | 0/43 |
| heal_class | 39/43 (+2) | 23–25/43 | 37/43 (+0) | 0/43 |
| Model p50 per call | ≈ 290–330 ms | ≈ 300–370 ms | ≈ 80–210 ms | ≈ 100–240 ms |

- Jev never gave a wrong label. Once it answered heal_class `unknown` at 0.8+;
  evals count that as an abstention (`ABSTAIN`), not a label. Behind the rules it
  settled 7 of the 17 cases the rules left, for about $0.0003 per full eval.
- Laya (`laya:typed-decisions`, untrained on this project) reached the 0.8
  threshold on none of the cases. Every call escalated, so it is safe but adds
  nothing until LRN-9 training. Its 4 errors on `duplicate_or_new` alone are the
  first-failure cases with a single option (`new`), which Ollaya rejects; the rules
  always decide those first.

### Recording labels (LRN-9)

When a person confirms or corrects a label, the runner (LOOP-4) and heal review
(HEAL) record it with the DEC-0 store, so training data builds up from day one:

```ts
const labels = createLabelStore(projectDir);
// A person confirmed or changed a failure's cause in the report:
labels.recordLabel(failureCause, c.input, { cause: "test_drift" }, { source: "confirmed" });
// A person said "this is flaky" / "this is a real bug" on a quarantine suggestion:
labels.recordLabel(flakyOrReal, flakyInput(result, ctx)!, { intermittent: true }, { source: "confirmed" });
// A person merged a failure into a group, or split it out:
labels.recordLabel(duplicateOrNew, { failure, groups }, { group: "g2" }, { source: "confirmed" });
// A heal was accepted (approved) or rejected; the class a person gave it:
labels.recordLabel(healClass, healInput(proposal), { classification: "cosmetic" }, { source: "approved" });
labels.recordLabel(healClass, healInput(proposal), { classification: "behavior_change" }, { source: "rejected" });
```

`c.input` is the `failureCauseCase(result, ctx)` input. The input must be the
exact one the decision saw, so the example trains on the same view.

## The during-run decisions (DEC-3)

These two tasks run while a test replays, and they power healing without AI
(HEAL-1 level 1). They decide identity and the next step, never a verdict: a
replayed step still counts only when its post-state and checks pass later.
Both are `during` tasks (100 ms limit). DEC-2 measured that only Laya is fast
enough, and it is untrained, so for now the rules carry them.

### same_element (REP-5, HEAL-6)

- **Question:** noul `same`: "the candidate is the element the step was recorded on".
- **Input** (`sameElementInputFor(fingerprint, candidate)`): two sets of element
  identity facts. One is the recorded Fingerprint (role, name, tag, attributes,
  anchor text, frame path, box). The other is the live candidate's ElementFacts
  (the same fields plus visible text), with which locator found it
  (`primary | fallback | refind`) and how many elements that locator matched.
- **Signals** (weights and thresholds in `src/tasks/same-element.json`; each scores -1 … 1):

  | Signal | Weight | Scores |
  |---|---|---|
  | role | 3 | equal 1, different -1 |
  | name | 3 | equal 1, near / synonym 0.8, partial 0, different -0.6, opposite -1 (DEC-2's synonym and opposite lists) |
  | text | 1 | as name (fingerprints don't store text, so usually unknown) |
  | test_id | 2 | equal 1, same last token (`plan-pro` → `pricing-pro`) 0.3, unrelated -0.5 |
  | attributes | 1.5 | href path, input type, name/for, placeholder, alt, title, aria-label |
  | anchor | 2 | same section 1, partial -0.5, different -1 |
  | frame | 3 | same frame path 1, different -1 |
  | position | 0.5 | within 16 px 1, fading to 0 at 600 px (layout moves never count against) |

- **Rules.** A wrong "same" is the dangerous mistake, so doubt escalates.
  - Not same when:
    - it is in a different frame, or has a different role;
    - the name is the opposite action;
    - it is a different kind of field (input type);
    - it links to a different page with a different name;
    - it is in a different section (unless the test id matches).
  - Same when:
    - it has the same *unique* test id and role; or
    - it has the same role, the same name (allowing near or synonym) and the same
      section, with nothing ambiguous (the locator matched one element, or the
      candidate sits where the recorded one was).
  - Everything else escalates. The escalation carries every signal's score as
    evidence (`best`), so HEAL-6 can show "why we think it's the same element".
  - The rules never say "not same" just because the words changed within the same
    section: "Create" → "Save project" escalates.

### Helpers

| Helper | Returns |
|---|---|
| `decideSameElement(fingerprint, candidate, { decisions? })` | `{ same: true \| false \| null, decided, confidence, score, evidence }` |
| `rankCandidates(fingerprint, candidates, { decisions?, margin? })` | `{ outcome: match \| ambiguous \| none, best, ranked }` |
| `decideMiss(context, { decisions? })` | `{ action, decided, blockedReason, evidence }` |
| `missContext({ …, fallbacks: { total, matched, best }, rank })` | miss_action's input from the helpers' outputs |

`rankCandidates` decides all candidates in one batch. It returns a `best` only
when all three hold:
- the best candidate is decided "same";
- it is ahead of the runner-up by `margin` (0.15 in combined score, from `same-element.json`);
- the runner-up is not also "same".

Two near-equal matches are `ambiguous`; the helper never picks at random.

### miss_action (HEAL-1): the healing ladder

- **Question:** choice `action`: `replay_fallback | refind | call_fixer | block | no_heal`.
  The brief's `fail` is called `no_heal`: "fail" is a verdict word, and the step
  failing is the checks' business.
- **Input:**
  - why the stored step missed (`not_found | multiple_matches | fingerprint_mismatch | action_refused | post_state_mismatch`);
  - the refusal reason;
  - whether the element acted on was the recorded one;
  - the fallbacks: how many exist, how many matched, and same_element's answer for the best;
  - rankCandidates' outcome;
  - page health (`page_is_error`, app down, 5xx count, network failures);
  - heal policy, budget left, and whether a fixer model is available.
- **The ladder** (first rung that applies; HEAL implements the same order):

  | # | When | Action |
  |---|---|---|
  | 1 | Error page, app down, a 5xx or a network failure; or the action was refused | `block`: not a test problem; the blocked reason is `app_down` or the refusal |
  | 2 | Post-state mismatch and the element was the recorded one | `no_heal`: the app didn't react; healing would hide it |
  | 3 | A fallback locator matched and same_element says same | `replay_fallback` |
  | 4 | rankCandidates found one clear match | `refind` (no AI, so allowed under strict too) |
  | 5 | Heal policy `strict` | `no_heal` |
  | 6 | A fixer model is available and budget is left | `call_fixer` |
  | 7 | Otherwise | `block` (`ai_unavailable` or `budget_exceeded`) |

  The ladder always decides. No model is needed, and in the eval Jev alone got
  5 of 19 wrong (policy and budget), so the rules own this task.

### Recording labels for the during-run tasks (LRN-9)

HEAL's approve or reject of a fix is the main source of same_element labels:

```ts
const labels = createLabelStore(projectDir);
// A heal that re-found an element was approved (same) or rejected (a different element):
labels.recordLabel(sameElement, sameElementInputFor(fingerprint, candidate), { same: true }, { source: "approved" });
labels.recordLabel(sameElement, sameElementInputFor(fingerprint, candidate), { same: false }, { source: "rejected" });
// A person said what should have happened on a miss (from the heal review):
labels.recordLabel(missAction, missInput, { action: "call_fixer" }, { source: "confirmed" });
```

### Measured (development Mac, 2026-09-26)

| | same_element | miss_action | Model p50 |
|---|---|---|---|
| Rules only | 57/67 decided, 0 false "same" | 41/41, 0 wrong | – |
| Rules → Laya | 57/67 (Laya +0) | 41/41 | ≈ 150 ms |
| Laya alone | 0/67 (all below threshold) | 0/41 | ≈ 150–170 ms |
| Rules → Jev (limits lifted) | 62/67 (Jev +5), 0 false | 41/41 | ≈ 310 ms |
| Jev alone (limits lifted) | 29/67, 0 false "same" | 19/41, **5 wrong** | ≈ 315 ms |

Laya's same_element calls take about 150 ms, over the 100 ms limit. In a run,
the timeout skip (DEC-2) stops calling it after 3 timeouts. It needs to be both
faster and trained before it helps here.

## CLI

- `optestra decisions [--json]` shows the routing per phase (e.g. `During  auto → none (rules only)`, `After  auto → jev (JEV_API_KEY set)`), the threshold, the cache and every task, with its effective threshold, limit, phase, escalation and questions.
- `optestra decisions --eval [--backend rules|jev|kev|laya] [--model-only] [--json]` scores the after-run tasks on the committed eval sets. It shows accuracy on decided cases, decided and escalated %, false labels, p50 overall and for model calls, and escalation reasons. `--model-only` turns the rules off to measure the model alone. Exit 1 on any false label.
- `optestra decisions --check` checks all three backends: whether the key is valid (`GET /v1/models`, no tokens spent), whether the backend is reachable, and whether the model is installed. It shows the fix for each problem, and exits 2 only if a backend a phase uses is unusable.
- `optestra decisions --bench [--backend jev|kev|laya|all] [--n 50]` runs `page_is_error` on fixed unclear inputs after a warm-up, with the cache off. It prints p50/p95, the share within 100 ms, the error rate, decided/escalated counts and agreement with the expected answers. Laya's during-run target (p50 < 100 ms) is reported as met or missed.
- `optestra decider setup laya [--model …] [--yes]` sets up Laya (see above). `setup jev` and `setup kev` print the steps.
- `optestra decisions --stats <runDir> [--json]` prints metrics per task, built from the run's `decision.made` events (or from its documents when there are no events).
