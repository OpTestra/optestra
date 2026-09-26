# What happens if Testament disappears

*Draft for the docs page (EXP-3).*

Nothing breaks. Your tests keep running.

Every website test you record with Testament also exists as a plain Playwright
spec, generated next to the test in `tests/.testament/`. Those files use only
`@playwright/test` and two helper files in the same folder. They don't import
Testament, call Testament's servers, or need an account, a key or a licence.

## Run them without Testament

```bash
npm install -D @playwright/test
npx playwright install
SHOP_PASSWORD=… npx playwright test -c tests/.testament
```

- The config in that folder runs the specs in Chromium, Firefox and WebKit
  against the base URL they were generated for. `TESTAMENT_BASE_URL` points
  them somewhere else.
- Secrets are read from environment variables named after them. They are never
  written into the files.
- Your allowed domains still apply: requests to other hosts are blocked by
  Playwright's own routing.

## What you keep, and what you lose

You keep every step, check and wait: the same clicks, the same assertions,
readable code with the English step above each block.

You lose what Testament adds on top:

- self-healing when the page changes (a changed button now fails the test);
- model-judged checks and `Never:` rules (they appear as notes);
- verdicts, failure causes and flaky-test detection;
- Testament's secret vault and scrubbed evidence.

## Owning the code

The specs are yours to edit. Testament never overwrites a file you changed. If
you stop using Testament, commit the folder and carry on with Playwright.

For a standalone project with its own `package.json`, use **Export**
(`testament export`).
