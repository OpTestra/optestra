# What happens if Testament disappears

Nothing breaks. Your tests keep running.

Every website test you record with Testament also exists as a plain Playwright
spec, generated next to the test in `tests/.testament/` and committed with your
code. Those files use only `@playwright/test`, Node's built-ins and three helper
files in the same folder. They don't import Testament, call Testament's servers,
or need an account, a key or a licence. The engine that makes them is open
source (MIT).

You can check this today, with Testament still installed: run the specs with
plain Playwright (below), or export them to a folder that has nothing of ours in
it at all.

## Run them without Testament

In your repository:

```bash
npm install -D @playwright/test
npx playwright install chromium
SHOP_PASSWORD=… npx playwright test -c tests/.testament
```

- The config in that folder runs the specs in Chromium, Firefox and WebKit
  against the base URL they were generated for. `TESTAMENT_BASE_URL` points
  them somewhere else, and `TESTAMENT_ALLOWED_DOMAINS` changes the hosts pages
  may reach.
- Secrets are read from environment variables named after them. They are never
  written into the files.
- Your allowed domains still apply: requests to other hosts are blocked by
  Playwright's own routing.

## Export a standalone project

```bash
testament export --out ../shop-playwright
cd ../shop-playwright
npm install && npx playwright install chromium
cp .env.example .env    # fill in the secret values
npx playwright test
```

The export is a complete Playwright project:

```
shop-playwright/
  package.json            only @playwright/test, pinned
  playwright.config.ts    loads .env; runs tests/ in Chromium, Firefox, WebKit
  README.md               how to run, which variables to set, what's portable
  .env.example            the secret NAMES (never values)
  .gitignore
  files/                  files the upload steps use
  tests/
    <test>.spec.ts        one per recorded test
    testament.fixtures.ts allowed domains, secrets, values, network and inbox helpers
    testament.reporter.ts scrubs secrets out of kept traces
    testament.teardown.ts scrubs them again after the run
```

There is no `@testament/*` package in it, no secret value and no Testament
runtime; the engine's tests check all three on every build. Tests that were
never recorded are listed in the README and left out.

## What you keep, and what you lose

You keep every step, check and wait: the same clicks, the same assertions,
readable code with the English step above each block, and the safety rails that
plain Playwright can enforce (allowed domains, secrets typed only into their
domains, masked on screen and scrubbed from kept traces).

You lose what Testament adds on top:

- self-healing when the page changes (a changed button now fails the test);
- model-judged checks and `Never:` rules (they appear as annotations);
- saved logins (`auth:` tests skip, with the reason);
- verdicts, failure causes and flaky-test detection;
- Testament's secret vault and scrubbed evidence.

## Owning the code

The specs are yours to edit. Testament never overwrites a file you changed
(`testament generate` lists it and leaves it alone unless you pass `--force`).
If you stop using Testament, commit the folder, or the export, and carry on with
Playwright.
