# Explain a failure

```sh
%cli% explain                              # the latest run: every test that didn't pass
%cli% explain .%dataDir%/runs/<runId> tests/billing.test.md
%cli% explain --ai                         # one AI call writes the diagnosis
%cli% explain --json                       # for a coding agent
```

A short diagnosis built from the run's own evidence, for you or a coding agent. Each sentence cites what it used, as `[E1]`, `[E2]`:

```text
A trial costs nothing today (tests/billing-zero-due.test.md): FAILED · cause: product bug

The check "the page shows "$0.00 due today"" failed [E1]: it expected "$0.00 due today" and the page showed "… $29.00 due today …". The run classed the cause as product bug.

Next:
  - Fix the app: the test did what it says and the app answered wrongly.
  - Don't change the Expect: line to make it pass; it is the specification.

Evidence:
  [E1] check: Expect: the page shows "$0.00 due today" …
  [E2] screenshot: the page after step 3
  [E3] trace: the Playwright trace of the attempt
```

The evidence: the deciding check (expected and actual), the failing step and whether the page reacted as recorded, console errors, failed requests (from the network log), the screenshot and the trace, and the decisions the run made. A blocked test is explained as "couldn't run", with what to fix.

By default no AI is used. With `--ai`, one call (the planner role, never more than one per `explain`) rewrites the diagnosis from the same evidence; an answer that cites evidence that doesn't exist is thrown away for the rules' one. **An explanation never changes a verdict or a cause**: it only reads the run folder. Coding agents get the same through the MCP server's `explain` tool.
