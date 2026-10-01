---
"@optestra/models": minor
"@optestra/contract": minor
"@optestra/config": minor
"@optestra/core": minor
"@optestra/cli": minor
---

Use your AI subscription (MOD-6): new `claude-code` and `codex` provider kinds
run the user's own signed-in Claude Code or Codex, locked down to a model (no
tools, no files, no web, minimal environment, empty temp folder), with tool
calls over structured output. They follow the API-key entries in the default
pools, are local only (`models.allowDelegated`, which the cloud sets false),
and are capped per run (`models.delegatedCallsPerRun`). Calls record
`billing: "subscription"` (contract 1.1, optional field) and cost 0 to budgets.
The CLI gains `login` and subscription checks in `models --check`.
