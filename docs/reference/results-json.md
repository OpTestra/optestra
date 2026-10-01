<!-- Generated from the results-summary JSON Schema (packages/report) by `pnpm --filter ./docs gen`. Do not edit: a test fails when this page is out of date. -->

# JSON results reference

`%cli% results <runDir> --json` prints this summary of a run (`--json <file>` writes it). It is what coding agents and tools should read: the verdict, cause and headline of every test, the failing check with expected and actual, the failing step, heals and costs. Paths are relative to the run folder. The schema is published as `%scope%/report/schema/results-summary.json`.

Machine-readable summary of one run, version 1.2. Additive changes bump the minor version; readers ignore unknown fields.

| Field | Type | Always present | |
|---|---|---|---|
| `kind` | "results-summary" | yes |  |
| `version` | string | yes |  |
| `contractVersion` | string | yes |  |
| `runId` | string | yes |  |
| `project` | string | yes |  |
| `environment` | string \| null | yes |  |
| `target` | string | yes |  |
| `trigger` | string | yes |  |
| `mode` | string | yes |  |
| `startedAt` | string | yes |  |
| `durationMs` | number | yes |  |
| `git` | null \| object | yes |  |
| `git.branch` | string \| null | yes |  |
| `git.commit` | string \| null | yes |  |
| `git.pr` | integer \| null | yes |  |
| `blocked` | null \| object | yes |  |
| `blocked.reason` | string | yes |  |
| `blocked.message` | string | yes |  |
| `exitCode` | 0 \| 1 \| 2 | yes | 0 passed, 1 failures, 2 blocked or empty. |
| `totals` | object | yes |  |
| `totals.tests` | integer | yes |  |
| `totals.passed` | integer | yes |  |
| `totals.healed` | integer | yes |  |
| `totals.failed` | integer | yes |  |
| `totals.flaky` | integer | yes |  |
| `totals.blocked` | integer | yes |  |
| `cost` | object | yes |  |
| `cost.usd` | number | yes |  |
| `cost.unpricedCalls` | integer | yes |  |
| `cost.aiCalls` | integer | yes |  |
| `cost.subscriptionCalls` | integer | yes |  |
| `failureGroups` | list of object | yes |  |
| `failureGroups[].headline` | string | yes |  |
| `failureGroups[].cause` | "product_bug" \| "test_drift" \| "environment" \| "test_data" \| "blocked" \| null | yes |  |
| `failureGroups[].tests` | list of string | yes |  |
| `tests` | list of object | yes |  |
| `tests[].testId` | string | yes |  |
| `tests[].name` | string | yes |  |
| `tests[].file` | string | yes | The test file, relative to the project. |
| `tests[].tags` | list of string | yes |  |
| `tests[].matrix` | string \| null | yes |  |
| `tests[].verdict` | "passed" \| "healed" \| "failed" \| "flaky" \| "blocked" | yes |  |
| `tests[].cause` | "product_bug" \| "test_drift" \| "environment" \| "test_data" \| "blocked" \| null | yes |  |
| `tests[].headline` | string \| null | yes |  |
| `tests[].blocked` | null \| object | yes |  |
| `tests[].blocked.reason` | string | yes |  |
| `tests[].blocked.message` | string | yes |  |
| `tests[].failingCheck` | null \| object | yes |  |
| `tests[].failingCheck.attempt` | integer | yes |  |
| `tests[].failingCheck.checkId` | string | yes |  |
| `tests[].failingCheck.stepIndex` | integer \| null | yes |  |
| `tests[].failingCheck.kind` | string | yes |  |
| `tests[].failingCheck.expectation` | string | yes | The expectation as the user wrote it. |
| `tests[].failingCheck.description` | string | yes | Plain English: what the check verified. |
| `tests[].failingCheck.expected` | string \| null | yes |  |
| `tests[].failingCheck.actual` | string \| null | yes |  |
| `tests[].failingStep` | null \| object | yes |  |
| `tests[].failingStep.attempt` | integer | yes |  |
| `tests[].failingStep.index` | integer | yes |  |
| `tests[].failingStep.key` | string | yes |  |
| `tests[].failingStep.text` | string | yes |  |
| `tests[].failingStep.status` | string | yes |  |
| `tests[].failingStep.error` | string \| null | yes |  |
| `tests[].softWarnings` | list of object | yes |  |
| `tests[].softWarnings[].attempt` | integer | yes |  |
| `tests[].softWarnings[].checkId` | string | yes |  |
| `tests[].softWarnings[].stepIndex` | integer \| null | yes |  |
| `tests[].softWarnings[].kind` | string | yes |  |
| `tests[].softWarnings[].expectation` | string | yes | The expectation as the user wrote it. |
| `tests[].softWarnings[].description` | string | yes | Plain English: what the check verified. |
| `tests[].softWarnings[].expected` | string \| null | yes |  |
| `tests[].softWarnings[].actual` | string \| null | yes |  |
| `tests[].heals` | list of object | yes |  |
| `tests[].heals[].id` | string | yes |  |
| `tests[].heals[].stepIndex` | integer | yes |  |
| `tests[].heals[].stepKey` | string | yes |  |
| `tests[].heals[].changes` | list of object | yes |  |
| `tests[].heals[].changes[].target` | "locator" \| "action" \| "wait" | yes |  |
| `tests[].heals[].changes[].before` | string | yes |  |
| `tests[].heals[].changes[].after` | string | yes |  |
| `tests[].heals[].confidence` | number | yes |  |
| `tests[].heals[].classification` | string | yes |  |
| `tests[].heals[].status` | string | yes |  |
| `tests[].heals[].policy` | string | yes |  |
| `tests[].heals[].signals` | list of object | yes |  |
| `tests[].heals[].signals[].name` | string | yes |  |
| `tests[].heals[].signals[].score` | number | yes |  |
| `tests[].heals[].signals[].detail` | string | yes |  |
| `tests[].heals[].level` | "fallback" \| "refind" \| "fixer" \| null | yes |  |
| `tests[].heals[].appliedBy` | "auto" \| "human" \| null | yes |  |
| `tests[].heals[].reviewedAt` | string \| null | yes |  |
| `tests[].heals[].behaviourChange` | boolean | yes |  |
| `tests[].heals[].diff` | string | yes |  |
| `tests[].rerecord` | null \| object | yes |  |
| `tests[].rerecord.healed` | integer | yes |  |
| `tests[].rerecord.runs` | integer | yes |  |
| `tests[].rerecord.command` | string | yes |  |
| `tests[].screenshot` | string \| null | yes | Relative to the run folder. |
| `tests[].durationMs` | number | yes |  |
| `tests[].attempts` | integer | yes |  |
| `tests[].ai` | object | yes |  |
| `tests[].ai.calls` | integer | yes |  |
| `tests[].ai.costUsd` | number | yes |  |
| `tests[].ai.recent` | null \| object | yes |  |
| `tests[].ai.recent.runs` | integer | yes |  |
| `tests[].ai.recent.calls` | integer | yes |  |
| `tests[].result` | string | yes | The test's result document, relative to the run folder. |
| `tests[].muted` | null \| object | yes | 1.2 (DIA-5): muted until a date; its verdict doesn't count. |
| `tests[].muted.reason` | string | yes |  |
| `tests[].muted.until` | string | yes |  |
| `tests[].muteExpired` | null \| object | yes |  |
| `tests[].muteExpired.reason` | string | yes |  |
| `tests[].muteExpired.until` | string | yes |  |
| `tests[].muteSuggested` | null \| object | yes |  |
| `tests[].muteSuggested.reason` | string | yes |  |
| `tests[].muteSuggested.confidence` | number | yes |  |
