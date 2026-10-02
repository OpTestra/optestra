# Providers and roles

%Name% uses AI in these roles, each with its own ordered pool of models:

| Role | Does | Called when |
|---|---|---|
| `planner` | works out and records steps; compiles an `Expect:` line no rule can map; judges a model-judged `Soft:` check | authoring, a step without a recording, `--rerecord` |
| `fixer` | redoes one step that no-AI healing couldn't fix | a miss, under the `review` or `auto` [heal policy](../runs/healing.md) |
| `drafter` | explores the app and drafts a new test from a sentence | `%cli% new`, the MCP draft tool; **optional**: with no `drafter` pool it uses the planner's |

A replay where nothing changed calls neither. The small typed decisions ("is this the same button?") are a separate layer, rules first: see [Decision models](./decisions.md).

## Pinned defaults

All default model ids live in one file, the engine's `defaults.yaml`, never in code. A pool entry is used only when its provider is ready, so with the standard key variable set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) or a signed-in subscription tool, the roles simply work.

| Pool order | `planner` | `fixer` |
|---|---|---|
| 1. [Ollama Cloud](./ollama-cloud.md) | `deepseek-v4.1-flash` | `deepseek-v4.1-flash` |
| 2. Anthropic API | `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| 3. OpenAI API | `gpt-6-sol` | `gpt-6-luna` |
| 4. Google API | `gemini-3.8-flash` | `gemini-3.5-flash-lite` |
| 5. [OpenRouter](./openrouter.md) | `anthropic/claude-sonnet-5.5` | `anthropic/claude-sonnet-5.5` |
| 6. Claude Code (your subscription) | `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| 7. Codex (your subscription) | the tool's default | the tool's default |

With an `OLLAMA_API_KEY`, DeepSeek-V4.1-Flash answers first. In the EVAL-1 model comparison it authored every Bench shop test, with no wrong pass and no wrong fail, the same as Sonnet 5.5, at about a fifteenth of the cost ($0.003 vs $0.047 a test) and in half the time. Without an Ollama key the pools start at the Anthropic API, as before. The Claude defaults are pinned to Sonnet 5.5 for both roles; it authored every Bench test correctly at about half the cost of Sonnet 4.6 (EVAL-0). No other Claude model is used unless you choose it. Both results are in `bench/results/`. On Android it matched Sonnet 5.5 too (7/7, no wrong pass or fail, about a nineteenth of the cost).

## Providers

```yaml
# %config%
models:
  providers:
    openrouter:
      kind: openrouter              # base URL, OPENROUTER_API_KEY and limits built in
    local:
      kind: openai-compatible
      baseUrl: http://localhost:11434/v1
  roles:
    planner:
      - { provider: openrouter, model: anthropic/claude-sonnet-5.5 }
      - { provider: anthropic, model: claude-sonnet-5-5 }
    fixer:
      - { provider: local, model: qwen3:8b }
```

| `kind` | For | Notes |
|---|---|---|
| `anthropic`, `openai`, `google` | the vendors' APIs | key from `keySecret` |
| `openrouter` | [OpenRouter](./openrouter.md): every model on prepaid credit | key `OPENROUTER_API_KEY`; pinned to the model's author, no fallbacks, no data collection; credit shown by `--check` |
| `ollama-cloud` | [Ollama Cloud](./ollama-cloud.md): open-weight models on Ollama's credit | key `OLLAMA_API_KEY`; 3 requests at once (Pro) |
| `openai-compatible` | OpenCode Zen/Go, a local Ollama, vLLM, LM Studio and other OpenAI-compatible APIs | needs `baseUrl`; the only kind that may have no key |
| `azure` | Azure OpenAI | needs `options.resourceName` or `baseUrl`; optional `options.apiVersion` |
| `bedrock` | Amazon Bedrock | needs `options.region`; the key is a Bedrock API key |
| `claude-code`, `codex` | your Claude or ChatGPT plan through the vendor's CLI | see [Use your AI subscription](./subscription.md); `binary:` points at a specific install |

`keySecret` names a secret. If that name is not declared under `secrets:`, it is allowed only on the provider's own API host; if it is declared, its `domains` must include that host. Every provider gets a network client pinned to its own host and port, so a key can't be sent anywhere else. `%cli% init --ai openrouter`, `--ai ollama-cloud --ai-model …` or `--ai openai-compatible --ai-base-url … --ai-model …` writes a setup like the one above.

