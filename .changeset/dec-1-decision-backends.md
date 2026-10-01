---
"@optestra/decide": minor
"@optestra/config": minor
"@optestra/cli": minor
---

Add the decision model backends to `@optestra/decide/node`: one System One
client for Jev (hosted by TypeSafe AI), Kev (self-hosted) and Laya (through the
local Ollaya server), with host-pinned requests, redacted state, token usage and
cost, and a Laya warm-up at run start. `decisions.backend` now defaults to
`auto` (Jev when `JEV_API_KEY` is set, otherwise rules only) and accepts
`none | jev | kev | laya`, with `jev`, `kev` and `laya` settings blocks. The CLI
gains `decisions --check`, `decisions --bench [--backend] [--n]` and
`decider setup laya [--model] [--yes]` (never installs Ollaya; asks before
downloading a model).
