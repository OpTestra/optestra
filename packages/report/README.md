# @testament/report

Turns a run folder (the [results contract](../contract/README.md)) into what
people and tools read: an offline HTML report, JUnit XML, a JSON summary for
coding agents, a Markdown summary for the PR comment and job summary, and quiet
terminal output.

Every output is a pure function of the run's documents (`run.json` and
`tests/*/result.json`). Nothing here imports core, browser, models or decide,
and nothing reads artifact contents, logs or `events.ndjson`, so an output can
never carry a value that isn't already in the (scrubbed) documents.

## Entry points

| Import | Use | Runs in |
|---|---|---|
| `@testament/report` | `renderHtmlReport`, `renderJunit`, `renderJsonSummary` / `buildResultsSummary`, `renderMarkdownSummary`, `fillArtifactLinks`, `formatTestLine` / `formatRunSummary` / `formatTerminal`, `buildModel`, `defaultTokens` | browser and Node |
| `@testament/report/node` | `loadRunData`, `writeHtmlReport`, `writeFileAtomic`, `latestRunDir`, `runsDir`, `shouldUseColor`, `openFile` | Node |
| `@testament/report/schema/results-summary.json` | JSON Schema of the JSON summary (generated at build) | other languages, tools |

All renderers take `RunData = { run, tests, diagnostics? }`, which is what
`readRun` from `@testament/contract/node` returns (`loadRunData` wraps it).

```ts
import { renderMarkdownSummary } from "@testament/report";
import { loadRunData, writeHtmlReport } from "@testament/report/node";

const loaded = loadRunData(runDir);
if (loaded.ok) {
  writeHtmlReport(runDir, loaded.data);            // runDir/index.html
  const comment = renderMarkdownSummary(loaded.data, { reportUrl });
}
```

## CLI

```
testament report [runDir] [--out dir] [--open] [-C dir]
testament results <runDir> [--junit file] [--json [file]] [--markdown file]
```

`report` defaults to the newest finished run in the project's data folder
(`<data dir>/runs/<ULID>/`). `--out` writes `index.html` elsewhere; artifact
links then point back into the run folder. `results --json` with no file prints
the JSON summary instead of the text output; with a file it writes it and prints
the text as usual. Exit codes are unchanged (CLI-5).

## HTML report (EVD-2)

One `index.html`, written into the run folder. Inline CSS and JS only; no CDN,
web fonts or remote scripts; a Content-Security-Policy that allows no network.
Screenshots, video, traces and logs are linked relative to the run folder, so
the folder can be zipped and opened anywhere.

In order:

1. **Header**: project, environment, overall verdict, run id, time, target,
   trigger, mode, git branch / commit / PR.
2. **What went wrong** (DIA-4): failed, flaky and blocked tests grouped by what
   went wrong ("… · affects 7 tests"). Each group leads with the headline, the
   check's expected vs actual and the screenshot (DIA-3), then the tests.
3. **Summary**: verdict counts, duration, AI calls and tokens, cost (with
   "N calls via your subscription" when billing says so), environment, versions.
4. **Fixes to review** (HEAL-4): every heal proposal with its change and confidence.
5. **Soft-check warnings**: listed apart, never shown as failures.
6. **Problems reading this run**: reader diagnostics, when there are any.
7. **Tests**, with verdict / tag filters and search (JS). Per test: headline and
   screenshot; the cause label with its evidence (DIA-1); "what was checked"
   (EVD-3); file, matrix entry, tags; AI use with "used AI N times in its last M
   runs" (LRN-5); then each attempt: steps with status, recovery level, locator,
   post-state and before/after screenshots; checks with expected vs actual and
   the generated code; heal proposals with their signals, confidence and diff
   (HEAL-6); AI calls (role, model, tokens, cost, latency, outcome); decision
   records (collapsed); video (with WebVTT step chapters when the run has a
   `text/vtt` artifact), trace (with the `npx playwright show-trace` command),
   console, network and logcat links.

Collapsing uses `<details>`, so the whole report works with JavaScript off
(only the filters need it). Keyboard accessible; axe-clean in light and dark.

**Look.** Colours, type and spacing come only from `src/tokens.ts`
(`defaultTokens`); pass `tokens` to `renderHtmlReport` to restyle it. The
stylesheet reads nothing but the CSS variables made from the tokens.

## JUnit XML (EVD-4)

