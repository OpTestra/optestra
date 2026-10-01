# Recordings

A recording is what the first run learned: for every step, the exact commands, and for every `Expect:` line, its check. Later runs replay it with no AI.

It lives next to the test, in `<tests dir>/%dataDir%/<test id>.steps.json` (for example `tests/%dataDir%/tests__login.steps.json`), and **is committed with your code**: `init` adds the `.gitignore` lines that keep it. Only the authoring reports (`%dataDir%/authoring/`) stay local.

Recordings store **commands, never results**: nothing in the file says a step passed. Every run evaluates the checks again.

## What's in it

```jsonc
{
  "recordingVersion": 1,
  "testId": "tests__create-project",
  "testPath": "tests/create-project.test.md",
  "target": "web",
  "recordedWith": { "engineVersion", "epoch", "browser", "device", "environment", "model", "promptVersion" },
  "steps": [{
    "key": "…", "textKey": "…", "route": "/dashboard",
    "text": "Click \"Create project\"",
    "kind": "action",
    "commands": [{
      "action":      { "type": "click", "target": { "kind": "role", "role": "button", "name": "Create project", "exact": true } },
      "fingerprint": { "primary", "fallbacks": [], "role", "name", "tag", "attributes", "anchorText", "framePath", "box" },
      "expectPost":  { "appeared": [{ "role": "dialog", "name": "New project" }] },
      "wait":        { "settledMs", "waitedFor": { "network", "dom", "busy" } }
    }],
    "reasoning": "the New project dialog opened",
    "source": "ai"
  }],
  "checks": [{
    "text": "a dialog titled \"New project\" is open", "soft": false,
    "check": { "type": "element_state", "target": { "kind": "role", "role": "dialog", "name": "New project", "exact": true }, "state": "visible" },
    "generatedBy": "rules",
    "summary": "Checked that the dialog 'New project' is visible",
    "sanity": { "empty": { "result": "failed" }, "before": { "result": "failed" }, "provesNothing": false }
  }]
}
```

- **commands**: each action (`goto click dblclick fill select check uncheck press hover scroll upload back reload waitFor`) with a locator, never a page-specific ref.
- **fingerprint**: what re-finding the element without AI needs: the primary locator, the fallbacks in Playwright's priority order, and the element's role, name, tag, attributes, nearby text, frame path and position.
- **expectPost**: what replay should see after the command (a URL change, elements that appear or go away, requests, a reorder). Some of it must show up again.
- **wait**: how long the page took to settle. Replay waits this long (at least 400 ms, at most 3 s) before a second look.
- **checks**: see [Checks and verdicts](./checks-and-verdicts.md).

The file is written with keys in a fixed order and one field per line, so the same recording always gives the same bytes and a git diff shows only real changes.

## Values are templates

Values in a recording are templates: `{{data.email}}`, `{{params.password}}`, `{{env.PLAN}}` for variables, `{{secret.NAME}}` for secrets, `{{inbox.code}}` for a code from an email. A typed value that equals a variable's value is written as that variable. So one recording works for many test users, and **no secret, generated value or one-time code ever enters it**. Page text the recording keeps (what appeared, the model's short note) is templated the same way.

## Step keys

Each step has a key built from its text (variables by name, not value), the flows it came through, how many identical steps came before it, and the route it started on (the path, with numeric ids, UUIDs and similar segments written `:id`). So:

- inserting, removing or rewording a step changes no other step's key;
- step numbers don't matter;
- editing a step's wording makes it a new step: in normal mode the next run records just that step in place.

Checks are keyed by their line, not the route, so a check is found again whatever page it was written on.

## Re-authoring

Writing a recording keeps what is still valid:

- a step recorded in this run replaces the old one with the same text;
- a step not reached this time (after an earlier failure) keeps its previous recording;
- steps that no longer exist in the test are dropped;
- a compiled check survives a run that doesn't reach it, as long as its line is unchanged.

`%cli% run <file> --rerecord` records every step again.

Upgrading the engine doesn't throw recordings away. Only a change in what a recorded command means bumps the recording epoch; then the keys no longer match and each step is re-planned on the next authoring run.

## The portable copy

The same recording also generates a plain Playwright spec, `tests/%dataDir%/<test id>.spec.ts`: see [Playwright export](../export.md). Replay runs the recording through the safe harness (allowed domains, secrets, evidence, healing); the spec is the copy you own.

## Per-branch recordings

In a GitHub project (a `github.com` remote, or running in the GitHub Action), recordings written on a feature branch don't replace main's: authoring, healing and accepted fixes on `feature/discounts` write to `tests/%dataDir%/branches/feature--discounts/`. Runs on the branch replay the branch's recording of a test when it has one, and main's otherwise. Main's runs, and every other branch's, keep replaying main's until the branch merges.

The branch comes from `%ENV%BRANCH` when set, else the GitHub Action's variables (a pull request's head branch, else the pushed branch), else `.git`'s HEAD (git itself isn't run). With no git, or on the main branch (`main` or `master`), everything is as before.

```yaml
# the project file
recordings:
  branches: auto        # auto (GitHub projects), on (any git project), off
  mainBranch: develop   # not set: main or master
```

After the merge, the branch's recordings are in main's tree, still in its folder. Promote them into place, then commit:

```sh
%cli% recordings branches                       # which branches have recordings waiting
%cli% recordings promote --branch feature/discounts
%cli% recordings promote --dry-run --all
```

In the GitHub Action, a workflow on the merged pull request promotes the head branch (it is detected, so `--branch` isn't needed):

```yaml
on:
  pull_request:
    types: [closed]
jobs:
  promote:
    if: github.event.pull_request.merged
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - run: npm install -g %scope%/cli@0.4.2 && %cli% recordings promote
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A tests && git commit -m "chore: promote recordings" && git push || true
```

A test that only exists on the branch is fine either way: its recording is used from the branch's folder until it is promoted. Recorded network traffic (`--record-network`) isn't per branch yet.
