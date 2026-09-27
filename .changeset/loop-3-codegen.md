---
"@testament/codegen": minor
"@testament/cli": minor
---

Add generated Playwright specs (LOOP-3). `@testament/codegen` turns a recording
into a plain `@playwright/test` spec next to the test, with one `test.step` per
English step, flows as named step groups, role and label locators, web-first
assertions and learned waits instead of sleeps. A shared fixtures module
enforces the allowed domains through Playwright routing, types secrets from
environment variables only on their domains, and makes fresh values per run.
The output imports nothing from the engine and runs with `npx playwright test`.
Hand-edited files are never overwritten without `--force`. The CLI gains
`generate [tests…] [--force] [--check]`.
