# Architecture (engine)

Repos: this engine is `TestamentHQ/testament` (MIT, public at launch); the closed
apps and cloud live in `TestamentHQ/platform` (checked out as `../apps`).

pnpm workspace, TypeScript strict, Node 24. Each package builds with `tsc -b`
(project references) into its own `dist/`.

| Package | Role | Filled in by |
|---|---|---|
| `packages/brand` | `brand.json`, the only source of product naming, its typed export, and the `brand-sync` tool behind `brand:apply` / `brand:check` | FND-0 |
| `packages/config` | Project file (YAML) schema, defaults, merge with provenance, diagnostics, environments, secrets, redactor. Browser-safe main entry + `/node` (also the redacting logger) + restricted `/reveal` | FND-1 |
| `packages/models` | The one AI adapter: providers (via the Vercel AI SDK), role pools with failover, prices, usage caps, budgets, call records, key check. Registers the `models` config section | FND-2 |
| `packages/contract` | The results contract: zod schemas, types and JSON Schema for runs, test results and live events; the run folder layout; `foldEvents`, `summarize`, `exitCodeFor`. Browser-safe main entry + `/node` (run writer/reader). Depends only on zod | FND-3 |
| `packages/spec` | The test file format: `.test.md` parser, typed model, variables and generators, flow expansion, step keys (`textKey`), canonical printer, diagnostics with ranges; lint rules, `checkTest` and the editor language service; registers the `tests` and `lint` config sections. Browser-safe main entry + `/node` (project loading) | SPEC-0, SPEC-1 |
| `packages/decide` | The decision layer: typed decision tasks (choice / score / noul), rules first → decision model → escalate below threshold, hard time limits, racing (during-run) and batching (after-run), decision cache, metrics, labelled examples; registers the `decisions` config section. Browser-safe main entry + `/node` (disk cache, label store) | DEC-0 |
| `packages/browser` | The browser harness: fresh isolated Playwright sessions behind the allowlist guard, a closed set of typed actions with post-state and settle, accessibility observations with refs and locator candidates, secret typing, screenshots and scrubbed evidence; the read-only check evaluator (`check`, `pageCopy`). Node only; no AI. The agent (LOOP-1) and the replayer (LOOP-4) both drive pages through it | LOOP-0, LOOP-2 |
| `packages/auth` | Login building blocks: auth profiles and the saved-session store (`ensureProfile` with an injected login flow), the `totp` secret type, test inboxes (Mailpit, Mailosaur, MailSlurp) with code/link extraction and `InboxValues` for `{{inbox.…}}`; registers the `auth` and `inbox` config sections. Node only (+ browser-safe `/extract`) | AUTH-0 |
| `packages/recording` | The recording format: per test, the commands for each step (locators, fingerprints, templates, learned waits) and the typed checks with their summaries (`describeCheck`) and sanity results; keys (`routeOf`, `stepKey`, `RECORDING_EPOCH`). Browser-safe + `/node` reader/writer | LOOP-1, LOOP-2 |
| `packages/codegen` | Generated Playwright specs: a recording → a plain `@playwright/test` spec next to the test, plus the shared fixtures module (allowlist route, secrets, values, network and inbox helpers) and Playwright config; hand-edit protection; `generateProject` in `/node`. The output imports nothing from the engine | LOOP-3 |
| `packages/report` | What people read from a run folder: the offline HTML report, JUnit XML, the versioned JSON summary for agents (with JSON Schema), the Markdown summary for the PR comment and job summary, and the quiet terminal formatter. Pure functions of the contract documents (browser-safe) + `/node` (read a run folder, write files, latest run, colour, `openFile`). Look from one tokens file | EVD-0 |
| `packages/core` | The engine: run, record, replay, heal, verdicts. The author (`authorTest`: agent loop, guards, VER-5 check, authoring report; `/node` `saveAuthoring`), the check compiler (`src/checks/`: phrase rules, AI fallback, sanity test, soft judgments) and the runner (`src/run/`: `replayAttempt`, `decideVerdict`; `/node` `runTests` → a contract run folder); re-exports the redacting `logger` | LOOP-1 onward |
| `packages/cli` | CLI binary (name from brand) for CI, coding agents and power users; `init`, `doctor` (also `runDoctor()` from the package entry, for the apps' Setup check) and `export` | engine phases, CLI-0 |
| `packages/mcp` | MCP server for coding agents | agents phase |
| `packages/action` | GitHub Action (`action.yml`) | GitHub/CI phase |
| `bench/fixtures/shop` | Acme Shop (`@testament/fixture-shop`, private): the demo project and first Bench fixture, with variants, plain-English tests, gold `manifest.yaml` and a Playwright reference suite. See `bench/README.md` | FND-4 |

## Dependency direction

```
cli ──► core ──► config ──► brand
 │                 ▲          ▲
 ├──► models ──────┘──────────┘   (models never imports core, so core can use models later)
 ├──► spec ──► config, contract    (spec never imports core or models; no AI, no network)
 ├──► decide ──► config, contract  (main entry: no network; /node: System One backends, DEC-1)
 ├──► browser ──► config, contract, recording (+ playwright; never imports core, models or spec)
 ├──► recording ──► spec, brand    (browser-safe; no AI, no network)
 ├──► auth ──► config, spec, brand (never imports core or browser; /inbox/transport.ts: inboxes, AUTH-0)
 ├──► codegen ──► recording, spec, config, brand (node; no AI, no network;
 │                its output imports only @playwright/test)
 ├──► report ──► contract, brand     (browser-safe renderers; never imports core, browser,
 │                models or decide; reads documents, never artifact contents)
 core ──► browser, models, spec, recording, contract, config, decide, codegen, auth
 └──► contract                     (cli reads run folders through the contract)
mcp, action ──► core, contract (later)
contract ──► zod only (bottom of the graph)
```

- The engine is self-contained. It never imports or references the apps repo;
  the arrow only points apps → engine (`test/guards.test.ts` enforces this).
- No telemetry. **Three network exceptions in engine code**, one file each:
  `packages/models/src/transport.ts` (AI models: sends only to configured provider
  hosts, only when a caller asks for a completion or key check),
  `packages/decide/src/node/systemone/transport.ts` (decision models Jev, Kev and
  Laya: sends only to the configured backend's host; the state is redacted first) and
  `packages/auth/src/inbox/transport.ts` (test inboxes Mailpit, Mailosaur and
  MailSlurp: sends only to the configured inbox host, never follows redirects).
  Secret values are revealed (`@testament/config/reveal`) only in the browser
  driver and these transports' key handling (guard-tested).
  Only `packages/models` may depend on the AI SDK. `test/guards.test.ts` enforces all of this.
- The browser harness drives a browser through Playwright; the page's traffic is
  the browser's, filtered by the allowlist guard. It makes no calls of its own. Its
  one server, `packages/browser/src/refusal-proxy.ts`, listens on 127.0.0.1 and
  refuses everything sent to it (named exception in the guard test, which also checks
  it never connects out).
- Bench fixtures are servers, not engine code. They bind to 127.0.0.1 and never
  call out; the guard test scans them too, with one named exception per file
  (`NETWORK_EXCEPTIONS`). No package source imports a fixture (guard-tested); the
  browser harness's real-browser tests (`packages/browser/e2e`) use the shop as a
  dev dependency.
- Apps consume these packages by semver, never by copying code.

## Where future phases plug in

- FND-1 (done): `packages/config`. Project file `{name}.config.yaml`, resolution
  order defaults → project → environment overrides → env vars → run options.
  See `packages/config/README.md`.
- FND-2 (done): `packages/models`. `createModels(...).complete(role, request)`,
  a `models` config section, default model ids in `packages/config/defaults.yaml`,
  and prices in `packages/models/prices.yaml`. See `packages/models/README.md`.
- FND-3 (done): results contract, see below.
- FND-4 (done): `bench/fixtures/shop`. `startShop({ variant, port })` is what the
  desktop app will launch as the demo project; `/__test/` hooks are what AUT-10
  setup and the Bench runner use. Browser tests run only in `bench:fixtures:test`
  (CI job `fixtures`); `pnpm check` stays browser-free.

- SPEC-0 (done): `packages/spec`. `parseTest(text, path)` → `TestSpec` + diagnostics,
  `expandTest(spec, ctx)` → the runnable steps (flows inlined, variables bound,
  secrets kept as references, a `textKey` per step), `printTest(spec)` → canonical
  text, and `loadTests(projectDir, config)` in `/node`. CLI `list` and `show`.
  LOOP runs `ExpandedTest.steps` and builds `StepResult.key` from `textKey` +
  route + engine version. SPEC-1 adds lint rules and the editor language service
  on top of the same model. See `packages/spec/README.md` (the file-format reference).
- SPEC-1 (done): lint and editor support, also in `packages/spec` (it needs the
  model, positions and expansion, and a separate package would only add a
  dependency hop). `checkTest(text, path, ctx)` is the one parse + expand + lint
  answer for the CLI (`lint`), editors and cloud; rules are data-driven
  (`lint-words.yaml`), a fix that touches an expectation line is never safe
  (HEAL-3), and `createLanguageService` gives the desktop and web editors
  diagnostics, completions, hover, code actions, format, outline and go-to-flow.
  Test ids now drop the whole `.test.md` suffix (`tests/login.test.md` → `tests__login`).

- DEC-0 (done): `packages/decide`. `createDecisions({ config, backend, cache, onDecision })`
  gives `decide(task, input)` → `decided` (answers, confidence, source) or `escalated`
  (reason, `onEscalate`, `best`), plus `race` and `decideBatch`. Every decision yields a
  contract `DecisionRecord` through `onDecision` (the runner emits `decision.made`).
  No task can output a verdict (enforced at registration). Default backend `none`:
  rules only. DEC-2 adds the six real tasks as specs in `src/tasks/`. See `packages/decide/README.md`.
- DEC-1 (done): decision model backends in `@testament/decide/node`. One System One
  client (`createSystemOneBackend`) serves Jev (hosted by TypeSafe AI), Kev (self-hosted)
  and Laya. **Ollaya** (a local server for decision models, like Ollama for System One
  models; 127.0.0.1:11435) is the Laya runtime: the client uses its native `/api/decide`
  (keep-alive, `state_truncated`). `decisions.backend` defaults to `auto` (Jev when
  `JEV_API_KEY` is set, else rules only, zero network). `createProjectDecisions` is what a
  run calls: backend from config, disk cache, and a warm-up that loads Laya before the
  first 100 ms decision. CLI `decisions --check | --bench` and `decider setup laya`
  (never installs Ollaya; pulls a model only after asking).

- LOOP-0 (done): `packages/browser`. `launchBrowser()` once per worker,
  `openSession({ browser, baseUrl, allowedDomains, secrets, device, evidence, … })`
  once per test, then `observe()` → `renderForModel()` for the model,
  `act(action)` → `ActionOutcome` (status, reason, post-state, settle time),
  `candidates(ref)` for fingerprints (LOOP-4: `inspect(locator)` / `factsOf(ref)` for
  replay validation), `screenshot()` and `close()` → scrubbed
  evidence files for `RunWriter.writeArtifact`. Refusals map to the contract's
  `disallowed_domain` / `missing_secret` blocked reasons. CLI `install-browsers`
  and `snapshot` (debug). Real-browser tests run in `bench:fixtures:test` (CI job
  `fixtures`, Chromium + Firefox + WebKit). See `packages/browser/README.md`
  (safety model, actions, observation format, outcomes).

- LOOP-1 (done): `packages/recording` + the author in `packages/core`.
  `authorTest(expanded, { session, models, budget, production, timeoutMs, previous, meta })`
  runs setup request hooks (through the harness's `hookRequest`), then each action
  step through the agent loop (planner role, tools = the LOOP-0 action set +
  `look`/`step_done`/`step_impossible`, guards checked before acting, VER-5: no
  visible change → `no_visible_effect`), exact ops without a model, and pending
  checks for Expect/Soft. Output: the recording
  (`<tests>/<data dir>/<testId>.steps.json`, committed) and the authoring report
  (`<project>/<data dir>/authoring/<runId>/`). CLI `author`. Scripted-model browser
  tests run in `bench:fixtures:test`; `@testament/models/testing` provides the
  scripted model. See `packages/recording/README.md` and `packages/core/README.md`.

- LOOP-2 (done): the check compiler. At each Expect/Soft step, `authorTest`
  calls `compileCheck` (`packages/core/src/checks/`): phrase rules from
  `phrases.json` first (no model; they pick locators from the live page), the
  planner role only for lines no rule maps (structured output = a `CheckOp`,
  page as untrusted content), then one evaluation and the VER-6 sanity test
  (an empty page, and a `pageCopy()` taken before the preceding action; a check
  that proves nothing is regenerated once, then flagged). Exact expect ops are
  evaluated and sanity-tested too. The recording stores the op, `generatedBy:
  rules | ai | exact`, the summary (`describeCheck`, EVD-3), the sanity result
  and `failedAtAuthoring`. New ops: `value` (field values), `soft_judgment`
  (soft only, warn-only, evaluated through a model by `evaluateCheck`); `text`
  gains `matches`, role locators a heading `level`. The harness evaluates every
  deterministic op with `session.check(op, { timeoutMs, values, on, since })` (`since` = `session.requestMark()` or a page copy)
  (auto-waiting, expected vs actual, secrets refused): what LOOP-4 calls for
  verdicts. CLI: `author` shows each check; `checks <test>` lists them. See
  "How Expect lines become checks" in `packages/core/README.md`.

- DEC-2 (done): the four after-run decisions in `@testament/decide`:
  - `failure_cause` (DIA-1);
  - `flaky_or_real` (advice only; the flaky verdict stays deterministic);
  - `duplicate_or_new` (DIA-4 failure groups; its options are the run's groups);
  - `heal_class` (HEAL-6).

  Each has pure rules with their word lists in `src/tasks/signals.json`, and
  every decided answer carries evidence (signals + contract EvidenceRefs).
  `blocked` is set deterministically from a blocked reason, never decided.
  Backends are chosen per phase (`decisions.during` / `decisions.after`; `backend`
  is the shorthand). A backend too slow for a task's limit, or one that keeps
  timing out, is skipped for that task.
  LOOP-4 calls the browser-safe helpers `inputFromTestResult`, `classifyFailure`,
  `groupFailures` and `classifyHeal`. Eval sets live in `packages/decide/evals/`
  with a committed rules-only baseline, and `decisions --eval` scores them.
  DEC-3 adds the during-run `same_element` and `miss_action`.

- AUTH-0 (done): `packages/auth`. Profiles (`auth.profiles`, a test's `auth: name`)
  and `SessionStore` / `ensureProfile(name, { store, auth, environment, worker, runFlow,
  validate })`: saved Playwright storage state per environment, profile and worker in
  `<project>/<data dir>/auth/` (owner-only, git-ignored, values redacted). TOTP: secrets
  declared `type: totp` resolve to dynamic `SecretValue`s; the browser's secret fill awaits
  `prepareSecret` (config `/reveal`), which types the current code. Inboxes: `createInbox`
  → `Inbox` (`address`, `waitForMessage`, `check`), `extractCode` / `extractLinks`
  (allowed hosts only), and `createInboxValues` / `inboxSecret` for the spec's new
  `{{inbox.code|link|subject}}` namespace (bound `unresolved`). CLI `auth [--clear]`,
  `inbox check`, `inbox last`. The Mailpit e2e runs in the `fixtures` CI job with a
  Mailpit service. See `packages/auth/README.md`.
- AUTH-1 (done): logins and email codes in real runs. `core` now depends on
  `auth`. `auth: <profile>` tests start from a saved session (validated with the
  profile's `check` in the test's session, after its setup hooks) or the
  profile's flow, replayed like a test in its own evidence-free session
  (`run/profiles.ts`); the browser exports and loads storage state
  (`session.storageState()` / `useStorageState()`, values scrubbed). Test inboxes
  per attempt (`author/inbox.ts`): `{{inbox.code}}` / `{{inbox.link}}` are typed /
  opened by the harness as `INBOX_CODE` / `INBOX_LINK` secrets; the agent's
  `read_inbox` tool returns a handle, never the value (prompt `planner-v3`).
  Contract 1.2 adds blocked reasons `inbox_unavailable`, `login_failed`,
  `setup_failed`. Generated specs log in with the profile's flow. See
  `packages/core/README.md`.

- DEC-3 (done): the during-run decisions in `@testament/decide`:
  - `same_element`: weighted identity signals from `same-element.json`. It never
    guesses "same"; anything doubtful escalates, with per-signal evidence.
  - `miss_action`: the HEAL-1 healing ladder: block → no_heal (the right element
    did nothing) → replay_fallback → refind → no_heal (strict) → call_fixer → block.

  LOOP-4 and HEAL call the browser-safe helpers `decideSameElement`,
  `rankCandidates` (a clear, margin-separated match or `ambiguous`, never a
  random pick), `decideMiss` and `missContext`. They take the recording's
  Fingerprint and the browser's ElementFacts structurally, without importing
  either package. Eval sets are built from the shop's correct vs cosmetic builds.

- LOOP-3 (done): `packages/codegen`. `generateSpec(recording, { expanded, specs })`
  turns a recording into `<tests>/.testament/<testId>.spec.ts`: one `test.step`
  per English step (the line as a comment), flows as named step groups,
  role/label locators, web-first assertions, learned waits, data/params objects,
  generated values at run time, secrets by name through a domain-checked helper.
  `generateSupportFiles` writes `testament.fixtures.ts` (the allowlist as a
  Playwright route, secrets, values, network and inbox helpers) and
  `playwright.config.ts` from templates in `packages/codegen/runtime/`, plus a
  reporter and global teardown that scrub secrets out of every kept Playwright
  trace (deleting any they can't scrub). Every
  file carries a content hash; regeneration never overwrites a hand edit without
  `--force`. CLI `generate [tests…] [--force] [--check]`; LOOP-4 and `author`
  call `generateAfterRecording`. Ops the spec can't run (`pending`,
  `soft_judgment`, unknown) become annotations. The CI `fixtures` job runs the
  generated specs with plain Playwright against the shop. See
  `packages/codegen/README.md`.

- EVD-0 (done): `packages/report`. One view model (`buildModel`) over the run's
  documents feeds every output: `renderHtmlReport` (one self-contained page,
  inline CSS/JS, a CSP that allows no network, artifacts linked relative to the
  run folder, works with JS off, failure groups and headline + screenshot first),
  `renderJunit`, `renderJsonSummary` (`results-summary` 1.0, schema at
  `@testament/report/schema/results-summary.json`), `renderMarkdownSummary`
  (capped under GitHub's comment limit, screenshots as `artifact:<path>`
  placeholders that the Action fills with `fillArtifactLinks`) and
  `formatTestLine` / `formatRunSummary` / `formatTerminal` (CLI-4; LOOP-4's `run`
  prints with these). Colours, type and spacing live only in `src/tokens.ts`.
  CLI `report [runDir] [--out] [--open]` and `results --junit/--json [file]/--markdown`.
  The CI `fixtures` job runs the report in Chromium (axe, no network, JS off).
  See `packages/report/README.md`.

- LOOP-4 (done): the runner in `packages/core/src/run/`. `runTests({ projectDir,
  tests, tags, grep, environment, mode, retries, workers, budgetUsd, onEvent })`
  (`@testament/core/node`) runs a project: one browser per worker, one session per
  attempt, setup hooks, the start page, then `replayAttempt` per step: bind the
  recorded command, validate the element against its fingerprint
  (`decideSameElement`, REP-5), act, check the recorded post-state (VER-5), and on
  a miss the DEC-3 ladder (no-AI `replay_fallback` / `refind` become pending heal
  proposals; `call_fixer` is reported as "needs an AI heal" until HEAL). Steps
  without a recording are authored in place (normal mode), pending checks
  compiled in place; code-step tests run through their generated spec. Verdicts
  come from `decideVerdict` (code), causes from `classifyFailure`, groups from
  `groupFailures`; evidence (screenshots, video + WebVTT chapters, trace, console,
  HAR) and events go through the RunWriter. The harness gained `inspect(locator)`,
  `factsOf(ref)`, `post.reordered` and a table's sort state in observations. CLI
  `run`. `pnpm bench:replay` scores every shop variant against the manifest and
  checks replay/spec equivalence (CI `fixtures`). See "How a run works" in
  `packages/core/README.md`.

## Results contract (`packages/contract`)

The one format every reader uses: CLI, HTML report, PR comment, MCP server,
desktop app, web app and cloud. Nothing reads engine internals. Details and
field lists: `packages/contract/README.md`.

**What it owns:** the enums (verdict, failure cause, blocked reason, step kind,
recovery level, trigger, target, run mode), the documents (Run, TestResult with
attempts, StepResult, CheckResult, HealProposal, DecisionRecord, ModelCall,
ArtifactRef), the live events, the run folder layout, and the exit-code rule.

**Versioning:**
- Every document carries `contractVersion` (`"1.<minor>"`); events carry it on `run.started`.
- Additive changes (optional fields, new event types, values in *open* enums:
  blocked reason, model role, heal signal) bump the minor. Anything else bumps the major.
- Readers accept every minor of their major, drop unknown fields and skip
  unknown event types. Heal changes are the one strict object (HEAL-3).
- Committed fixtures (`fixtures/v1/`) are frozen: the generator never overwrites
  them, and tests require that they keep parsing and folding identically.

**Guarantees enforced in code:** verdicts must follow from the checks, steps or
blocked reason named in `decidedBy` (schema refinement; there is no decider kind
for models or decisions); the writer scrubs every string before writing and
refuses artifacts not declared `scrubbed: true`; the main entry imports only zod.

**Run folder** (`<project>/<dataDirName>/runs/<runId>/`, paths in documents are relative to it):

```
run.json                                     Run (folded from the events)
events.ndjson                                live events, one per line, seq 0,1,2…
tests/<testId>/result.json                   TestResult, all attempts
tests/<testId>/<attempt>/steps/<i>-before.png | <i>-after.png
tests/<testId>/<attempt>/video.webm | trace.zip | console.log | network.har | logcat.txt
```

`run.json` and the result files are always `foldEvents(events.ndjson)`, written
atomically when the run finishes. A run in progress has only `events.ndjson`.

## Releases

Changesets (`pnpm changeset`, `pnpm version-packages`). All public packages share
one version (a `fixed` group). Access stays `restricted` until the public launch.
