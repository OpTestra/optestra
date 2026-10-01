<!-- optestra:agents -->
## End-to-end tests (Optestra)

This project's end-to-end tests are plain-English `.test.md` files in `tests/`, run by Optestra. Each numbered line is a step; `Expect:` lines are the checks.

How to use it:
- List the tests: `optestra list` (MCP: `list_tests`). Read one: `optestra show tests/<file>.test.md` (MCP: `get_test`).
- Run the tests after every change that can affect the app: `optestra run` (all), `optestra run tests/<file>.test.md` (one), `optestra run --tag smoke`. `--replay-only` uses no AI at all (MCP: `run_tests`).
- Read the result: exit code 0 passed, 1 failed or flaky, 2 blocked (the test couldn't run: a missing secret, the app not running). `optestra results <runDir> --json` gives, per test, the `verdict`, the `cause`, the `headline`, the `failingCheck` (the expectation as written, expected and actual), the `failingStep`, the `file` and a screenshot (MCP: `get_results`).
- Ask why a test failed: `optestra explain` (the latest run; or `optestra explain <runDir> <test>`) gives a short diagnosis citing the evidence (the failing check, the step, console errors, failed requests, the screenshot); rules only, `--ai` for one AI call (MCP: `explain`).
- Add a test: `optestra new "a returning user can log in"` drafts one by exploring the app and prints it; review it, then save it with `--accept` (MCP: `draft_test`, then `save_test`). Or write the file yourself: the format is in the `optestra://docs/test-format` MCP resource. `optestra lint` checks it.
- Heals: when the UI changed but the behaviour didn't, a run can heal a step (a new locator) and marks the test healed. Review with `optestra heal`, accept with `optestra heal --accept <id>` (MCP: `list_heals`, `accept_heal`). A heal never changes a check.

Rules:
- Never edit an `Expect:` or `Soft:` line to make a failing test pass. The expectations are the specification: a failing check means the app is wrong, or the requirement changed, and only a human decides which.
- Don't delete, skip, retag or weaken a test or an expectation to get a green run, and don't loosen the quoted text of an expectation.
- Fix the app, not the test. If you think a test is wrong, say so and explain why; leave the expectation to a human.
- Don't edit the recordings in `tests/.optestra/` by hand; `optestra run --rerecord <file>` records a test again.
- Never write a password, token or key into a test; use `{{secret.NAME}}`.
- Changes to `Expect:` lines are flagged for a human in the PR comment.
<!-- /optestra:agents -->
