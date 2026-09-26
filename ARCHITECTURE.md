# Architecture (engine)

pnpm workspace, TypeScript strict, Node 24. Each package builds with `tsc -b`
(project references) into its own `dist/`.

| Package | Role | Filled in by |
|---|---|---|
| `packages/brand` | `brand.json`, the only source of product naming, its typed export, and the `brand-sync` tool behind `brand:apply` / `brand:check` | FND-0 |
| `packages/config` | Project file (YAML) schema, defaults, merge with provenance, diagnostics, environments, secrets, redactor. Browser-safe main entry + `/node` + restricted `/reveal` | FND-1 |
| `packages/contract` | The results contract: zod schemas, types and JSON Schema for runs, test results and live events; the run folder layout; `foldEvents`, `summarize`, `exitCodeFor`. Browser-safe main entry + `/node` (run writer/reader). Depends only on zod | FND-3 |
| `packages/core` | The engine: run, record, replay, heal, verdicts. Currently `version()` and the redacting `logger` (all engine logging goes through it) | engine phases |
| `packages/cli` | CLI binary (name from brand) for CI, coding agents and power users | engine phases |
| `packages/mcp` | MCP server for coding agents | agents phase |
| `packages/action` | GitHub Action (`action.yml`) | GitHub/CI phase |
| `bench/` | Evaluation fixtures (not a package yet) | FND-4 |

## Dependency direction

```
cli ──► core ──► config ──► brand
 │        │                   ▲
 │        └──► contract, model adapter (FND-2)
 ├──► contract                │
 └──────────────────────────────┘  everything that shows a name reads brand
mcp, action ──► core, contract (later)
contract ──► zod only (bottom of the graph)
```

- The engine is self-contained. It never imports or references the apps repo;
  the arrow only points apps → engine (`test/guards.test.ts` enforces this).
- No telemetry and no network calls in engine code (also enforced by the guard test).
  Model calls in FND-2 go through the adapter layer, only when the user asks.
- Apps consume these packages by semver, never by copying code.

## Where future phases plug in

- FND-1 (done): `packages/config`. Project file `{name}.config.yaml`, resolution
  order defaults → project → environment overrides → env vars → run options.
  See `packages/config/README.md`.
- FND-2 AI model adapter and provider pool: its own package, used by `core`. It
  registers a `models` config section (`registerSection`) and puts model
  defaults in `packages/config/defaults.yaml`.
- FND-3 (done): results contract, see below.
- FND-4 demo site and first fixture: `bench/`.

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
