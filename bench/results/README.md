# Bench results

Committed results of real-model runs. Each file names the engine version,
commit, OS, model ids, prompt versions, date and the exact command. Costs are
at list API prices (`packages/models/prices.yaml`), also for calls that went
through a subscription CLI.

## 2026-10-02-android-open-models.json (EVAL-1, Android)

```bash
node packages/cli/bin/cli.js bench --compare ollama-cloud:deepseek-v4.1-flash --fixture android --model-budget 1 --yes
```

Engine at ab268c8, the same Mac; Android 16 emulator (pixel-8, google_apis
arm64). DeepSeek-V4.1-Flash only, Android only (no shop, drafts or explains:
`--fixture android`), after the no-AI Android replay passed (42/42, 0 mismatch,
0 AI). 75 calls, $0.020 of Ollama credit.

| Model | Passed after authoring | Wrong pass | Wrong fail | Cosmetic passed or healed | Fixer heals | $/test medium · complex | $/heal | s/test authoring | Authoring calls · $ |
|---|---|---|---|---|---|---|---|---|---|
| deepseek-v4.1-flash | 7/7 | 0/10 | 0/25 | 7/7 | 4 | $0.0024 · $0.0030 | $0.0006 | 31 | 69 · $0.017 |
| *claude-sonnet-5-5 (EVAL-0)* | *7/7* | *0/10* | *0/25* | *7/7* | *4* | *$0.044 · $0.062* | *$0.0078* | *45* | *68 · $0.328* |

The same quality as Sonnet 5.5 on every number, at about a nineteenth of the
authoring cost: the Android default stands with the web one.

## 2026-10-02-open-models.json (EVAL-1)

```bash
node packages/cli/bin/cli.js bench --compare ollama-cloud:deepseek-v4.1-flash ollama-cloud:minimax-m3 ollama-cloud:glm-5.3 ollama-cloud:kimi-k3 --model-budget 1.5 --yes
```

