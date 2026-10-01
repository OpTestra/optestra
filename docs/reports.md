# Reports

Every run writes a results folder, `%dataDir%/runs/<run id>/`. Everything people and tools read is made from its documents (`run.json` and `tests/*/result.json`), which are already scrubbed of secrets.

```sh
%cli% report [runDir] [--out dir] [--open]
%cli% results <runDir> [--junit file] [--json [file]] [--markdown file] [--report-url url]
```

`report` defaults to the newest finished run of the project. `results` prints the summary and exits with the run's CI code; `--json` with no file prints the JSON summary instead.

## The HTML report

One `index.html` in the run folder, with inline CSS and JavaScript only: no CDN, no web fonts, no remote scripts, and a Content-Security-Policy that allows no network. Screenshots, video, traces and logs are linked relative to the run folder, so the folder can be zipped and opened anywhere.

1. **Header:** project, environment, overall verdict, run id, time, target, trigger, mode, git branch, commit and PR.
2. **What went wrong:** failed, flaky and blocked tests grouped by what went wrong ("… · affects 7 tests"). Each group leads with the headline, the check's expected and actual, and the screenshot.
3. **Summary:** verdict counts, duration, AI calls and tokens, cost ("N calls via your subscription" where that applies), environment, versions.
4. **Fixes to review:** every heal proposal with its change and confidence.
5. **Soft-check warnings,** listed apart: never failures. Then **muted tests** ([Muting a test](./runs/quarantine.md)) and **accessibility warnings** ([Accessibility warnings](./runs/accessibility.md)), also apart.
6. **Tests,** with verdict and tag filters and search. Per test: the headline and screenshot; the cause with its evidence; what was checked; responses that came from a [mock](./writing/mocks.md); AI use over the test's last runs; then each attempt: steps with before and after screenshots, checks with expected and actual, heals with their signals and diff, AI calls, decisions, the video (with a chapter per step), the trace (with the `npx playwright show-trace` command), console and network logs.

Collapsed sections use `<details>`, so the report works with JavaScript off (only the filters need it). It is keyboard accessible and checked with axe in light and dark mode. Its look comes from one tokens file, like this site's.

## JUnit XML

`--junit <file>`: one `testcase` per test result, for your CI's test tab.

| Verdict | JUnit |
|---|---|
| passed | passes |
| healed | passes, with properties `healed=true` and the fixes |
| flaky | passes, with properties `flaky=true`, the headline and the cause; the failed attempt's check in `system-out` |
| failed | `<failure message="headline" type="cause">` with the check, expected, actual, step, file and screenshot |
| blocked | `<skipped message="Blocked (reason: message)">` |
| muted, and didn't pass | `<skipped message="Muted until date (verdict): reason">`, with properties `muted`, `muted.until`, `muted.reason` |

Mocked responses add the property `mocked.responses`; accessibility checks add `<property name="accessibility.pages">`, `<property name="accessibility.warnings">` and one `<property name="accessibility.warning">` per problem.

Validated against the Jenkins/Surefire/GitLab JUnit schema.

## JSON summary

`--json`: the machine-readable summary for coding agents and tools, `kind: "results-summary"`, versioned (additive changes bump the minor, readers ignore unknown fields). Every field: [JSON results reference](./reference/results-json.md).

## Markdown summary

`--markdown <file>`: what the [GitHub Action](./ci/github-action.md) posts as its PR comment and job summary, and what other CIs can post as a merge-request note: the status table, each failure group's headline, expected and actual and a screenshot link, fixes to review, soft warnings, AI use per test and all tests in collapsed blocks, and a link to the full report (`--report-url`). It is capped below GitHub's 65,536-character limit by dropping detail level by level, and escaped so test text can't produce HTML, links, table breaks or @mentions.

## Terminal

One line per test (verdict, duration, AI calls, cost, name, and the headline under anything that didn't pass), the failure groups, and a summary line. Colour only on a terminal, honouring `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb`.
