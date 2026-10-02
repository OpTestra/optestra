# Use OpenRouter

[OpenRouter](https://openrouter.ai) sells prepaid credit that works with almost every model, Claude included. %Name% has it as a named provider, `openrouter`: base URL, key name and limits are built in.

```sh
npx %cli% init --ai openrouter            # asks for the key; saves it in .env only
```

Or by hand: put `OPENROUTER_API_KEY=sk-or-…` in the git-ignored `.env` (or the environment), and nothing else is needed. The default pools already hold `anthropic/claude-sonnet-5.5` through OpenRouter, after the direct API keys, so with only an OpenRouter key the planner and fixer use Claude Sonnet 5.5, the default model.

```yaml
# %config%: only to choose other models
models:
  providers:
    openrouter:
      kind: openrouter
  roles:
    planner:
      - { provider: openrouter, model: anthropic/claude-sonnet-5.5 }
    fixer:
      - { provider: openrouter, model: anthropic/claude-sonnet-5.5 }
```

## Routing: pinned, no fallbacks, no data collection

OpenRouter can send one model's calls to several upstream hosts, some of them cheaper, quantized copies. %Name% doesn't let it:

| Setting | Default | Why |
|---|---|---|
| `order` | the model's author: `anthropic/*` → `anthropic`, `moonshotai/*` → `moonshotai`, `z-ai/*` → `z-ai`, `deepseek/*` → `deepseek`, `minimax/*` → `minimax`, `qwen/*` → `alibaba`, `openai/*` → `openai`, `google/*` → `google-ai-studio` | the real model, at its list price |
| `allowFallbacks` | `false` | a call never goes silently to another host or model |
| `dataCollection` | `deny` | only hosts that don't store or train on your prompts |
| `zdr` | off | set `true` for zero-data-retention hosts only |

Change it for the provider or one pool entry:

```yaml
models:
  providers:
    openrouter:
      kind: openrouter
      routing: { zdr: true }
  roles:
    planner:
      - provider: openrouter
        model: deepseek/deepseek-v4-pro
        routing: { order: [alibaba] }   # DeepSeek doesn't serve this one itself
```

A model whose pinned host doesn't serve it is skipped, with a message that names the host and tells you to set `routing.order`. A model with an author not in the list above has no pin, and `%cli% models --check` says so.

## Caching and cost

For Claude, the stable system prompt carries a cache breakpoint, so the second and later planner calls of a test read it from the cache at a tenth of the input price. Every response includes OpenRouter's own charge (`usage.cost`), and %Name% records it next to the list price:

- `costUsd` is what OpenRouter charged (it counts against your [budgets](./costs.md));
- `listCostUsd` is the same call at the engine's list price;
- `reportedCostUsd` is OpenRouter's figure, kept apart.

If they differ by more than 5%, the run logs a warning (the price table may be out of date). OpenRouter adds no markup on calls; it charges a fee when you buy credit, which is not part of a call's cost.

## Limits

- At most **8 requests at once** by default (`concurrency: 8`); more wait their turn.
- A **429** is waited out: the `Retry-After` time when OpenRouter gives one, else 2 s, 4 s, 8 s and so on up to a minute, for at most `models.maxWaitMinutes` (default 30) per call. The run shows "waiting for AI, resumes at …", and the wait is **not counted against the test's time limit**. A rate limit never fails a test.
- A **402** (no credit left, or the key's limit is reached) turns OpenRouter off for the rest of the run; the next provider in the pool answers, or the test is blocked with "Out of AI credit".

## Checking the key and its credit

```sh
%cli% doctor            # or: %cli% models --check
```

This calls OpenRouter's `GET /key`, which costs nothing, and shows what the key has left: "$12.50 of this key's $20.00 limit left (used $7.50)". A key with no limit shows what it has used; the account's credit is at openrouter.ai/settings/credits.

Before a model is used, %Name% reads its public entry on OpenRouter (no key is sent) to learn whether the pinned host supports tools and images. A model that can't call tools is skipped for the work that needs them, and a model that can't read images gets a note instead of a screenshot.
