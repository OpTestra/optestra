# Costs and budgets

## What costs money

| Run | AI calls |
|---|---|
| A replay where nothing changed | **none** (and $0), except model-judged `Soft:` checks, which ask the planner model every run |
| Authoring a new test | about 4–17 calls per test on the demo shop, one or more per action step |
| A new or edited step | calls for that step only |
| A miss that the fallback or re-find heals | none |
| A miss that needs the fixer | up to 6 calls for that step |
| Decisions | none by default (rules); see [Decision models](./decisions.md) for Jev's price |

With a [subscription tool](./subscription.md), calls cost $0 against your budget (they use your plan).

## Budgets

```yaml
# %config%
run:
  budget:
    maxPerRunUsd: 1     # AI spend cap for one test run, in USD
    maxPerSuiteUsd: 10  # AI spend cap for one suite run, in USD
```

`%cli% run --budget 0.50` overrides the per-run cap for one run. The budget is checked before every call; when it is reached, the call stops with `budget_exceeded` and the affected tests are **blocked** with a clear message, never failed. Actual cost is added after the call, so **one call already in flight may overshoot a cap**. Calls with an unknown cost are counted separately.

## Usage caps

A provider can have spend caps per 5 hours, week and month:

```yaml
models:
  providers:
    anthropic:
      kind: anthropic
      keySecret: ANTHROPIC_API_KEY
      caps:
        perWeek: { usd: 20 }
```

At 90% of any cap, calls move to the next provider in the pool. Spend is recorded in `<project>/%dataDir%/usage.json`.

## Prices

The price table (USD per million tokens) ships with the engine (`packages/models/prices.yaml`, checked against the providers' pricing pages) and can be overridden per project:

```yaml
models:
  prices:
    my-local-model: { input: 0, output: 0 }
```

A cost the provider reports itself (OpenRouter's) wins over the table. A model with no known price gets cost "unknown" and a warning, **never a guess**.

## Where costs show

- `%cli% run` and `%cli% author`: calls and cost per test and per step.
- The HTML report and the PR comment: calls, tokens and cost per test and per run, with "N calls via your subscription" and "used AI N times in its last M runs" per test.
- The JSON results: `cost` for the run and `ai` per test.
- Every model call is recorded with its role, provider, model, tokens, cost, latency and outcome.
