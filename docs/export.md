# Playwright export

Every recorded website test also exists as a plain `@playwright/test` spec, generated from the same recording and committed next to it. It runs with `npx playwright test`, with **no %Name% installed**. %Name%'s own runs replay the recording through the safe harness; the spec is the portable copy you own.

```sh
%cli% generate                          # every recorded test
%cli% generate tests/checkout.test.md --force
%cli% generate --check                  # CI: exit 1 if a spec is stale or edited by hand
npx playwright test -c tests/%dataDir%     # run them, %Name% or not
%cli% export --out ../my-playwright     # a standalone Playwright project
```

## What is generated

In `<tests dir>/%dataDir%/`, next to the recordings:

| File | What |
|---|---|
| `<test id>.spec.ts` | one per recorded test |
| `%cli%.fixtures.ts` | the helpers the specs use, with the environment's base URL, allowed domains, secret domains and vars as defaults |
| `%cli%.reporter.ts` | scrubs secrets out of every kept trace after each test |
| `%cli%.teardown.ts` | scrubs every trace again after the run |
| `playwright.config.ts` | Chromium, Firefox and WebKit projects, the base URL, trace and video on failure, the scrubbing reporter and teardown, the harness's timeouts, service workers blocked, downloads off |

Every file starts with a header: where it came from, the recording it was built from, "safe to edit", and a content hash. The fixtures import only `@playwright/test` and Node's built-ins.

A generated spec:

```ts
import { allowed, expect, test } from "./%cli%.fixtures";

test.beforeEach(async ({ page }) => {
  // setup: POST /__test/seed
  const seed = await page.request.post(allowed("/__test/seed"), { maxRedirects: 0 });
  await expect(seed, "setup: POST /__test/seed").toBeOK();
});

test("A new project is saved", { tag: ["@smoke", "@projects"] }, async ({ page, secrets }) => {
  // Start: /login
  await page.goto("/login");

  const loginParams = { email: "ada@example.com" };
  // 1. Use: flows/login.test.md
  await test.step("Log in (flows/login.test.md)", async () => {
    // 2. Fill "Email" with {{params.email}}
    await test.step('Fill "Email" with {{params.email}}', async () => {
      // 2 fallback locators recorded: %Name% can heal this.
      await page.getByRole("textbox", { name: "Email", exact: true }).fill(loginParams.email);
    });

    // 3. Fill "Password" with {{params.password}}
    await test.step('Fill "Password" with {{params.password}}', async () => {
      await secrets.fill(page.getByLabel("Password", { exact: true }), "SHOP_PASSWORD");
    });
    // …
  });

  // 3. Expect: a dialog titled "New project" is open
  await test.step('Expect: a dialog titled "New project" is open', async () => {
    await expect(page.getByRole("dialog", { name: "New project", exact: true })).toBeVisible();
  });
  // …
});
```

- One `test.step` per English step, named after it, with the line as written as a comment above it. An included flow becomes a named step group.
- Tags become Playwright tags; `Never:` guards become annotations; `timeout:` becomes `test.setTimeout`.
- `setup` request hooks run in `test.beforeEach` through `page.request`, allowlist-checked and never following redirects; `run` and `sql` hooks skip the test with the reason.
- Locators are the recording's primary ones: role, label and test-id first. Fallbacks and fingerprints are not emitted (healing is %Name%'s job); a comment gives their count.
- **Waits are learned, never fixed:** after a command whose next thing is another action, what the recording saw happen becomes a web-first wait (`toHaveURL`, or `toBeVisible` on the element that appeared). Nothing ever emits `waitForTimeout`.
- **Checks become assertions:** text → `toHaveText` / `toContainText` (fields: `toHaveValue`), URL → `toHaveURL`, states → `toBeVisible`, `toBeChecked`…, counts → `toHaveCount`, network → a response since the step began. `Soft:` lines use `expect.soft`. Model-judged and pending checks become an annotation that never passes or fails the spec.
- **Values:** data and params are declared once per test; `unique` and `faker` values are fresh on every run; `{{env.X}}` reads `%ENV%VAR_X`; secrets are read from the environment variable of the same name when typing, never written in the code, and typed only into a field on an allowed host and one of the secret's domains; inbox values are read from Mailpit (`%ENV%MAILPIT_URL`).
- A test with `auth: <profile>` logs in with the profile's flow first (every time: the spec has no saved sessions). A step never recorded skips the test there, telling you how to record it.

At run time, `%ENV%BASE_URL`, `%ENV%ALLOWED_DOMAINS` (comma-separated), `%ENV%VAR_<NAME>`, `%ENV%MAILPIT_URL` and each secret by its own name override the baked-in defaults.

## Secrets in traces and video

Playwright's own trace records what a test types, request bodies and field values. So the generated reporter rewrites every kept trace after each test: each declared secret's value, read from the environment, is replaced with `[secret:NAME]` in every entry, as typed, JSON-escaped, URL-encoded and base64 (including base64 that decodes to text containing it, like a basic-auth header). The rewritten file is read back and checked. **A trace that can't be rewritten, or still contains a secret, is deleted** with a warning, and so is every trace when a secret is shorter than 4 characters. An unscrubbed trace is never kept.

`--reporter` on the Playwright command line replaces the config's reporters, so the generated global teardown scrubs every trace again after the run. A reporter that copies traces before the run ends (such as `blob`) could copy one before that pass. `secrets.fill` also masks the field on screen (as the harness does), so video and screenshots don't show the value; older Firefox versions ignore the mask.

## Editing policy

The specs are yours: edit them freely. Regeneration never overwrites a file changed by hand: if a file no longer matches its header's hash (or has no header), `generate` leaves it alone, lists it and exits 1; `--force` replaces it. `--check` writes nothing and exits 1 when a spec is out of date or edited. Output is deterministic: the same recording and test always give the same bytes, formatted like Biome's defaults.

If your repository already has a Playwright config, `doctor` tells you whether it would also pick up the generated specs, and how to exclude them.

## Standalone export

```sh
%cli% export --out ../shop-playwright
cd ../shop-playwright
npm install && npx playwright install chromium
cp .env.example .env    # fill in the secret values
npx playwright test
```

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
    %cli%.fixtures.ts allowed domains, secrets, values, network and inbox helpers
    %cli%.reporter.ts scrubs secrets out of kept traces
    %cli%.teardown.ts scrubs them again after the run
```

No `%scope%/*` package, no secret value and no %Name% runtime: the engine's tests check all three on every build. Tests that were never recorded are listed in the README and left out.

## Portable vs %Name%-only

| | Plain Playwright (the spec) | %Name% |
|---|---|---|
| Actions, checks, learned waits | yes | yes |
| Allowed domains | route layer (requests, sockets, main frame) | route layer + refusing proxy + main-frame check (catches redirects) |
| Secrets | from environment variables, domain-checked, masked, scrubbed from kept traces | from the keychain or `.env`, domain-checked, kept out of traces and evidence |
| Healing | no: a changed page fails | yes |
| Model-judged checks, `Never:` guards, pending checks | noted only | evaluated |
| Auth profiles | logs in with the flow each time | saved sessions, reused |
| `run`/`sql` hooks | skip, with the reason | not yet either |
| Verdicts, failure causes, flaky detection | Playwright's pass/fail | yes |

Android tests will export to Maestro flows.
