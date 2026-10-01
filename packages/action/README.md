# Optestra GitHub Action

Runs your plain-English tests on every pull request, **in your own runner, with
your own keys**. Nothing is sent to us. You get:

- **One PR comment, updated in place** on every push (never a new one per push):
  a status table (passed / healed / failed / flaky / blocked), each failure's
  headline with a link to its screenshot, fixes to review, AI calls and cost,
  AI use per test over time, and a link to the full report. Short by default,
  details collapsed, always under GitHub's size limit.
- **A status check.** Real failures fail it. **Blocked is neutral**: a test that
  couldn't run (missing secret, app unreachable, …) is never shown as passed or failed.
- **Artifacts**: the HTML report with videos, traces and screenshots; the first
  five failure screenshots also as single files, linked straight from the comment.
- **The same summary in the job summary**, and JUnit XML for other tools.

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
      # …start your app, or test a deployed preview (below)…
      - uses: optestra/optestra/packages/action@v1
        with:
          version: 0.4.2
        env:
          # Only what your tests declare under `secrets:` (and an AI key if mode is normal).
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
```

## Permissions

The Action uses exactly these, and nothing else:

| Permission | For |
|---|---|
| `contents: read` | checking out your code |
| `pull-requests: write` | creating and editing its one PR comment |
| `checks: write` | the status check |

Without `pull-requests: write` or `checks: write` the Action still runs and writes
the job summary; it warns that it couldn't post the comment or the check.

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
| `shard` | | `i/n`: run only this slice (see Sharding) |
| `merge` | | Merge downloaded shard results instead of running tests |
| `retries` | `run.retries` | Extra attempts after a failure |
| `budget` | `run.budget.maxPerRunUsd` | AI budget in dollars (mode `normal`) |
| `mode` | `replay-only` | `replay-only`, `normal` or `rerecord` (see below) |
| `comment` | `on` | `off`: job summary only |
| `check` | `on` | `off`: no status check |
| `check-name` | `Optestra` | The check's name; each name gets its own comment |
| `upload-artifacts` | `on` | `off`: upload nothing |
| `artifact-prefix` | `optestra` | Prefix for artifact names; use one per job when several jobs run the Action |
| `github-token` | `github.token` | Token for the comment and the check |
| `node-version` | `24` | Node.js for the CLI |

## Outputs

`run-dir`, `exit-code` (0 passed, 1 failed, 2 blocked or config error),
`conclusion` (`success` / `failure` / `neutral`), `junit` (path), and the counts
`tests`, `passed`, `healed`, `failed`, `flaky`, `blocked`.

## Mode: `replay-only` by default

A PR check should be a verdict on **what is committed**: the tests and their
recordings. So the default is `replay-only`:

- **Deterministic and free**: no AI, no key, no cost. A PR from a fork (which gets
  no secrets) runs exactly like one from a branch.
- **Nothing learned is thrown away**: the Action never commits, so anything CI
  recorded or healed would be lost at the end of the job, and paid for again on
  the next push.
- **Strict**: a step that no longer matches its recording, a test without a
  recording, or a check that was never compiled **fails** with its reason. Record
  and heal locally (`optestra run`, then `optestra heal --accept`), and commit
  the recordings.

Choose `mode: normal` to have CI heal with your AI key (spend capped by `budget`).
Heals are **suggestions, never commits**: the comment lists them under "Fixes to
review" with the command to accept them, and a healed test still fails the check
unless the heal policy is `auto`.

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

The job itself fails only when the check does. Branch protection treats a
neutral check as passing: a blocked test never blocks a merge, and never hides
as a pass either (the comment says what couldn't run and why).

## Triggers

### Pull requests

`pull_request` (above). **Never `pull_request_target` for running tests**: it runs
with your repository's secrets and a write token, and a workflow that checks out
and runs the PR's code there hands both to anyone who opens a PR from a fork.

### Preview deploys (Vercel, Netlify)

They report a `deployment_status`. Run on the successful ones; the Action takes
the preview URL from the event and finds the PR by its commit:

```yaml
on:
  deployment_status:

jobs:
  e2e:
    # Only once the preview is live (also skips pending/failure/error statuses).
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.deployment.sha }}
      - uses: optestra/optestra/packages/action@v1
        with:
          env: preview   # an environment whose allowedDomains include the preview host
        env:
          VERCEL_BYPASS: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

The base URL comes from `environment_url`. If the environment sets
`allowedDomains`, include the preview's host (e.g. `*.vercel.app`); if it
doesn't, the allowlist is the preview's host.

## Protected previews

Deployment protection, Cloudflare Access, basic auth or a custom header: the
environment names the secrets, and each header is sent **only to allowed hosts
in its secret's `domains`**, never anywhere else. Values never appear in
evidence.

```yaml
# optestra.config.yaml
secrets:
  VERCEL_BYPASS:
    domains: ["*.vercel.app"]
environments:
  preview:
    baseUrl: https://example.vercel.app   # replaced by the deployment URL in CI
    allowedDomains: ["*.vercel.app"]
    protection:
      vercelBypass: VERCEL_BYPASS                      # x-vercel-protection-bypass
      # cloudflareAccess: { clientId: CF_ID, clientSecret: CF_SECRET }
      # basicAuth: { username: PREVIEW_USER, password: PREVIEW_PASSWORD }  # unless a request sets its own Authorization
      # headers: { X-Preview-Token: PREVIEW_TOKEN }
```

A missing protection secret blocks every test with `missing_secret` (neutral),
instead of failing them all against a login wall.

Note: browsers keep a request's added headers when a server redirects it. A
redirect to a host outside the allowlist is refused before anything is sent; a
redirect to another *allowed* host would carry the header, so keep each secret's
`domains` to the hosts you'd trust with it.

## Pull requests from forks

GitHub gives a `pull_request` run from a fork no secrets and a read-only token.
The Action handles both:

- tests that need a secret are **Blocked (missing secret)**, not failed, and the
  comment says why;
- the comment and check can't be posted with a read-only token: the Action warns
  and the results are in the job summary.

To test a fork's change with secrets, a maintainer pushes it to a branch in the
repository. Don't work around this with `pull_request_target` (see Triggers).

## Sharding

Split a suite across machines with a matrix, then merge and post once. Each
shard uploads its results; the final job merges them into one run, exactly as if
one machine had run every test, and posts the comment and check.

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: optestra/optestra/packages/action@v1
        with:
          shard: ${{ matrix.shard }}/4

  e2e-report:
    needs: e2e
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v8
        with:
          pattern: optestra-run-*
          path: shards
      - uses: optestra/optestra/packages/action@v1
        with:
          merge: shards
```

Tests are split by id (sorted, dealt out in turn): every machine computes the
same slices, they never overlap, and their sizes differ by at most one.
Locally: `optestra run --shard 2/4` and `optestra merge-runs <folders…> --out <dir>`.

## Other CI systems

GitLab CI, CircleCI, Bitbucket Pipelines and plain Docker: see
[docs/recipes.md](docs/recipes.md).
