# Bench results

Committed results of real-model runs. Each file names the engine version,
commit, OS, model ids, prompt versions, date and the exact command. Costs are
at list API prices (`packages/models/prices.yaml`), also for calls that went
through a subscription CLI.

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
