# Coding agents

Coding agents (Claude Code, Cursor, Codex and others) can write features and check them with %Name%: run the tests, read machine-readable results, and propose fixes for a human to review.

::: info In progress
An **MCP server** (list tests, create a test from a description, run tests, get results with evidence, accept a heal) and a ready-made **`AGENTS.md` snippet** are being built. This page will link them when they land. Until then, agents use the CLI below, which already does everything they need.
:::

## The CLI for agents

Every command an agent needs has a machine-readable form:

```sh
%cli% list --json                      # the runnable tests, with step and problem counts
%cli% lint --json                      # problems in test files, with exact fixes
%cli% run --replay-only                # exit 0 passed, 1 failed, 2 blocked
%cli% results <runDir> --json          # what happened and why, per test
%cli% checks tests/checkout.test.md --json   # what each Expect line checks
%cli% heal --json                      # the fixes waiting for review
%cli% doctor --json                    # is the setup ready; every problem with its fix
```

`%cli% results --json` is the one to read after a run. Per test it gives the verdict, the failure cause, the headline, the file, the **failing check** (with expected and actual), the **failing step**, the blocked reason, heals and AI use. The full shape is in the [JSON results reference](./reference/results-json.md).

## Rules for agents

Put these in your agent's instructions until the ready-made snippet lands:

1. **Never edit an `Expect:` line to make a test pass.** An expectation says what the app must do; if it fails, the app (or the test's steps) is wrong. Ask a human before changing what a test expects.
2. Run with `--replay-only` to check a change: it never spends AI and fails on anything that doesn't match the recording.
3. Read `failingCheck` and `headline` in the JSON results: they say what was expected and what the app did.
4. **Blocked is not failed.** A blocked test couldn't run (a missing secret, the app unreachable, …): fix the setup (`%cli% doctor`), not the test.
5. A heal is a proposal. Show it to a human (`%cli% heal`); accepting it (`--accept`) changes the recording, which is committed like code.

## The guard against gaming tests

When a pull request adds, removes or changes an `Expect:` line in a test file, the [GitHub Action's](./ci/github-action.md) comment says so first, so a human sees it. Heals can't change a check at all: the heal format has no way to express a change to an expectation, and the engine refuses one.
