# Playwright and Maestro export

Every recorded website test also exists as a plain `@playwright/test` spec (Android tests as a [Maestro flow](#android-maestro-flows)), generated from the same recording and committed next to it. It runs with `npx playwright test`, with **no %Name% installed**. %Name%'s own runs replay the recording through the safe harness; the spec is the portable copy you own.

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

### Page objects

```sh
%cli% export --out ../shop-playwright --page-objects
```

Off by default. With it, the export groups what repeats:

- **A class per page,** in `tests/pages/<page>.page.ts`: every element the tests use on that page (by the route the recording saw) becomes a getter, so a renamed button is fixed in one place.

  ```ts
  export class SettingsPage {
    constructor(readonly page: Page) {}

    /** button "Save changes" */
    get saveChangesButton() {
      return this.page.getByRole("button", { name: "Save changes", exact: true });
    }
  }
  ```

- **A helper per flow,** in `tests/flows/<flow>.flow.ts`: a `Use:` flow, or an `auth:` profile's login, becomes one async function that every test using it calls, with its params.

  ```ts
  test("Profile changes are saved", async ({ page, secrets }) => {
    const settingsPage = new SettingsPage(page);

    const loginParams = { email: "ada@example.com" };
    await test.step("auth: ada (tests/flows/login.test.md)", async () => {
      await logIn({ page, secrets }, loginParams);
    });
    // …
    await settingsPage.saveChangesButton.click();
  });
  ```

  When a flow's code comes out differently in two tests (it was recorded differently, or one test gives a secret for a param), each variant gets its own helper (`logIn`, `logIn2`), so nothing changes what a test does.

The specs run exactly as without page objects: the engine's tests run the exported suite with plain `npx playwright test` both ways.

## Portable vs %Name%-only

| | Plain Playwright (the spec) | %Name% |
|---|---|---|
| Actions, checks, learned waits | yes | yes |
| Allowed domains | route layer (requests, sockets, main frame) | route layer + refusing proxy + main-frame check (catches redirects) |
| Secrets | from environment variables, domain-checked, masked, scrubbed from kept traces | from the keychain or `.env`, domain-checked, kept out of traces and evidence |
| Healing | no: a changed page fails | yes |
| Model-judged checks, `Never:` guards, pending checks | noted only | evaluated |
| Auth profiles | logs in with the flow each time | saved sessions, reused |
| `run`/`sql` hooks | skip, with the reason | yes |
| `Mock:` steps | yes (`mock()` in the fixtures) | yes |
| Recorded network traffic, accessibility warnings, muting | no | yes |
| Verdicts, failure causes, flaky detection | Playwright's pass/fail | yes |

## Android: Maestro flows

An Android test's portable copy is a [Maestro](https://maestro.dev) flow, generated from the same recording and committed next to it as `<tests dir>/%dataDir%/<test id>.maestro.yaml`. It runs with the Maestro CLI alone, on any device or emulator with the app installed, with **no %Name% installed**. `%cli% generate`, `generate --check`, the header, the content hash and the editing policy are the same as for specs.

```sh
%cli% generate                          # the flows, next to the recordings
%cli% export --out ../shop-maestro      # a standalone Maestro workspace
cd ../shop-maestro
adb install app-release.apk
maestro test . -e SHOP_PASSWORD=…       # every flow
```

A generated flow (the fixture's `create-project` test, shortened):

```yaml
# Run: maestro test tests__create-project.maestro.yaml -e SHOP_PASSWORD=…
# Secrets are read from Maestro env vars (SHOP_PASSWORD); no value is in this file.
appId: com.acme.shop
name: "A new project is saved"
env:
  %ENV%BASE_URL: "http://127.0.0.1:4180"
---
# setup: POST /__test/seed
- evalScript: "${output.setup1 = http.post(%ENV%BASE_URL + \"/__test/seed\", { … }).status}"
- assertTrue: "${output.setup1 >= 200 && output.setup1 < 300}"

- launchApp:
    clearState: true
    permissions:
      all: unset

# 1. Use: flows/sign-in.test.md

# 2. Type {{params.password}} into "Password"
- tapOn:
    id: "com.acme.shop:id/sign_in_password"
- eraseText
- inputText: "${SHOP_PASSWORD}"

# 4. Tap "Create project"
- tapOn:
    id: "com.acme.shop:id/create_project_button"
- extendedWaitUntil:
    notVisible:
      id: "com.acme.shop:id/create_project_button"
    timeout: 10000

# 5. Expect: a message says "Project created"
# Checked by %Name% only: the message is a toast, and Maestro can't see toasts.

# 6. Expect: the list shows "Q3 roadmap"
- assertVisible:
    text: ".*Q3 roadmap.*"
```

- One flow per test, flows (`Use:`) inlined, each English step as a comment above its commands.
- It starts like a %Name% session: the app's data cleared and Android's permission prompts real (`permissions: all: unset`). `setup:` requests run first, from your machine, through Maestro's `http` script API.
- Elements are found by their resource id when the recording has one (Android's generic `android:id/…` ids excepted), else by their text. A tap that changed the screen waits until the tapped element has gone, as the replay checks each action's effect: a tap that does nothing fails there.
- Taps, typing (a fill clears the field first), long presses, swipes, scrolling to an element, back, home, deep links (`openLink`) and permission prompts (the system dialog's own buttons) all map to Maestro commands.
- Checks become `assertVisible` / `assertNotVisible` on the element or its text (enabled, checked and focused too); `Soft:` checks are `optional`.
- **Values:** data becomes `${DATA_X}` and `{{env.X}}` `${%ENV%VAR_X}`, with the test's values as defaults in the flow's `env:`; secrets are `${NAME}` with no default, passed with `-e NAME=…`. No secret value is ever in a flow.

What Maestro can't do faithfully is left out with a comment, never approximated, and listed in the export's README: toasts, counts, which screen (activity) is open, the app's requests, model-judged checks and `Never:` rules. An action it can't do (a rotation, a value made fresh on every run, an email code) ends the flow there with a comment, since what follows would run on the wrong screen. Maestro also has no roles: a check on "the heading" or "the list" looks for its text on the screen.

```
shop-maestro/
  config.yaml             the workspace: maestro test . runs flows/*
  README.md               how to run, which variables to pass, what only %Name% checks
  flows/
    <test>.maestro.yaml   one per recorded test
```
