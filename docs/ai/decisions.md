# Decision models

Runs make many small, typed decisions: "is this the same button?", "was this failure the app or the network?", "is this heal cosmetic?". Rules answer first. A decision model answers only what rules can't, and below a confidence threshold the decision **escalates** instead of guessing.

- **Decisions never decide a verdict.** A decision task may not ask anything about passing or failing; the results can't name a decision as what decided a verdict.
- **Rules first, always available.** With no decision model (the default for everything during a run), every decision gets an answer or an escalation. Nothing else depends on this layer.
- **Hard time limits.** About 100 ms during a run, about 2 s after it. On timeout the call is aborted and the rules' answer is used.
- **Everything is audited.** Every decision is recorded in the run, with its source, confidence and time.

## The decisions

| Task | When | Question |
|---|---|---|
| `page_is_error` | during | is this page an error page? |
| `same_element` | during | is this element the one the recording used? (it never answers "same" falsely on the evals) |
| `miss_action` | during | which rung of the [healing ladder](../runs/healing.md) to use |
| `failure_cause` | after | product bug, test drift, environment or test data |
| `flaky_or_real` | after | intermittent or consistent (advice only) |
| `duplicate_or_new` | after | does this failure belong to an existing group? |
| `heal_class` | after | cosmetic or behaviour change |

## Backends

All three speak the same System One API:

| | Jev | Kev | Laya |
|---|---|---|---|
| Who runs it | TypeSafe AI (hosted) | you (open, Apache-2.0) | you, through Ollaya (open weights, Apache-2.0) |
| Chosen by | `auto` when `JEV_API_KEY` is set, or `backend: jev` | `backend: kev` | `backend: laya` |
| Speed (measured, one question) | p50 ≈ 380 ms, p95 ≈ 1.4 s | not measured yet | p50 ≈ 84 ms warm; first load ≈ 2.3 s |
| Cost | $0.042 per million input tokens (≈ 350 tokens a decision) | your hardware | free, local |
| Notes | good untrained | 4B/9B models close to Jev on classification | untrained so far: expect more escalations |

```yaml
# %config%
decisions:
  backend: auto          # auto | none | jev | kev | laya (both phases)
  during: auto           # auto: what `backend` names; if that is auto too, rules only
  after: auto            # auto: what `backend` names; if that is auto too, Jev when JEV_API_KEY is set
  threshold: 0.8
  tasks:
    page_is_error: { threshold: 0.9, timeLimitMs: 150, enabled: true }
  cache: { enabled: true, ttlSeconds: 604800 }
```

Routing never slows a run: a backend whose expected latency is above a task's time limit is never called for it (so Jev is skipped during runs), and a backend that times out on a task 3 times in a run stops being called for it. Only model answers are cached (`%dataDir%/decisions/`), for a week by default.

### Setup

- **Jev:** set `JEV_API_KEY` in the environment or `.env`; `auto` picks it up.
- **Kev:** `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009`, then `backend: kev`.
- **Laya:** install Ollaya (the desktop app, or `curl -fsSL https://ollaya.dev/install.sh | sh`), then run `%cli% decider setup laya`: it finds Ollaya, lists its models and, if the model is missing, shows the download size and asks before pulling it (`--yes` skips the question). Then set `backend: laya`. %Name% never installs Ollaya and never pulls a model during a run.

```sh
%cli% decisions                  # routing per phase, threshold, cache, every task
%cli% decisions --check          # key valid, reachable, model installed
%cli% decisions --bench --backend laya
%cli% decisions --eval           # accuracy on the committed eval sets (exit 1 on a false label)
%cli% decisions --stats <runDir> # per-task metrics of a run
```

## What is sent

Only the task's state and the question text, both passed through the redactor first, so declared secrets never leave. For `page_is_error`, the state is the HTTP status and the page's title, main heading and a sample of its visible text, marked untrusted. No screenshots, no test files, no keys except the backend's own.

- **Jev:** the state goes to TypeSafe AI in the US. TypeSafe says it doesn't train on requests; zero data retention is on their enterprise plan.
- **Kev** and **Laya:** the state stays on the machine or server you run them on. Laya's default host is Ollaya on 127.0.0.1.

Failures (timeouts, rate limits, 5xx, malformed answers, Ollaya not running) never break a run: the decision falls back to its rules answer or escalates.

## Measured

On the development machine, 2026-09-26: rules alone decide 57 of 67 `same_element` cases with zero false "same", and all 41 `miss_action` cases correctly. Laya's `same_element` calls take about 150 ms, over the 100 ms limit, so it needs to be faster and trained before it helps there. The after-run tasks decide 86–95% of their eval cases by rules alone, with zero false labels.
