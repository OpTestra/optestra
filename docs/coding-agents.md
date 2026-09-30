# Coding agents

Coding agents (Claude Code, Cursor, Codex and others) can write features and check them with %Name%: run the tests, read machine-readable results, and propose fixes for a human to review.

## The MCP server

`%cli% mcp` serves the project in the current folder to any MCP client, over stdio. It opens no port and makes no requests of its own. For Claude Code, from the project folder:

```sh
claude mcp add %cli% -- npx %cli% mcp
```

| Tool | Does |
|---|---|
| `list_tests`, `get_test` | The tests, and one test's text, steps and lint findings. |
| `run_tests` | Runs tests; returns the JSON results summary (verdicts, causes, failing checks and steps, files). |
| `get_results` | A finished run's summary and each test's evidence files. |
| `explain` | Why tests failed, citing the run's evidence ([Explain a failure](./runs/explain.md)). |
| `draft_test`, `save_test` | Draft a test from a sentence ([Describe a test](./writing/describe.md)); save a **new** lint-clean file. |
| `list_heals`, `accept_heal` | Review and accept heals; a heal never changes a check. |

No tool edits an existing test or an `Expect:` line. Resources: `%cli%://docs/test-format` (the file format) and `%cli%://docs/agents` (the rules below).

## Instructions for your agent

`%cli% init` offers to append a ready-made snippet to your `AGENTS.md` or `CLAUDE.md` (asked first; `--agents` to do it without asking). The same text is a Claude Code skill in the repository's `integrations/claude-code/skills/%cli%/`.

## The CLI for agents

Every command an agent needs has a machine-readable form:

```sh
%cli% list --json                      # the runnable tests, with step and problem counts
%cli% lint --json                      # problems in test files, with exact fixes
%cli% run --replay-only                # exit 0 passed, 1 failed, 2 blocked
%cli% results <runDir> --json          # what happened and why, per test
%cli% checks tests/checkout.test.md --json   # what each Expect line checks
%cli% explain --json                   # why tests failed, citing the evidence
%cli% heal --json                      # the fixes waiting for review
%cli% doctor --json                    # is the setup ready; every problem with its fix
```

`%cli% results --json` is the one to read after a run. Per test it gives the verdict, the failure cause, the headline, the file, the **failing check** (with expected and actual), the **failing step**, the blocked reason, heals and AI use. The full shape is in the [JSON results reference](./reference/results-json.md).

## Rules for agents

The snippet says the same; in short:

1. **Never edit an `Expect:` line to make a test pass.** An expectation says what the app must do; if it fails, the app (or the test's steps) is wrong. Ask a human before changing what a test expects.
2. Run with `--replay-only` to check a change: it never spends AI and fails on anything that doesn't match the recording.
3. Read `failingCheck` and `headline` in the JSON results: they say what was expected and what the app did.
4. **Blocked is not failed.** A blocked test couldn't run (a missing secret, the app unreachable, …): fix the setup (`%cli% doctor`), not the test.
5. A heal is a proposal. Show it to a human (`%cli% heal`); accepting it (`--accept`) changes the recording, which is committed like code.

## The guard against gaming tests

When a pull request adds, removes or changes an `Expect:` line in a test file, the [GitHub Action's](./ci/github-action.md) comment says so first, so a human sees it. Heals can't change a check at all: the heal format has no way to express a change to an expectation, and the engine refuses one.
