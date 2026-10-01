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

Three things are scored against the manifest: the reference suite (below),
the engine's replay (`optestra bench`, and `pnpm bench:replay` in CI), and AI
models (`optestra bench --models`).

## `optestra bench` (BEN-2)

```bash
node packages/cli/bin/cli.js bench [--fixture shop|android|all] [--reruns 10] [--variant v …] [--no-equivalence] [--save-baseline] [--json]
```

It runs from the engine repository (it needs the fixtures and a build). Every
variant of the chosen fixtures replays from the committed recordings with no AI
(`cosmetic` in normal mode with no model, so heals without AI happen), `correct`
runs `--reruns` times, and the shop's replay verdicts are compared with its
generated specs run as plain Playwright. Android runs when an emulator is
available (`optestra android setup`, APKs built); otherwise it is skipped with
one line saying why. The report starts with how it was measured (engine version
and commit, OS, Node, date, reruns, models, the command that reproduces it) and
shows, per fixture and in total:

| Number | Definition (pinned in `packages/core/src/bench/bench.test.ts`) |
|---|---|
| **False pass rate** (the headline) | tests the manifest says must not pass (failed, flaky, blocked) that passed or healed / those tests. Shown with its counts, never rounded away. |
| False fail rate | tests that must pass that ended failed or blocked / those tests. A cosmetic miss only an AI heal could fix, in a run with no model, is **needs AI**: counted on its own line, in neither rate. |
| Flake rate | over the reruns of `correct`: tests with any `flaky` verdict, or whose verdicts differ between reruns / tests |
| Replay hit rate | on `correct`: action steps done exactly as recorded / action steps that ran; with the AI calls on `correct` over every rerun (must be 0) |
| Cosmetic | steps done without AI (as recorded, or re-found) / steps; tests that passed or healed with no AI and no re-recording / tests; heals without AI |
| Time and cost | replay: median over reruns of `correct`'s summed test times, AI calls and cost of every variant; first run (authoring): from the newest committed model eval (`bench/results/`), else "not measured" |
| Equivalence | shop: replay vs the generated spec's plain-Playwright verdict, per test, on `correct`, `broken-total` and `broken-silent-click` (email tests are left out without Mailpit) |

False pass and fail rates use each variant's first run; reruns only feed the
flake rate and the timing. Every number is compared with the committed
**baseline** (`bench/baseline.json`) and the deltas are printed. Exit 1 when the
engine got worse on false passes, false fails, wrong verdicts, equivalence or AI
calls on `correct` (flake and hit-rate changes are shown, not gated: they're
noisy); 2 when Bench can't run. `--save-baseline` writes the run as the new
baseline (commit it with the change that explains it). The scoring lives in
`@optestra/core/bench`; `pnpm bench:replay` uses the same code.

## Model evals (`optestra bench --models`, MOD-9)

```bash
node packages/cli/bin/cli.js bench --models claude-code:claude-sonnet-5-5 codex:gpt-6-luna openrouter:z-ai/glm-4.6 --yes
node packages/cli/bin/cli.js bench --scripted        # the same pipeline with a stand-in model (CI, no AI)
```

Each `provider:model` entry is used as both planner and fixer, on the shop:

