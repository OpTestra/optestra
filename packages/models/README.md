# @optestra/models

The ONE layer through which the engine talks to AI models. Callers see only this
interface; the Vercel AI SDK and provider packages are an implementation detail.
Importing the package registers the `models` config section.

```ts
import { BudgetMeter, createModels } from "@optestra/models";

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

Plus `claude-code` and `codex`: your own AI subscription through its official CLI (see [Use your AI subscription](#use-your-ai-subscription-mod-6)).

`keySecret` names a secret. If that name is not declared under `secrets:`, it is
implicitly allowed only on the provider's API host. If it is declared, its
`domains` must include that host. Only `openai-compatible` providers may have no key.

## Use your AI subscription (MOD-6)

Instead of an API key, Optestra can use the AI plan you already pay for. It does
this through the vendor's **own official command-line tool**, which you install
and sign in to yourself. The two provider kinds are `claude-code` and `codex`.
They are in the default pools, after the API-key entries. They are used when
the tool is installed and signed in, so with no API key and a signed-in Claude
Code, planner and fixer simply work.

| Vendor | Plans | Tool | Sign in (in the vendor's tool) | Supported |
|---|---|---|---|---|
| Anthropic | Claude Pro, Max, Team, Enterprise | Claude Code ≥ 2.1.259 | `claude auth login` | yes |
| OpenAI | ChatGPT Plus, Pro, Business, Enterprise | Codex (with the lock-down flags below) | `codex login` | yes |
| Google | Gemini, AI Pro, Ultra | — | — | **no**: Google bans using Gemini CLI's Google sign-in from other tools. Use a Gemini API key (`GEMINI_API_KEY`), which has a free tier |
| GitHub | Copilot | Copilot CLI | — | **no**: GitHub documents a programmatic mode and an SDK, but we found no terms that clearly let a third-party tool drive it on a user's plan |

`login` lists which tools are ready and the exact sign-in command. It never
signs in for you. `models --check` reports, for each tool: installed (and its
version), recent enough, and signed in. It asks the tool's own status command
and never reads its files.

### What Optestra does and never does

- **Never touches your sign-in.** Optestra never reads, copies, stores, logs or
  forwards the tool's tokens or config files. Sign-in happens only in the
  vendor's tool. We run the unmodified binary, as you.
- **The tool is a model, not an agent (SAF-2).** Every one of its own tools is
  off: no shell, no file read, write or edit, no web fetch or search, no MCP
  servers, no plugins, hooks or skills, no project instruction files
  (CLAUDE.md, AGENTS.md) and no session history. It runs in a new, empty
  temporary folder, which is deleted afterwards. Its environment holds only
  `HOME`, `PATH`, `USER`, `LANG`, the Windows profile variables, the tool's own
  config-location variable if you set one, and the lock-down switches. None of
  our API keys or secrets are passed. The browser is still only ever touched
  through our closed action set.
- **Local only.** `models.allowDelegated` (default `true`) is set to `false` in
  Optestra Cloud workers. We never route other people's usage through a
  subscription.
- **Honest about cost and limits.** Calls are recorded with
  `billing: "subscription"` and cost 0 to the run budget. Tokens and the tool's
  own cost estimate (`reportedCostUsd`) are kept for information. Advertised
  plan limits assume ordinary individual use, so each tool gets at most
  `models.delegatedCallsPerRun` calls per run (default 60, PERF-0). A run that
  reaches it gets no more subscription calls: the call fails with "This run has
  made its 60 calls through your AI subscription…" (and how to raise it), so its
  remaining AI steps are blocked `ai_unavailable` with that message. When the vendor
  says the plan limit is hit, the call fails over to the next pool entry, or
  stops with "Plan limit reached".

### The exact commands

Claude Code (headless print mode, prompt as stream-json on stdin):

```
claude -p --restricted --tools "" --disallowedTools "mcp__*" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
       --disable-slash-commands --no-session-persistence --permission-mode dontAsk --permission-prompts none
       --system-prompt <ours> --input-format stream-json --output-format stream-json --verbose
       --json-schema <reply schema> [--model sonnet|haiku|…]
env: CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1
     CLAUDE_CODE_DISABLE_WORKFLOWS=1 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 CLAUDE_CODE_DISABLE_ATTACHMENTS=1
     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_SKIP_PROMPT_HISTORY=1 DISABLE_AUTOUPDATER=1
```

`--bare` is **not** used: bare mode ignores subscription sign-in (it needs an
API key). `--restricted`, which Anthropic built for evaluation harnesses,
together with `--tools ""` gives the same lock-down while keeping your own
sign-in. Images (the `look` screenshot) go in as stream-json image blocks.

Codex (prompt on stdin):

```
codex exec --json --output-schema <file> --output-last-message <file> --sandbox read-only -c approval_policy="never"
      --skip-git-repo-check --ephemeral --ignore-user-config --cd <empty temp folder>
      -c features.shell_tool=false -c features.unified_exec=false -c features.multi_agent=false -c features.apps=false
      -c features.hooks=false -c features.memories=false -c web_search="disabled" -c tools.view_image=false
      -c project_doc_max_bytes=0 -c history.persistence="none" [--model …] [--image <file>…] -
```

Before first use, Optestra checks the version (`claude --version`) or the
flags (`codex exec --help`). A tool without every lock-down flag is refused
with the fix (`cli_unavailable`). On Windows the native `claude.exe` /
`codex.exe` is needed, because `.cmd` shims would need a shell. `binary:` in a
provider entry points at a specific install. Both argument lists are pinned in
`src/delegated/delegated.test.ts`.

### Tool calls over structured output

The tools' own tool calling is off, so the request's tools become a JSON Schema
for the reply: `{ toolCalls: [{ name, input }], text }`, where each item is one
of our tools with that tool's input schema. The reply is turned back into
`ToolCall[]`, and callers (the author) see no difference. For Codex, the schema
is made strict: every property is required, and optional ones become nullable
(the nulls are dropped again). An invalid reply is retried once, then
`invalid_output`.

### Terms (checked 2026-09-26)

- Anthropic: https://code.claude.com/docs/en/legal-and-compliance ("Authentication and credential use"): third parties may not offer Claude.ai login or route requests through Free, Pro or Max credentials on behalf of users, nor collect or store Claude.ai tokens; this "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- OpenAI: https://developers.openai.com/codex/auth: ChatGPT sign-in is supported for Codex, and API keys remain the recommended default for automation. We use ChatGPT sign-in only on your own machine, for your own runs.
- Google: using Gemini CLI's Google sign-in from other tools is not allowed, so API keys only.

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
  writes `<project>/.optestra/usage.json` (the folder name comes from brand);
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
  request time, via `@optestra/config/reveal`.
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