Engine 0.1.0 at ac735fc, macOS arm64 (Apple M5, 10 cores), started
2026-10-02T17:29Z. Same method and prompts as EVAL-0 (planner-v3, fixer-v1,
checks-v1, drafter-v1), shop only (11 tests, 62 replays; the API fixture of SPEC-2
hasn't landed). Open-weight models on Ollama Cloud with the user's own key
(OpenAI-compatible `ollama.com/v1`, 3 requests at once), each once as planner and
fixer, with a $1.50 budget per model. Sonnet 5.5 is the reference from EVAL-0
(not re-run).

| Model | Passed after authoring | Wrong pass | Wrong fail | Cosmetic passed or healed | Fixer heals | $/test medium · complex | $/heal | $/draft | s/test authoring | Calls | Model total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v4.1-flash | 11/11 | 0/15 | 0/62 | 10/11 | 4 | $0.0024 · $0.0041 | $0.0004 | $0.0084 | 15 | 183 | $0.064 |
| glm-5.3 | 11/11 | 0/15 | 0/62 | 10/11 | 4 | $0.014 · $0.022 | $0.0020 | $0.075 | 19 | 162 | $0.439 |
| kimi-k3 | 10/11 | 0/15 | 6/62 | 9/11 | 4 | $0.069 · $0.108 | $0.0079 | $0.162 | 37 | 178 | $1.496 |
| minimax-m3 | 9/11 | 0/15 | 11/62 | 8/11 | 4 | $0.012 · $0.014 | $0.0012 | $0.025 | 36 | 206 | $0.299 |
| *claude-sonnet-5-5 (EVAL-0)* | *11/11* | *0/15* | *0/62* | *10/11* | | *$0.036 · $0.059* | *$0.0057* | *$0.045* | *28* | | |

Totals: 729 calls, $2.30 of Ollama credit at its peak list rates (DeepSeek bills
half off-peak, after 18:00 UTC, so its real charge may be lower; Ollama reports no
cost per call).

Decision rule (the architect's): a model becomes a role's default only with 0
wrong passes and no more wrong fails than Sonnet 5.5 (0/62).

- **deepseek-v4.1-flash passes for planner and fixer** and is the cheapest and
  fastest of the two that pass: it is now first in the default planner and fixer
  pools, used when an `OLLAMA_API_KEY` is set (about a fifteenth of Sonnet 5.5's
  cost per authored test). Android was measured afterwards: see below.
- glm-5.3 passes too, at about 5× DeepSeek's cost for the same result: no default.
- kimi-k3 (sort-orders recorded wrong: 6/62) and minimax-m3 (checkout-trial and
  sort-orders: 11/62) fail; both are marked unsupported as planner (and drafter)
  in `packages/models/src/capabilities.ts`. Their fixer heals were fine (4 each),
  but neither beats DeepSeek as fixer, so no fixer default either.

Notes:

- Kimi-K3 reached its $1.50 budget at the end: its third draft stopped and it made
  one explain instead of two. Its quality numbers were complete before that.
- Kimi-K3 reported no cached input tokens on Ollama; the other three did (cache
  reads 57–79% of input).
- GLM-5.3 reads no images: its screenshots were replaced by a note, and it still
  authored every test.
- As in EVAL-0, the draft sentences give no login details, so drafts ended
  "incomplete" or "impossible": their cost is comparable, their success isn't.
- Before this run, the real smoke on Ollama found and fixed three engine problems
  (commit ac735fc): the JSON schema wasn't sent (json_object only), empty answers
  were counted as network errors, and thinking models ran out of the engine's
  200–500-token output caps (now at least 4,096 for models that think).

## 2026-10-01-model-comparison.json (EVAL-0)

```bash
node packages/cli/bin/cli.js bench --compare claude-code:claude-sonnet-4-6 claude-code:claude-sonnet-5-5 codex:gpt-6-luna --fixture all --yes
```

Engine 0.1.0 at a586e11, macOS arm64 (Apple M5, 10 cores). Prompts planner-v3,
planner-android-v2, fixer-v1, checks-v1, drafter-v1. Claude Code and Codex
0.159.3, both signed in to a subscription. Each model ran once per fixture:
the shop (11 tests, 62 replays across the variants) and Android (7 tests, 25).

| Model | Fixture | Passed after authoring | False pass | False fail | Cosmetic passed or healed | $/test medium · complex | $/heal | $/draft | s/test authoring | Calls |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-4-6 | shop | 7/11 | 0/15 | 14/62 | 9/11 | $0.075 · $0.110 | $0.0085 | $0.131 | 57 | 135 |
| claude-sonnet-4-6 | android | 7/7 | 0/10 | 3/25 | 7/7 | $0.062 · $0.091 | $0.0124 | – | 72 | 73 |
| claude-sonnet-5-5 | shop | 11/11 | 0/15 | 0/62 | 10/11 | $0.036 · $0.059 | $0.0057 | $0.045 | 28 | 114 |
| claude-sonnet-5-5 | android | 7/7 | 0/10 | 0/25 | 7/7 | $0.044 · $0.062 | $0.0078 | – | 45 | 73 |
| gpt-6-luna | shop | 4/11 | 0/15 | 34/62 | 7/11 | $0.005 · $0.010 | $0.0009 | $0.006 | 104 | 138 |
| gpt-6-luna | android | 5/7 | 0/10 | 7/25 | 6/7 | $0.007 · $0.013 | $0.0008 | – | 100 | 71 |

Totals: Sonnet 4.6 242 calls, $2.03; Sonnet 5.5 205 calls, $1.06; GPT-6 Luna
225 calls, $0.18 (CLI check, both fixtures, 3 drafts and 2 explains each).

Notes:

- No test in either fixture is "simple" (4 steps or fewer, no login), so there
  is no simple-test price.
- The drafts' sentences give no login details, so most drafts ended
  "impossible" or "incomplete". Their cost is comparable; their success isn't.
- Codex adds about 12.8K input tokens of its own to every call (a "Say ok"
  check cost 12,816). Luna's per-call input is several times the Sonnets'.
- Runs 2–10 replayed with no AI calls for every model. After the cosmetic
  heals were accepted, the shop's next run made 2 calls (Sonnet 4.6, Sonnet 5.5
  and Luna each); Android made none.
- Mailpit wasn't running, so the shop's emails went through the fixture's
  built-in inbox.

No-model facts (same file, `facts`): web replay 0.8 s/test and about 0.9 s CPU
machine-wide; Android replay 18.0 s/test and about 56 s CPU. Browser launch
155 ms; web session 27 ms; emulator ready 4.8 s; Android session 14.1 s.
Evidence per test (passing / failing): shop full 0.45 / 0.97 MB, failures
0.025 / 0.59 MB, minimal 0.024 / 0.38 MB; Android full 7.7 / 10.9 MB, failures
6.5 / 13.0 MB, minimal 6.5 / 12.7 MB (Android keeps the screen video in every
mode). Decision layer: rules $0, Jev $0.0147 per 1,000 decisions, Laya $0
(local).

## 2026-09-30-shop-models.json

`bench --models`: the shop model eval (BEN-0).
