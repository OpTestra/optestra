# @optestra/codegen

Turns a recording into a plain `@playwright/test` spec that lives next to the
test and runs with `npx playwright test`, with **no Optestra installed**
(REP-1, EXP-1, promise 2: "your tests are Playwright code you own").

Optestra's own replay (LOOP-4) runs the *recording* through the safe browser
harness (allowlist, secrets, evidence, healing). The spec is generated from the
same recording as the portable, human-owned copy. Tests with inline ```ts code
blocks are the exception: LOOP-4 runs those through this spec.

| Import | Use |
|---|---|
| `@optestra/codegen` | `generateSpec(recording, { expanded, specs })`, `generateSupportFiles(environment)`, `readCodegenRecording`, `fileState`, `withHeader` |
| `@optestra/codegen/node` | `generateProject({ projectDir, tests?, environment?, force?, check?, out? })`, `generateAfterRecording(projectDir, testPath)`. `out: { dir, label }` writes elsewhere (the CLI's `export`) |

Node only: the runtime templates in `runtime/` are read from disk.

```bash
optestra generate                      # every recorded test
optestra generate tests/checkout.test.md --force
optestra generate --check              # CI: exit 1 if a spec is stale or edited by hand
npx playwright test -c tests/.optestra # run them, Optestra or not
```

## Android: Maestro flows (MOB-6)

For an Android project (`project.target: android`) `generateProject` writes a
[Maestro](https://maestro.dev) flow per recorded test instead,
`<tests dir>/.optestra/<testId>.maestro.yaml` (`generateMaestroFlow(recording,
{ expanded, baseUrl })`), with the same header (as `#` comments), content hash
and hand-edit rules. The flow runs with the Maestro CLI alone. The CLI's `export`
wraps the flows in a Maestro workspace (`config.yaml`, `README.md`, `flows/`).

- `appId` from the recording's element facts; the flow starts with
  `launchApp: { clearState: true, permissions: { all: unset } }`; `setup:`
  requests first, through Maestro's `http` script API, to `<ENV_PREFIX>BASE_URL`.
