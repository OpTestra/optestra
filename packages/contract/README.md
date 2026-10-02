# @optestra/contract

The results contract: the one versioned format the engine uses to describe a
run. The CLI, HTML report, PR comment, MCP server, desktop app, web app and cloud
all read this and nothing else. Depends only on zod.

## Entry points

| Import | Use | Runs in |
|---|---|---|
| `@optestra/contract` | schemas, types, enums, `foldEvents`, `summarize`, `exitCodeFor`, `runLayout`, `testIdFromPath`, `ulid`, `contractJsonSchemas` | browser and Node |
| `@optestra/contract/node` | `createRunWriter`, `readRun`, `runDir` | Node |
| `@optestra/contract/schema/{run,test-result,event}.json` | JSON Schema (generated at build) | other languages, tools |

## Versioning

`contractVersion` is `"1.<minor>"`. Additive changes bump the minor: new optional
fields, new event types, new values in the open enums (`BlockedReason`, model
`role`, heal signal `name`, model call `outcome`). Anything else bumps the major.
Readers accept every `1.x`, drop unknown fields and skip unknown event types
(`parseEvent` returns `kind: "unknown"`). The one strict object is a heal change,
so no document can express a change to an expectation (HEAL-3).

**1.2** (HEAL-0): ModelCall `note` (the model's short reasoning, scrubbed);
HealProposal `level` (`fallback | refind | fixer`), `appliedBy` (`auto | human`),
`reviewedAt`; TestResult `recentHeals` (`{ runs, healed }`, HEAL-7, with
`needsRerecord` and `REPEATED_HEALS`); the run folder's
`tests/<id>/<attempt>/heals/<healId>.json` patches and `heals/review.json`
(`HealReviewSchema`, `readHealReview` / `writeHealReview` in `./node`,
`withHealReview` to overlay the decisions on a TestResult). All optional: 1.0
and 1.1 documents parse as before.

**1.3** (PERF-0): StepResult `label` (the step as the test file numbers it,
"1 › Log in 4" inside a flow; `stepLabel` falls back to index + 1); step
screenshots may be `.jpg` (steps that passed) next to `.png` (the step that
failed), see `runLayout.screenshot`; a matrix run (TGT-5) has one TestResult
per entry, its `testId` suffixed `@<browser>-<device>` (the `matrix` field says
which); `createRunWriter({ onEvent })` sees every event as written. All
optional: older documents parse as before.

**1.4** (MOB-1): BlockedReason `app_launch_failed` (the Android app installed but
didn't start), `emulator_failed` (the emulator couldn't boot, reset or be set up)
and `driver_failed` (the on-device driver didn't start); an Android matrix entry's
`testId` is suffixed `@android<version>-<device>`. New open-enum values only:
1.0–1.3 readers accept them.

**1.5** (ADV-1): TestResult `muted`, `muteExpired` (`{ reason, until, source }`,
DIA-5) and `muteSuggested` (`{ reason, confidence }`); RunTestRef `muted` and
`totals.muted`: a muted test keeps its real verdict, and `exitCodeFor` doesn't
count it. Attempt `mocks` (`MockUse[]`: `source step|recorded`, method, url,
status, hits, stepIndex, file; ENV-4) and `accessibility` (`{ standard, pages,
ms, violations }`, each violation `rule impact help helpUrl page nodes targets`;
EVD-6), carried by `attempt.finished`; the mute fields by `test.finished`. All
optional: 1.0–1.4 documents parse as before, and older readers ignore them.

**1.6** (PROV-0): ModelCall `waitMs` (time the call waited for its provider: a
rate limit's Retry-After or no free slot; not in `latencyMs`, not counted against
the test's time limit), `listCostUsd` (at list price; null when unknown) and
`reportedCostUsd` (what the provider says it charged, e.g. OpenRouter's
`usage.cost`; `costUsd` uses it when present). AiUsage `waitMs` and RunCost
`aiWaitMs` sum the waits. New live event `model.waiting` (`provider`, `model`,
`reason rate_limited|concurrency`, `resumesAt`, `message`). All optional: older
documents parse as before, and older readers skip the event.

`fixtures/v1/` is frozen once released: `pnpm gen:fixtures` skips folders that
exist. `_future-minor/` is a 1.9 run with extra fields and an unknown event, to
prove 1.0 readers still read it.

## Enums

| Enum | Values |
|---|---|
| Verdict | `passed healed failed flaky blocked` |
| FailureCause | `product_bug test_drift environment test_data blocked` |
| BlockedReason (open) | `captcha missing_secret disallowed_domain ai_unavailable budget_exceeded app_down app_install_failed config_error aborted inbox_unavailable login_failed setup_failed app_launch_failed emulator_failed driver_failed` (`inbox_unavailable`…`setup_failed` since 1.2, the last three since 1.4) |
| StepKind | `action expect soft guard exact flow` |
| RecoveryLevel | `replay refind fixer none` |
| Trigger | `desktop web cloud ci cli agent schedule` |
| Target | `web android` |
| RunMode | `replay-only normal rerecord` |
| HealPolicy | `strict review auto` |
| StepStatus | `passed failed warned skipped blocked` |
| AttemptStatus | `passed failed blocked` |
| CheckKind | `text url element_state count network aria_snapshot screen custom` |
| ArtifactKind | `video trace screenshot console network logcat report other` |

## Documents

- **Run** (`run.json`): identity (runId ULID, versions, project, environment,
  target, trigger, mode, git), timing, run-level `blocked`, `totals` per verdict,
  `cost` (USD of priced calls, unpriced count, AI calls, tokens), `tests` (one
  summary row each, with the path of its result), plus run-level model calls,
  decisions and artifacts.
- **TestResult** (`tests/<testId>/result.json`): identity, matrix entry,
  `verdict` + `decidedBy`, `failureCause` + `failureEvidence`, `headline`,
  `checkedSummary`, timing, `ai` usage (with the LRN-5 `recent` slot), and
  `attempts`, each holding its steps, checks, model calls, decisions, heals and
  artifacts.
- **StepResult**, **CheckResult**, **HealProposal**, **DecisionRecord**,
  **ModelCall**, **ArtifactRef**: see `src/*.ts`; every field has a comment where
  it isn't obvious.

### Verdict rules (enforced by the TestResult schema)

`decidedBy` names what decided the verdict: a check, a step (element not found,
post-state mismatch) or a blocked reason. There is no way to name a model or a
decision.

- `passed`/`healed`: every decider passes (and none is a soft check), every
  attempt passed, no hard check failed; `healed` needs a heal proposal in the final
  attempt and `passed` must have none.
- `failed`: a failing check or step in `decidedBy`, final attempt failed, a cause
  other than `blocked`.
- `flaky`: a failed attempt then a passed final attempt; deciders from both.
- `blocked`: a blocked reason in `decidedBy` and cause `blocked`.

## Events

`events.ndjson`, one object per line: `seq` (0, 1, 2…), `ts`, `runId`, `type`.

`run.started, test.started, attempt.started, step.started, step.finished,
check.evaluated, model.called, decision.made, heal.proposed, artifact.written,
attempt.finished, test.finished, run.finished, log`

`foldEvents(events)` rebuilds the Run and TestResults; the writer uses it for
`finish()`, so the documents are always exactly the fold of the events.
`step.started` and `log` are live-view only and leave no trace in the documents.

## Writing a run

```ts
import { createRunWriter, runDir } from "@optestra/contract/node";

const writer = createRunWriter(runDir(dataDir, runId), {
  scrub: (text) => redactor.redact(text), // the config redactor; required
});
writer.emit({ type: "run.started", engineVersion, project, environment, target, trigger, mode });
// … test.started, attempt.started, step.* , check.evaluated, …
writer.writeArtifact({ kind: "trace", path, contentType: "application/zip", scrubbed: true, testId, attempt }, bytes);
writer.emit({ type: "run.finished" });
writer.finish(); // writes tests/*/result.json and run.json atomically
```

Every string in every event passes through `scrub`, text artifacts are scrubbed
again, and artifacts not declared `scrubbed: true` are refused (EVD-5).

## Exit codes (CLI-5)

`exitCodeFor(run, { healedCountsAsPass, flakyCountsAsFailure = true })`, first match wins:

| Code | When |
|---|---|
| 1 | any failed test |
| 1 | any flaky test (unless `flakyCountsAsFailure: false`) |
| 1 | any healed test (unless `healedCountsAsPass`) |
| 2 | the run itself was blocked (`config_error`, `aborted`, …) |
| 2 | any blocked test |
| 2 | no tests ran |
| 0 | otherwise |