1. **authoring**: the committed recordings are removed and every test is recorded
   by the model (checks compiled rules first, the model only where rules can't);
2. **its recordings replayed with no AI** on every variant but `cosmetic`: the
   model's false passes and false fails (a weak check or a wrong step shows here);
3. **cosmetic in normal mode**, the model as fixer: what it heals that no-AI heals can't.

Reported per model: steps and checks authored, tests passing after authoring,
false passes/fails, fixer heals and cosmetic tests passing, calls (and those via
a subscription), tokens, cost and time. Providers come from the project config
(`anthropic`, `openai`, `google`, `claude-code`, `codex`), plus `openrouter`
(`OPENROUTER_API_KEY`) and `opencode` (`OPENCODE_API_KEY`) as OpenAI-compatible
routers. A per-model budget of $5 applies; subscription calls cost 0 to it.

Real models spend calls: without `--yes` the command prints the estimate (about
60–140 calls per model on the shop) and stops, so a person decides first. Each
model runs once; nothing retries. Real results are written to
`bench/results/<date>-shop-models.json` with the date, engine version, commit and
model ids, to be committed. The newest real result also gives the first-run
(authoring) numbers in `optestra bench`.

## The real-developer corpus (`bench --corpus`, COST-0)

```bash
node packages/cli/bin/cli.js bench --corpus --static                        # lint + phrase rules: free
node packages/cli/bin/cli.js bench --corpus --fixture all                   # the estimate, then stops
node packages/cli/bin/cli.js bench --corpus --fixture all --models claude-code:claude-sonnet-5-5 --yes
```

Every gold test re-phrased the way developers write and speak tests (terse,
ticket prose, acceptance criteria, Given/When/Then, speech-to-text, sloppy,
mixed), with the same expected verdicts. Per style: lint, phrase-rule coverage,
authoring, false passes and fails across the variants, heals, calls and cost.
See [`corpus/README.md`](corpus/README.md).

## Cloud cost runs (`bench --meter`, COST-0)

`bench/cloud/` runs Bench slices as Cloud Run Job tasks (or locally, the same
entry), measures wall, CPU, memory, start-up, evidence and AI per test, and
`bench --meter <run folder>` prices them with `bench/cloud/prices.yaml` into
`results/<date>-cloud-baseline.json` and `.md`. See
[`cloud/README.md`](cloud/README.md) and [`cloud/RUNBOOK.md`](cloud/RUNBOOK.md).

## The eval gate (`optestra eval`, LRN-10)

```bash
node packages/cli/bin/cli.js eval [--backend rules|jev|kev|laya] [--models provider:model …] [--fixture shop] [--no-bench] [--save-baseline]
```

**The gate for changing a default**: a decision backend, a prompt, or the
default planner/fixer model is only switched when `optestra eval` passes. It
runs the decision evals (`decisions --eval`) with the candidate backend and
Bench's false-pass check (every variant once, no AI), and with `--models` the
model eval, then compares with the committed baseline:

- any rise in Bench false passes (or a new one), any task with more false
  labels than the baseline's, or a candidate model with more false passes than
  the reference model (Sonnet 5.5, in the newest committed model eval) fails;
- no baseline is no evidence: it fails too.

Exit 0 passed, 1 failed, 2 couldn't run. It only reports; it never changes a
test result or a default. After an accepted change, `--save-baseline` stores the
decision eval results in `bench/baseline.json`.

## Success measures (`optestra bench --measures`)

Prints application section 10 with real numbers where there are some: the
Bench numbers from the committed baseline (and which one), the time to a first
passing test (`init` and the first run timed now, plus authoring per test from
the newest model eval), decision latency from the decision evals, and the PR
smoke duration as a labelled projection. Cloud and business measures are marked
"not measured here".

## Fixtures

| Fixture | What it is |
|---|---|
| [`fixtures/shop`](fixtures/shop/README.md) | Acme Shop: pricing, sign-up with an email code, login, dashboard, iframe card checkout, billing, settings, orders table. Also the built-in demo project (ONB-5). |
| [`fixtures/android`](fixtures/android/README.md) | Acme Shop for Android: a native app on the shop's server with sign-in, a projects list and form, a dialog, a camera permission prompt, a deep link and a long settings page. One APK per variant (`correct`, `cosmetic`, `broken-login`, `broken-silent-tap`, `broken-not-saved`, `broken-crash`). Its reference suite runs on an emulator (CI job `android`). |

## Running the shop

```bash
pnpm install
pnpm --filter @optestra/fixture-shop start -- --variant cosmetic --port 4100
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
- tests that read an email (`checkout-trial`, `signup-email-code`) read their
  code from a real Mailpit when one answers at `MAILPIT_URL` (the shop then sends
  over `MAILPIT_SMTP`), else from the shop's own outbox, read in process
  (`shopInbox`). `REQUIRE_MAILPIT=1` (CI) makes a missing Mailpit an error.
  Without Mailpit their generated specs can't read the email, so they aren't
  compared for equivalence;
- a test's `auth:` profile login is step 0 in the manifest (it runs before step 1);
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