Per provider, `concurrency` (requests in flight at once) and `concurrencyPerModel` cap what is sent; more requests wait their turn. The defaults are 8 for `openrouter` and 3 for `ollama-cloud`; other kinds have no cap. The cap is shared by everything in one process (a run's parallel tests, a Bench run's phases).

## Failover

Each role's pool is tried in order; the first healthy entry answers.

- An entry is **skipped** if its key is missing, its provider is misconfigured or was disabled earlier in the run, or its provider is at 90% or more of a usage cap (per 5 hours, week or month: `models.providers.<id>.caps`).
- It is skipped too when the model **can't do the work**: the provider says it can't call tools (OpenRouter and Ollama Cloud publish this), or a [model eval](#model-evals) marked it unsupported for that role. A model that can't read images gets a note in place of each screenshot (set `vision: false` on the entry to force this).
- **429 (rate limited):** the call **waits**, for the `Retry-After` time when the provider gives one, else 2 s, 4 s, 8 s and so on up to a minute, then tries the same entry again. Waiting doesn't use up a try. It moves on only when the next wait would take the call past `models.maxWaitMinutes` (default 30). Waits show live ("waiting for AI, resumes at …"), are reported apart from test time, and **don't count against a test's time limit**, so a rate limit never fails a test or changes a verdict.
- **5xx, network error, timeout:** the same entry is retried up to 2 more times (after 250 ms, then 500 ms), then the call moves on.
- **402 (out of credit, or the key's limit reached):** that provider is turned off for the rest of the run, and the call moves on.
- **404 (unknown model) or a blocked host:** it moves on at once.
- **401 or 403:** that provider is disabled for the rest of the run, and the call moves on.
- **Any other 4xx:** it stops, with the provider's message (redacted): that is a bug, not an outage.
- **Invalid structured output:** one retry with the validation error, then the next entry.

When nothing can answer, the call ends with a reason (`no_provider`, `budget_exceeded`, `all_providers_failed`, `auth_failed`, `invalid_output`, `aborted`), a plain-English message and a fix, and the affected test is **blocked** (`ai_unavailable` or `budget_exceeded`). A run is never lost to one provider's limit.

## Checking your setup

```sh
%cli% models              # each role's pool, key status and usage caps
%cli% models --check      # the cheapest possible call per provider
%cli% login               # which subscription tools are installed and signed in
```

`--check` lists models (or calls OpenRouter's `GET /key`, since its model list is public); Azure and Bedrock get a one-token completion. Each provider is `valid`, `invalid_key`, `unreachable`, `no_key`, `misconfigured` or `error`, with a fix. The network is used only when a caller asks for a completion or a check: nothing happens at startup.

## What the model sees

The page is shown as an accessibility snapshot first (cheap, deterministic), wrapped as untrusted content, with a downsampled screenshot only when needed: the snapshot was truncated, an iframe has no usable elements, or the model asked to look. Never a secret's value. The full list: [What data goes where](../security/data.md#ai-providers).

## Model evals

A model becomes a default for a role only after `%cli% bench --compare` (MOD-9) scores it on Bench's demo shop as planner and fixer, and only if it has **no wrong passes** and **no more wrong fails** than the current default, Sonnet 5.5 (0 of 62 on the shop, EVAL-0). A model can be the fixer default without being the planner default. The results, with the exact command, engine commit and date, are committed in `bench/results/`.

| Eval | Date | Models | Result |
|---|---|---|---|
| EVAL-0 | 2026-10-01 | Sonnet 4.6, Sonnet 5.5, GPT-6 Luna | Sonnet 5.5 became the default for both roles: 11/11 tests authored, 0 wrong passes, 0/62 wrong fails, about $0.047 a test. Luna: 34/62 wrong fails. |
| EVAL-1 | 2026-10-02 | DeepSeek-V4.1-Flash, GLM-5.3, Kimi-K3, MiniMax-M3 on Ollama Cloud | DeepSeek-V4.1-Flash became the first default for both roles (with an Ollama key): shop 11/11, 0 wrong passes, 0/62 wrong fails, $0.0032 a test, 15 s a test; Android 7/7, 0/10, 0/25, $0.0025 a test. GLM-5.3 also passed (11/11, 0/62, $0.018 a test) but costs more for the same result. Kimi-K3 (6/62 wrong fails) and MiniMax-M3 (11/62) are marked unsupported as planner. |

A model an eval finds unfit for a role is marked unsupported for it in the models package, with the evidence. It can't be picked for that role by accident; a pool entry can still use it with `allowUnsupported: true`.
