# Use Ollama Cloud

[Ollama Cloud](https://ollama.com/cloud) runs open-weight models (Kimi, GLM, DeepSeek, MiniMax, Qwen, gpt-oss and others) on Ollama's servers. You pay by the token, out of your plan's monthly credit: Pro is $20 a month for $60 of credit. Ollama says prompts and responses are never logged or trained on. %Name% has it as a named provider, `ollama-cloud`.

```sh
npx %cli% init --ai ollama-cloud --ai-model kimi-k3
```

Create the key at ollama.com/settings/keys. Put it in the git-ignored `.env` as `OLLAMA_API_KEY=…` (`init` does this for you), never in %config%.

```yaml
# %config%
models:
  providers:
    ollama-cloud:
      kind: ollama-cloud
  roles:
    planner:
      - { provider: ollama-cloud, model: kimi-k3 }
    fixer:
      - { provider: ollama-cloud, model: kimi-k3 }
```

Model names are the ones in ollama.com/api/tags (`kimi-k3`, `glm-5.3`, `deepseek-v4.1-flash`, `minimax-m3`, …). Ollama isn't in the default pools: no Ollama model has yet passed the [model eval](./models.md#model-evals) that a default needs, so you choose the model yourself.

## How %Name% talks to it

Through Ollama's OpenAI-compatible API (`https://ollama.com/v1`), which Ollama documents for its cloud, tool calls included. Before a model is first used, %Name% asks Ollama's public `/api/show` (no key is sent) what the model can do:

- a model without **tools** is skipped for the planner, fixer and drafter, never picked silently;
- a model without **vision** gets a note instead of each screenshot (most steps need only the page snapshot).

## Cost

Each call is priced at the model's credit rate from Ollama's pricing page (the price table in `packages/models/prices.yaml`; the rates per million tokens below were checked 2026-10-02):

| Model | Input | Cached input | Output |
|---|---|---|---|
| `kimi-k3` | $3.00 | $0.30 | $15.00 |
| `glm-5.3`, `glm-5.2` | $1.40 | $0.26 | $4.40 |
| `deepseek-v4-pro` | $1.32 | $0.044 | $3.96 |
| `kimi-k2.7-code` | $0.95 | $0.19 | $4.00 |
| `kimi-k2.6` | $0.95 | $0.16 | $4.00 |
| `minimax-m3` | $0.60 | $0.12 | $2.40 |
| `mistral-large-3` | $0.50 | – | $1.50 |
| `deepseek-v4.1-flash` | $0.30 | $0.006 | $1.20 |
| `minimax-m2.7` | $0.30 | $0.06 | $1.20 |
| `glm-5.3-flash` | $0.15 | $0.03 | $0.50 |
| `gpt-oss:120b` | $0.15 | $0.014 | $0.60 |
| `gemma4` | $0.14 | $0.05 | $0.40 |
| `nemotron-3-ultra` | $0.10 | $0.10 | $3.00 |
| `gpt-oss:20b` | $0.07 | $0.035 | $0.30 |
| `nemotron-3-nano` | $0.06 | – | $0.24 |
| `nemotron-3-super` | $0.015 | $0.015 | $0.60 |

The DeepSeek models cost half off-peak (outside 12:00–18:00 UTC on weekdays, and all weekend); their prices above are the peak ones, an upper bound. Ollama doesn't report a call's cost. A model missing from the table gets cost "unknown" and a warning; add its rate under `models.prices` as `ollama-cloud:<model>`.

## Limits

- At most **3 requests at once** by default, Ollama Pro's limit. On Max or Team, set `concurrency: 10` on the provider.
- A **429** is waited out (`Retry-After`, else a growing backoff) for at most `models.maxWaitMinutes` per call, without counting against the test's time limit.
- When the credit runs out (402), Ollama is turned off for the rest of the run, and the next provider answers or the test is blocked.

## Checking the key

```sh
%cli% doctor            # or: %cli% models --check
```

The check sends a chat request that names no model. Ollama checks the key first and then refuses the request, so nothing runs and nothing is spent. Ollama has no API for the credit you have left: see ollama.com/settings/usage.

## Hosted AI

Ollama Cloud is **bring your own key** only. %Name%'s hosted plans don't use it to serve customers unless Ollama's terms clearly allow that.