`testsuites > testsuite` (one per run, with run properties) `> testcase` (one
per test result, so one per matrix entry; the matrix label is added to the name
when names repeat). `classname` and `file` are the test file.

| Verdict | JUnit |
|---|---|
| passed | passes |
| healed | passes, properties `healed=true`, `healed.fixes` |
| flaky | passes, properties `flaky=true`, `flaky.headline`, `flaky.cause`; the failed attempt's check in `system-out` |
| failed | `<failure message="headline" type="cause">` with check, expected, actual, step, file, screenshot |
| blocked | `<skipped message="Blocked (reason: message)">` |

A blocked run adds a `blocked` property and `system-err`. Validated in the tests
against `test-support/junit.xsd` (the Jenkins / Surefire / GitLab shape) and
checked with junitparser / junit2html.

## JSON summary (AGT-3)

`kind: "results-summary"`, `version: "1.0"`. Same rules as the contract:
additive changes bump the minor, readers ignore unknown fields. Schema:
`resultsSummaryJsonSchema()` / `dist/schema/results-summary.schema.json`.

| Field | Meaning |
|---|---|
| `runId`, `project`, `environment`, `target`, `trigger`, `mode`, `startedAt`, `durationMs`, `git`, `contractVersion` | the run |
| `blocked` | `{ reason, message }` when the whole run was blocked |
| `exitCode` | CLI-5 code under the policy passed (`results` passes its flags) |
| `totals` | tests per verdict |
| `cost` | `usd`, `unpricedCalls`, `aiCalls`, `subscriptionCalls` |
| `failureGroups[]` | `{ headline, cause, tests: testId[] }` (DIA-4) |
| `tests[].verdict`, `cause`, `headline` | what happened and why |
| `tests[].file` | the test file, relative to the project |
| `tests[].failingCheck` | `{ attempt, checkId, stepIndex, kind, expectation, description, expected, actual }` |
| `tests[].failingStep` | `{ attempt, index, key, text, status, error }` (0-based index) |
| `tests[].blocked` | `{ reason, message }` |
| `tests[].heals[]` | `{ id, stepIndex, stepKey, changes, confidence, classification, status, policy, signals }` |
| `tests[].softWarnings[]` | soft checks that didn't pass (never failures) |
| `tests[].screenshot`, `result` | paths relative to the run folder |
| `tests[].ai` | `{ calls, costUsd, recent: { runs, calls } \| null }` |

## Markdown summary (CI-2, CI-5)

`renderMarkdownSummary(data, options)`: title, status table (passed / healed /
failed / flaky / blocked), tests, time, AI calls and cost, then each failure
group's headline, expected vs actual and a screenshot link; fixes to review,
soft warnings, AI use per test (LRN-5) and all tests in `<details>` blocks; a
"see the full report" line (`reportUrl`, or the report command).

- **Length cap**: `maxLength` (default 60,000, never above GitHub's 65,536).
  Detail is dropped level by level (fewer groups, then no lists); a last-resort
  cut keeps `<details>` balanced.
- **Screenshots**: linked as `artifact:<run-folder path>`. The Action uploads
  them and calls `fillArtifactLinks(md, path => url)`, or passes `artifactUrl`.
- **Escaping**: contract text can't produce HTML, links, table breaks, math or
  @mentions.

## Terminal (CLI-4)

`formatTestLine(test)` prints one line per test (verdict, duration, AI calls,
cost, name, and the headline under non-passing tests); `formatRunSummary(data)`
prints the failure groups and the summary line. `formatTerminal` is both, as
`results` prints it. Colour only with `color: true`; `shouldUseColor(stream)`
turns it on for a TTY and honours `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb`.
Control characters in contract text are stripped.

## Tests

- `src/report.test.ts` (in `pnpm check`): golden files for every contract
  fixture in every format (`golden/<fixture>/`), JSON against its schema (ajv),
  JUnit against the XSD (xmllint, where installed), no external URLs, the
  Markdown cap on a 5,000-test run, escaping, and the planted-secret test:
  a secret written into every artifact, log and event (and the environment)
  appears in no output, and every output is byte-identical to the clean run's.
- `e2e/report.browser.test.ts` (`pnpm --filter @testament/report test:browser`,
  in the CI `fixtures` job): each fixture's report opened from disk in Chromium
  with axe (light and dark), zero network requests, images loading, JS disabled,
  the first screen showing the headline and screenshot, and the filters.
