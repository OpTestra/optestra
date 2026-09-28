# GitHub Action

The Action runs your tests on every pull request, **in your own runner, with your own keys**. Nothing is sent to us. You get:

- **One PR comment, updated in place** on every push (never a new one per push): a status table, each failure's headline with a link to its screenshot, fixes to review, AI calls and cost, AI use per test over time, and a link to the full report. Short by default, details collapsed, always under GitHub's size limit.
- **A status check.** Real failures fail it. **Blocked is neutral**: a test that couldn't run is never shown as passed or failed.
- **Artifacts:** the HTML report with videos, traces and screenshots; the first five failure screenshots also as single files, linked straight from the comment.
- **The same summary in the job summary**, and JUnit XML for other tools.
- **Changed expectations are flagged.** When a pull request adds, removes or changes an `Expect:` line in a test file, the comment says so first, so a human reviews it: nobody (and no coding agent) can quietly make a test pass by editing what it expects.

![The PR comment for a run with one product bug: a status table, the failure's headline with expected and actual, and collapsed details](/images/pr-comment.png)

```yaml
# .github/workflows/e2e.yml
name: e2e
on:
  pull_request:

permissions:
  contents: read        # check out the code
  pull-requests: write  # the PR comment
  checks: write         # the status check

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # …start your app, or test a deployed preview (see Preview deploys)…
      - uses: %repo%/packages/action@v1
        with:
          version: 0.4.2
        env:
          # Only what your tests declare under `secrets:` (and an AI key if mode is normal).
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
```

::: info Before the first release
The Action installs the CLI from npm (`version`), and `@v1` is the first release tag. Until they exist, point `cli-path` at a CLI you build in the job.
:::

## Permissions

The Action uses exactly these, and nothing else:

| Permission | For |
|---|---|
| `contents: read` | checking out your code |
| `pull-requests: write` | creating and editing its one PR comment |
| `checks: write` | the status check |

Without `pull-requests: write` or `checks: write`, the Action still runs and writes the job summary; it warns that it couldn't post the comment or the check.

## Mode: `replay-only` by default

A PR check should be a verdict on **what is committed**: the tests and their recordings. So the default mode is `replay-only`:

- **Deterministic and free:** no AI, no key, no cost. A PR from a fork (which gets no secrets) runs exactly like one from a branch.
- **Nothing learned is thrown away:** the Action never commits, so anything CI recorded or healed would be lost at the end of the job and paid for again on the next push.
- **Strict:** a step that no longer matches its recording, a test without a recording, or a check that was never compiled **fails** with its reason. Record and heal locally (`%cli% run`, then `%cli% heal --accept`), and commit the recordings.

Choose `mode: normal` to have CI heal with your AI key (spend capped by `budget`). Heals are **suggestions, never commits**: the comment lists them under "Fixes to review" with the command to accept them, and a healed test still fails the check unless the heal policy is `auto`.

## The status check

| Run | Conclusion |
|---|---|
| everything passed | success |
| any failed test | failure |
| any flaky test (failed, then passed on a retry) | failure |
| healed, heal policy `review` or `strict` (fixes wait for review) | failure |
| healed, heal policy `auto` | success |
| blocked tests (or a blocked run, or no tests) and no failures | **neutral**, with the reason |
| the run crashed and wrote no results | failure |

The job itself fails only when the check does. Branch protection treats a neutral check as passing: a blocked test never blocks a merge, and never hides as a pass either (the comment says what couldn't run and why).

## Inputs

| Input | Default | What it does |
|---|---|---|
| `version` | latest | CLI version to install from npm |
| `cli-path` | | Use a local CLI build instead (the CLI package folder or its `bin/cli.js`) |
| `working-directory` | `.` | The project folder |
| `tests` | every test | Test files or folders, space-separated |
| `tag` | | Only tests with these tags (comma- or space-separated) |
| `env` | the project's `defaultEnvironment` | Environment to run against |
| `base-url` | the deployment URL on `deployment_status`, else the environment's `baseUrl` | Where to run |
| `shard` | | `i/n`: run only this slice (see [Sharding](./sharding.md)) |
| `merge` | | Merge downloaded shard results instead of running tests |
| `retries` | `run.retries` | Extra attempts after a failure |
| `budget` | `run.budget.maxPerRunUsd` | AI budget in dollars (mode `normal`) |
| `mode` | `replay-only` | `replay-only`, `normal` or `rerecord` |
| `comment` | `on` | `off`: job summary only |
| `check` | `on` | `off`: no status check |
| `check-name` | `%Name%` | The check's name; each name gets its own comment |
| `upload-artifacts` | `on` | `off`: upload nothing |
| `artifact-prefix` | `%cli%` | Prefix for artifact names; use one per job when several jobs run the Action |
| `github-token` | `github.token` | Token for the comment and the check |
| `node-version` | `24` | Node.js for the CLI |

## Outputs

`run-dir`, `exit-code` (0 passed, 1 failed, 2 blocked or config error), `conclusion` (`success`, `failure` or `neutral`), `junit` (a path), and the counts `tests`, `passed`, `healed`, `failed`, `flaky`, `blocked`.

## Triggers

**`pull_request`**, as above. **Never `pull_request_target` for running tests**: see [Pull requests from forks](./forks.md). For preview deploys (`deployment_status`) see [Preview deploys](./previews.md).

## What the Action sends

Only to GitHub's API (`GITHUB_API_URL`), with the workflow's own token: it finds the pull request for the commit, reads the pull request's changed files (to flag changed `Expect:` lines), lists and creates or edits its one comment, and creates the check run. The job summary is written to the runner's summary file, and artifacts are uploaded with GitHub's own `upload-artifact` action. Its network code is one file, pinned to that host, and never follows redirects. The comment and summary are built from the run's scrubbed results only, so they can't carry a secret. Everything else (your app, your AI provider in mode `normal`) is what the CLI does in any run: see [What data goes where](../security/data.md).