- Elements by resource id (not Android's generic `android:id/…`), else by text.
  A tap whose element the recording saw go away waits until it has
  (`extendedWaitUntil: notVisible`), so a silent tap fails at the tap.
- Values: data → `${DATA_X}`, `{{env.X}}` → `${<ENV_PREFIX>VAR_X}` (defaults in
  `env:`), secrets → `${NAME}` (no default, never a value).
- Gaps are comments ("Checked by … only: …") and listed in `FileResult.gaps`:
  toasts, counts, activity (url), network, model-judged checks, `Never:` rules.
  An action with no faithful Maestro command (rotate, a generated or inbox value,
  a code step) ends the flow there.

The goldens are the Android fixture's committed flows
(`bench/fixtures/android/tests/.optestra/*.maestro.yaml`, `src/maestro.test.ts`).

## What is generated

Everything goes to `<tests dir>/.optestra/`, next to the recordings, and is
meant to be committed:

| File | What |
|---|---|
| `<testId>.spec.ts` | One per recorded test. |
| `optestra.fixtures.ts` | The helpers the specs use (below), with the environment's base URL, allowed domains, secret domains and vars baked in as defaults. |
| `optestra.reporter.ts` | Scrubs secrets out of every kept trace after each test (below). |
| `optestra.teardown.ts` | Global teardown: scrubs every trace again after the run, in case `--reporter` replaced the scrubbing reporter. |
| `playwright.config.ts` | `testDir: "."`, base URL, Chromium, Firefox and WebKit projects, trace and video on failure, the scrubbing reporter and teardown, the harness's action (5 s) and navigation (30 s) timeouts, service workers blocked, downloads off. |

Every file starts with a header: where it came from, the recording it was built
from (with a key), "safe to edit", and a content hash.

The generated `create-project` spec (from the goldens in
`fixtures/shop/tests/.optestra/`):

```ts
import { allowed, expect, test } from "./optestra.fixtures";

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
      // 2 fallback locators recorded: Optestra can heal this.
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

### Shape

- One `test.step` per English step, named after it, with the line as written
  (number and prefix included) as a comment above it.
- An inlined flow becomes a named step group, `Log in (flows/login.test.md)`,
  with the flow's steps inside it.
- Tags become Playwright tags (`@smoke`); `Never:` guards become annotations.
- `setup:` request hooks run in `test.beforeEach` through `page.request` (same
  cookies as the page, like the harness), allowlist-checked by `allowed()` and
  never following redirects. `teardown:` hooks go in `test.afterEach`.
  `run`/`sql` hooks give a clear `test.skip` until they are implemented.
- `start:` opens first; `timeout:` becomes `test.setTimeout`.
- A test with `auth: <profile>` logs in first with the profile's flow, from the
  flow's own recording (`tests__flows__login.steps.json`), as one
  `test.step("auth: ada (tests/flows/login.test.md)")` before the start page.
  The runner reuses a saved session; the spec logs in every time. A profile
  whose flow isn't recorded yet makes the test skip, with the reason.
- A step that was never recorded skips the test there, telling you how to
  record it.

### Commands

The locator is the command's primary one, printed the way `@optestra/browser`
resolves it: text-like locators exact unless recorded otherwise, frames via
`contentFrame()` (or `frameLocator` for CSS), `nth` via `.first()` / `.nth(n)`.
Fallbacks and fingerprints are not emitted (healing is Optestra's job); a
comment gives their count.

| Recorded action | Code |
|---|---|
| `goto` | `page.goto(url)` |
| `click` `dblclick` `hover` `check` `uncheck` | `locator.click()` … |
| `fill` | `locator.fill(value)`; a secret: `secrets.fill(locator, "NAME")` |
| `select` | `locator.selectOption(option or [options])` |
| `press` | `locator.press(key)`, or `page.keyboard.press(key)` |
| `scroll` | `locator.scrollIntoViewIfNeeded()`, or `page.mouse.wheel(0, ±pixels)` |
| `upload` | `upload(locator, ["../files/a.png"])` (relative to the test's folder, which must contain them) |
| `back` `reload` | `page.goBack()`, `page.reload()` |
| `waitFor` | `await expect(locator.first()).toBeVisible()` or on `page.getByText(text).first()` |

**Learned waits (LRN-4).** After a command whose next thing is another action,
what the recording saw happen becomes a web-first wait:
`await expect(page).toHaveURL(route("/checkout"))` when the URL changed,
otherwise `toBeVisible()` on the first element that appeared (not toasts or
alerts, which come and go). Before a check no wait is emitted: the assertion
waits by itself, and a failure then shows at the step that checks it. Nothing
ever emits `waitForTimeout`.

### Checks (op → assertion)

| Op | Assertion |
|---|---|
| `text` equals / contains | `toHaveText` / `toContainText`; for fields (label, placeholder, textbox, combobox…) `toHaveValue(v)` / `toHaveValue(/v/)` |
| `url` is / contains / matches | `toHaveURL(v)` / `toHaveURL(/escaped/)` / `toHaveURL(/pattern/)` |
| `element_state` | `toBeVisible` `toBeHidden` `toBeEnabled` `toBeDisabled` `toBeChecked` `not.toBeChecked` `toBeFocused` `toBeEditable` `toBeEmpty` |
| `count` n / min–max | `toHaveCount(n)` / `expectCount(locator, { min, max })` |
| `network` | `network.expectResponse({ method, url, status })`: a matching response since the current action step began |
| `aria_snapshot` | `toMatchAriaSnapshot(\`…\`)` |
| `code` | the code, verbatim, inside its step |
| `pending`, `soft_judgment`, any unknown op | `checkedByOptestra(line, reason)`: an annotation plus a comment; never passes or fails the spec |

`Soft:` checks use `expect.soft` (helpers take `{ soft: true }`). A `scope`
container becomes a chained locator. Recordings are read leniently: an op this
package doesn't know (from a newer LOOP-2) is noted, not an error.

### Values

- **Data and params** are objects declared once per test or flow call, holding
  only the keys the code reads: `const data = { email: values.unique.email() }`,
  `const loginParams = { email: data.email }`. A data value that uses another
  becomes its own constant first.
- **Generated values** (`unique.*`, `faker.*`) are made fresh on every run by
  the `values` fixture (ENV-3). A generator used directly in a step is called
  once at the top of that step.
- **Environment vars** (`{{env.X}}`) read `OPTESTRA_VAR_X`, defaulting to the
  environment's `vars`.
- **Secrets** are never in the code: `secrets.fill(locator, "NAME")` reads the
  `NAME` environment variable when typing, and refuses unless the field's frame
  is on an allowed host and one of the secret's domains (SEC-1, SEC-2). A value
  that mixes a secret with other text can't be typed that way, so the step skips.
- **Inbox values** (`{{inbox.code}}`, `{{inbox.link}}`) read the newest email
  sent to an address the test generated, from Mailpit (`OPTESTRA_MAILPIT_URL`).
  Without it the test skips with the reason.

## The fixtures module

`optestra.fixtures.ts` imports only `@playwright/test` and Node built-ins.

- **`allowlist`** (automatic): a context route aborts every request to a host
  outside the allowed domains, sockets included, and a page that still lands on
  such a host is sent to `about:blank` (SAF-1).
- **`values`**, **`secrets`**, **`network`**, **`inbox`**: see above.
- **Helpers**: `allowed(target)`, `route(pattern)` for `toHaveURL`,
  `containing(text)`, `expectCount`, `upload`, `checkedByOptestra`.
- **Overrides** at run time: `OPTESTRA_BASE_URL`, `OPTESTRA_ALLOWED_DOMAINS`
  (comma-separated), `OPTESTRA_VAR_<NAME>`, `OPTESTRA_MAILPIT_URL`, and each
  secret by its own name.

## Portable vs Optestra-only

| | Plain Playwright (this spec) | Optestra |
|---|---|---|
| Actions, checks, learned waits | yes | yes |
| Allowed domains | route layer (requests, sockets, main frame) | route + refusing proxy + main-frame check (catches redirects) |
| Secrets | from env vars, domain-checked, masked, scrubbed from kept traces | from the keychain/vault, domain-checked, kept out of traces and evidence |
| Healing (fallbacks, fingerprints, AI) | no: a changed page fails | yes |
| Model-judged checks (`soft_judgment`), `Never:` guards, pending checks | noted only | evaluated |
| Auth profiles | logs in with the flow each time | saved sessions, reused (AUTH) |
| `run`/`sql` hooks | skip, with the reason | yes (ADV) |
| Verdicts, failure causes, flaky detection | Playwright's pass/fail | yes |

## Secrets in traces and video

Playwright's own trace records what a test types (call parameters), the page's
request bodies and field values in its DOM snapshots. So the generated
`optestra.reporter.ts` rewrites every kept trace after each test: each
declared secret's value, read from the environment, is replaced with
`[secret:NAME]` in every entry, as typed, JSON-escaped, URL-encoded (`%XX` and
form `+`) and base64, including base64 runs that decode to text containing it
(e.g. a Basic auth header). The rewritten zip is read back and checked; the
file is marked so it is only scrubbed once.

Fail-safe: a trace that can't be rewritten (not a zip, ZIP64, encrypted,
corrupt), or that still contains a secret afterwards, is **deleted** with a
warning. So is every trace when a secret is shorter than 4 characters (too
short to find reliably). An unscrubbed trace is never kept.

`--reporter` on the command line replaces the config's reporters, so
`optestra.teardown.ts` (a `globalTeardown`, which flags can't replace) scrubs
every trace in the output folders again after the run. A reporter that copies
traces before the run ends (e.g. `blob`) could copy one before that pass.

`secrets.fill` also masks the field for as long as it exists, as the harness
does (`-webkit-text-security: disc`, plus a `data-optestra-secret`
attribute), so video and screenshots don't show the value. Password fields are
masked by the browser anyway. Firefox ignores `-webkit-text-security` on
older versions.

## Editing policy

The specs are yours: edit them freely. Regeneration never overwrites a file
changed by hand. Each header carries a hash of the whole file; if the file no
longer matches it (or has no header), `generate` leaves it alone, lists it and
exits 1, and `--force` replaces it. `--check` writes nothing and exits 1 when a
spec is out of date or changed by hand. Output is deterministic: the same
recording and test file always give the same bytes.

The code printer (`src/print/`) is a small Prettier-style printer that follows
Biome's defaults (double quotes, trailing commas, 100 columns), so generated
files are stable under `biome format`. The goldens are checked by the repo's
Biome run; output with unusual shapes may still differ from a formatter.

## Tests

- `src/codegen.test.ts` (in `pnpm check`): goldens for eight shop tests
  (`fixtures/shop/tests/.optestra/*.spec.ts`, plus the fixtures and config),
  byte-identical regeneration, imports, no secret values (a planted one),
  hand-edit detection, `--check`, unknown ops, value handling, and a strict
  `tsc --noEmit` of the output.
- `e2e/plain-playwright.test.ts` (`pnpm bench:fixtures:test`, CI `fixtures`):
  runs the generated specs with plain Playwright from a project whose
  `node_modules` holds only `@playwright/test`, against the shop's `correct`,
  `broken-total` and `broken-silent-click` variants, plus two negative controls
  (allowing the second host, and a secret outside its domains), and a test that
  types the planted secret, fails on purpose and proves the kept trace holds no
  form of it (once through the reporter, once with `--reporter=json` so only
  the teardown scrubs).

The recordings in `fixtures/shop/tests/.optestra/*.steps.json` are
hand-written stand-ins for real LOOP-1 recordings
(`node scripts/fixture-recordings.ts` rewrites them). Update goldens with
`pnpm vitest run packages/codegen -u`.
