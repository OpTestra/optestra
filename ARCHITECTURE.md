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
| `packages/core` | The engine: run, record, replay, heal, verdicts. Currently `version()`; re-exports the redacting `logger` (all engine logging goes through it) | engine phases |
| `packages/cli` | CLI binary (name from brand) for CI, coding agents and power users | engine phases |
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
 └──► contract                     (cli reads run folders through the contract)
mcp, action ──► core, contract (later)
contract ──► zod only (bottom of the graph)
```

- The engine is self-contained. It never imports or references the apps repo;
  the arrow only points apps → engine (`test/guards.test.ts` enforces this).
- No telemetry. **Two network exceptions in engine code**, one file each:
  `packages/models/src/transport.ts` (AI models: sends only to configured provider
  hosts, only when a caller asks for a completion or key check) and
  `packages/decide/src/node/systemone/transport.ts` (decision models Jev, Kev and
  Laya: sends only to the configured backend's host; the state is redacted first).
  Only `packages/models` may depend on the AI SDK. `test/guards.test.ts` enforces all of this.
- Bench fixtures are servers, not engine code. They bind to 127.0.0.1 and never
  call out; the guard test scans them too, with one named exception per file
  (`NETWORK_EXCEPTIONS`). Nothing under `packages/` imports a fixture.
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
