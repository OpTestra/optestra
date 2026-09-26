# @testament/models

The ONE layer through which the engine talks to AI models. Callers see only this
interface; the Vercel AI SDK and provider packages are an implementation detail.
Importing the package registers the `models` config section.

```ts
import { BudgetMeter, createModels } from "@testament/models";

const models = createModels({ config, sources, environment, budgets: [BudgetMeter.forRun(config)] });
const result = await models.complete("planner", { system, messages, output: schema });
if (result.ok) use(result.object);
else block(result.reason, result.message, result.fix); // never throws on provider trouble
```

## Providers

Kinds: `anthropic`, `openai`, `google`, `openai-compatible` (OpenRouter, OpenCode
Zen/Go, Ollama, vLLM, LM Studio, our future hosted AI), `azure` (needs
`options.resourceName` or `baseUrl`; optional `options.apiVersion`) and `bedrock`
(needs `options.region`; the key is a Bedrock API key).

`keySecret` names a secret. If that name is not declared under `secrets:`, it is
implicitly allowed only on the provider's API host. If it is declared, its
`domains` must include that host. Only `openai-compatible` providers may have no key.

## Roles and failover (MOD-8)

Roles: `planner` and `fixer`. The decider (DEC phase) has its own protocol and
will be added there. Each role is an ordered pool; the first healthy entry answers.
- An entry is **skipped** if its key is missing, its provider is misconfigured,
  its provider was disabled earlier in the run, or its provider is at ≥90% of any
  usage cap (5h / week / month).
- **429, 5xx, network error, timeout:** retry the same entry up to 2 more times
  with a short backoff (250 ms, then 500 ms), then move on.
- **404 (unknown model) or a blocked host:** move on at once.
- **401/403:** `auth_failed` for that entry. Its provider is disabled for the rest
  of the run (this client), and the call moves on.
- **Any other 4xx (e.g. 400):** stop, with no failover (it's our bug). Returns
  `all_providers_failed` with the provider's message, redacted.
- **Invalid structured output:** one retry on the same entry with the validation
  error appended, then the next entry.

Failure reasons:
- `no_provider`: nothing usable.
- `budget_exceeded`
- `all_providers_failed`
- `auth_failed`: every tried entry rejected its key.
- `invalid_output`: no entry produced valid output.
- `aborted`

Each comes with a plain-English `message` and a `fix`.

## Cost, caps and budgets

- **Price table:** `prices.yaml` (USD per million tokens), overridable with
  `models.prices`. Cost reported by the provider (e.g. OpenRouter `usage.cost`)
  wins. It is read from the response body by the transport. An unknown price gives
  cost `null` and a warning, never a guess.
- **Usage caps:** a `UsageStore` records spend per provider. `projectUsageStore(dir)`
  writes `<project>/.testament/usage.json` (the folder name comes from brand);
  `MemoryUsageStore` keeps it in memory. The cloud will plug in a shared store.
- **Budgets:** a `BudgetMeter` per run and per suite (`run.budget`). It is checked
  before every call and stops the call with `budget_exceeded`. Actual cost is added
  afterwards, so **one call already in flight may overshoot a cap**. Calls with
  unknown cost are counted separately (`unknownCostCalls`).

## Records

Every `complete` call emits a plain, serialisable `ModelCallRecord` to `onCall`
and as a debug log line through the redacting logger. It holds role, provider,
model, usage, cost, latency, every attempt and outcome, and tags.

## Security

- Keys are FND-1 `SecretValue`s. They are revealed only inside this package at
  request time, via `@testament/config/reveal`.
- `transport.ts` is the only file in the engine allowed to make network calls.
  Every provider gets a fetch pinned to its own host (host and port). A request
  to any other host is refused, so a key can't be sent elsewhere.
- The network is only used when a caller asks for a completion or a key check.
  Nothing happens at import.
- The AI SDK's console warnings are turned off; warnings go through the redacting logger.
- Provider error bodies are redacted before they reach results, records or logs.

## Key check

`checkProviders(config, { sources })` makes the cheapest call per provider:
- **anthropic, openai, google, openai-compatible:** list models, or `GET /key`
  for OpenRouter, whose model list is public.
- **azure, bedrock:** a 1-token completion.

Each provider is reported as `valid`, `invalid_key`, `unreachable`, `no_key`,
`misconfigured` or `error`, with a fix.

## Manual smoke test (real key, not CI)

```sh
pnpm build && ANTHROPIC_API_KEY=... node packages/models/scripts/smoke.ts
```
