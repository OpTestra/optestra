# How a run works

A test goes through two phases: **authoring** once, with AI, and **replay** every time after, with none.

## Authoring: the first run

```sh
%cli% author tests/create-project.test.md
```

(`%cli% run` authors steps too, in normal mode, when a test has no recording yet.)

1. The `setup` request hooks run, then the test's `start` page opens.
2. For each action step, the AI agent looks at the page (an accessibility snapshot, marked as [untrusted content](../security/safety-model.md#page-content-is-untrusted); a small screenshot only when the snapshot isn't enough) and acts through a closed set of tools. Each call is small and stateless: the step, its variables (secrets by name only), the `Never:` lines, this step's actions so far and the page. Cheap models can follow it.
3. The harness carries out each action, types secrets itself, and reports what changed. The step is done only when something visibly changed (a dead button fails with `no_visible_effect`).
4. `Exact:` steps run directly, with no model.
5. Each `Expect:` and `Soft:` line is compiled into a typed check against the page as it is then, evaluated once and [sanity-tested](./checks-and-verdicts.md#the-sanity-test). A check that fails while authoring is kept and flagged, never dropped: it may be a real bug.
6. The `teardown` hooks run.

The result is the **recording**: for every step, the exact commands (locators, a fingerprint of each element, what should change afterwards, how long the page took to settle) and every check. It is saved next to the test, in `tests/%dataDir%/<test id>.steps.json`, and is meant to be committed. See [Recordings](./recordings.md).

The first step that can't be recorded stops the test; the rest are `skipped`. Nothing is reported as a partial success. Limits keep authoring bounded:

| Limit | Default | Stops with |
|---|---|---|
| actions per step | 8 | `limit_reached` |
| model calls per step | 12 | `limit_reached` |
| failed, refused or invalid actions in a row | 3 | `limit_reached` / `guard_refused` |
| the run's AI budget | `run.budget.maxPerRunUsd` ($1) | `budget_exceeded` |
| the test's time limit | `timeout:`, else `run.timeoutSeconds` (300 s) | `timeout` |

`author` exits 0 when every action step was recorded, 1 when a step failed, and 2 when the run stopped or the project or test has a problem (including "no model"). A check that failed while authoring doesn't change the exit code: authoring has no verdicts.

## Replay: every run after

```sh
%cli% run [tests…] [--tag smoke] [--grep checkout] [--env staging]
```

One browser per worker (`--workers`), one fresh session per test attempt. Each attempt runs the setup hooks, logs in if the test names an [auth profile](../auth.md), opens the start page and goes through the steps with flows inlined.

**An action step with a recording is replayed with no AI.** For each recorded command:

1. **Bind** its templates to this run's values: data, params, env vars, fresh generated values. Secrets stay `{{secret.NAME}}` until the harness types them.
2. **Validate the target.** The stored locator must find exactly one element, and it must be the recorded one (its fingerprint). None, several or a different element is a **miss**, never a silent success.
3. **Act** through the harness. A refused action blocks the test (`disallowed_domain`, `missing_secret`).
4. **Check the effect.** Some of what the recording saw happen must happen again: the URL change, an element that appeared or went away, a request, or a reorder (a table sort). If nothing shows yet, the runner waits the learned time (the recorded settle time, at least 400 ms, at most 3 s) and looks again. Still nothing is a **post-state mismatch**: "the right element was used, but nothing happened".

A miss goes up the [healing ladder](./healing.md). A post-state mismatch fails the step.

**An `Expect:` or `Soft:` step** evaluates its stored check fresh, with no AI. Network checks count requests from the start of the current action step. A failed hard check ends the attempt; a failed soft check is a warning. The one exception to "no AI": a `Soft:` line compiled as a model-judged check (a visual "looks right") asks a model every run, and can only warn.

**A step without a recording** (new or edited): in normal mode the agent authors just that step in place and the run goes on; the recording gains the step and no other step changes. With `--replay-only` it fails; with no model available it is blocked (`ai_unavailable`). `--rerecord` authors every step again.

**Tests with code steps** run through their generated Playwright spec instead, with no healing.

### Modes

| Flag | Setting | |
|---|---|---|
| `--replay-only` | `run.mode: replay-only` | Never calls AI: a missed or unrecorded step, or a check that was never compiled, fails. What CI should run. |
| (default) | `run.mode: normal` | AI only for steps that aren't recorded and misses the no-AI heals can't fix. |
| `--rerecord` | `run.mode: rerecord` | Ignores the recordings and records every step again. |

### Retries

`run.retries` (default 1) re-runs a failed attempt from scratch. A test that fails and then passes is **flaky**, not passed. A blocked attempt isn't retried.

## Output

A finished run, as `%cli% results` prints it:

```
Run 01M3EG7AG0M0AHEMTHAS09ZS7Y  demo-shop · staging · web

  FAILED     12.7s       0 AI     $0.00  Discount code takes 10% off
                                         Expected order total '$90.00', found '$100.00'
  PASSED      3.3s       0 AI     $0.00  Guest checkout

  What went wrong
  ● Expected order total '$90.00', found '$100.00'
      product bug · 1 test: Discount code takes 10% off (tests/checkout/discount-code.md, step 3)

  1 passed, 1 failed · 16.1s · 0 AI calls · $0.00
```

One quiet line per test (verdict, duration, AI calls, cost; "via your subscription" when a subscription tool was used), the headline and cause of each failure, the failure groups, then the summary and the results folder. `--verbose` prints every step, heal and warning.

The run folder is `%dataDir%/runs/<run id>/` in the project: `run.json`, `events.ndjson`, and per test `tests/<test id>/result.json` with screenshots before and after each action step, the video with a chapter per step, the trace, the console log and the network HAR (all scrubbed of secrets). `%cli% report` writes the [HTML report](../reports.md); `%cli% results <runDir>` prints the summary again, and writes JUnit, JSON or Markdown.

### Exit codes

| Code | When |
|---|---|
| 0 | everything passed (healed tests too, if the heal policy is `auto`) |
| 1 | a test failed or was flaky, or healed under the default `review` policy (the fix waits for review) |
| 2 | a test was blocked, the run was blocked (for example a configuration error), or no tests ran |

The first match wins in that order: a run with a failure and a blocked test exits 1. `results --healed-passes` and `--flaky-passes` relax the rules for a summary.

## Parallel runs and sharding

`--workers <n>` runs n tests in parallel, one browser each. `--shard i/n` runs slice i of n on this machine, and `merge-runs` joins the slices: see [Sharding](../ci/sharding.md).
