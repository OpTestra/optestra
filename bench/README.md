# Bench

Bench is the engine's evaluation suite (BEN-1). Every engine, model or
decision-layer change is scored against it: false passes, false fails, flakes,
cost, and how often replays heal after cosmetic UI changes (BEN-2). It is the
engine's acceptance test, so every fixture runs with the open engine alone,
fully offline, on loopback.

A **fixture** is a small, realistic app plus:

- **variants**: a `correct` build, **broken** builds with real bugs, a
  **cosmetic** build (same behaviour, different surface), and environment trouble;
- **plain-English tests** (`tests/*.test.md`, application.md 6.4 format);
- a **gold manifest** (`manifest.yaml`): the verdict a correct engine must reach
  for every test × variant, and for failures the step, cause and reason;
- a **reference suite** (hand-written Playwright) proving each variant behaves
  exactly as the manifest says.

The full `testament bench` scorer (models, cost, heal rates over many fixtures)
comes with BEN. Two things are scored against the manifest today: the
reference suite (below) and the engine's own replay, `pnpm bench:replay`.

## Fixtures

| Fixture | What it is |
|---|---|
| [`fixtures/shop`](fixtures/shop/README.md) | Acme Shop: pricing, sign-up with an email code, login, dashboard, iframe card checkout, billing, settings, orders table. Also the built-in demo project (ONB-5). |

## Running the shop

```bash
pnpm install
pnpm --filter @testament/fixture-shop start -- --variant cosmetic --port 4100
```

It builds, then serves on `http://127.0.0.1:4100`. `--help` lists the variants.
From code: `startShop({ variant, port }) → { url, stop }` (port `0` picks a free
one). The seeded user is `ada@example.com` / `shop-demo-pass`
(`POST /__test/seed` creates it).

## Variants (shop)

| Variant | What changes |
|---|---|
| `correct` | Nothing. Every test passes. |
| `cosmetic` | Renamed classes, ids and test ids, reordered DOM, moved buttons, restyled layout, reworded labels. Behaviour identical. Full list in the [shop README](fixtures/shop/README.md#cosmetic-change-list). |
| `broken-signup` | A valid sign-up returns a 500 "Something went wrong" page (validation still works). |
| `broken-total` | Billing shows "$29.00 due today" during a trial. |
| `broken-login-redirect` | Login lands on an error page, no session. Tests that `Use:` the login flow **fail** at the `Use:` step (one product bug, one failure group), never blocked. |
| `broken-silent-click` | False-pass trap: "Create project" looks clickable but does nothing. |
| `broken-not-saved` | False-pass trap: the toast says "Project created", the list shows it, a reload shows it's gone. |
| `env-flaky` | The projects API returns 503 on every 2nd request, once per environment reset: the create fails, the retry passes (**flaky**, cause `environment`). |

## Reference suite

```bash
pnpm bench:fixtures:install   # once: Chromium only
pnpm bench:fixtures:test      # every fixture, every variant
```

The shop starts one server per variant (ports 4300–4309, override with
`SHOP_BASE_PORT`) and runs:

- **semantic** (`e2e/semantic.spec.ts`): one test per `.test.md`, roles, labels
  and text only. Its step titles and setup are read from the `.test.md` file,
  and a pass only counts if every numbered step was run. Its verdicts (including
  the failing step) must match the manifest exactly.
- **brittle** (`e2e/brittle.spec.ts`): CSS classes, ids and test ids. It must
  pass on `correct` and fail on `cosmetic`.

A custom reporter prints a table per variant and fails the run on any
mismatch, even though broken variants make individual tests fail. Results are
written to `playwright-report/verdicts.json`. CI runs this as the separate
`fixtures` job; `pnpm check` stays browser-free, but checks the manifest schema,
its consistency with the `.test.md` files, and the server's behaviour per
variant over plain HTTP.

## Replay scoring (`pnpm bench:replay`, LOOP-4)

```bash
pnpm bench:replay                                   # every variant + equivalence
node packages/core/bench/replay.ts --variant cosmetic --json out.json
```

Runs the engine's `run` on every shop variant from the **committed recordings**
(a private copy of the project, so nothing in the fixture changes), with the
manifest's harness (reset before each attempt, one retry), and scores each test
by **verdict and cause**:

- every variant runs `--replay-only` (no AI at all) except `cosmetic`, which runs
  in normal mode with no AI model: heals without AI are expected there, and
  `healed` counts as `passed` (`also_accept`). A miss that only an AI heal could
  fix counts as **needs AI** (reported, not wrong);
- tests that read an email (`checkout-trial`, `signup-email-code`) are
  **deferred** (blocked `inbox_unavailable`) until AUTH-1 wires inboxes into runs;
- `correct` must use zero AI calls;
- `--equivalence`: for `correct`, `broken-total` and `broken-silent-click`, the
  replay verdict (first attempt) and the generated spec's plain-Playwright verdict
  must agree per test.

Any wrong verdict or cause, any disagreement, or AI on `correct` exits 1. The
failing step is reported but not scored: replay may see a failure one step
earlier than the manifest (VER-5 catches the silent click on the click itself).
CI runs it in the `fixtures` job.

## Manifest format

```yaml
version: 1
fixture: shop
tests_dir: tests
harness:                # how a runner must drive the fixture
  retries: 1
  before_first_attempt: POST /__test/reset?environment=1, then the test's `setup:` requests
  before_retry: POST /__test/reset, then the test's `setup:` requests
  secrets: { SHOP_PASSWORD: shop-demo-pass }
variants:
  cosmetic:
    also_accept: { passed: [healed] }   # healing counts as passing here
tests:
  create-project:                        # = tests/create-project.test.md
    correct: passed                      # shorthand for { verdict: passed }
    broken-not-saved:
      verdict: failed                    # passed | failed | flaky | blocked
      step: 9                            # step number in the .test.md
      cause: product_bug                 # product_bug | test_drift | environment | test_data | blocked (DIA-1)
      reason: The toast says "Project created" ..., but after a reload it is gone.
```

- `flaky` = failed on the first attempt and passed on the retry; `step` is where
  the first attempt failed.
- `blocked` = the test couldn't run at all (missing secret, disallowed domain,
  app down, …); `cause` is `blocked`. A failing `Use:` flow (a broken login) is
  **not** blocked: the test is `failed` at the `Use:` step with the flow's cause,
  so a broken login fails CI instead of turning it neutral.
- Every test × variant must be answered (checked in `pnpm check`).

## Adding a fixture

1. Create `bench/fixtures/<name>` as a private workspace package with a
   `test:reference` script. It must bind to 127.0.0.1 and make no outbound calls.
   If its server needs `node:http`, add one narrow entry for that file to
   `NETWORK_EXCEPTIONS` in `test/guards.test.ts`.
2. Put one codebase with variant switches in it: `correct`, `cosmetic`, at least
   one broken build and at least one false-pass trap (the UI claims success but
   the thing didn't happen). No randomness: same variant + same requests = same
   pages. Provide `/__test/` hooks for reset and seed.
3. Write `tests/*.test.md` and a `manifest.yaml` answering every test × variant.
4. Write the reference suite and make `bench:fixtures:test` green.
