# Architecture (engine)

pnpm workspace, TypeScript strict, Node 24. Each package builds with `tsc -b`
(project references) into its own `dist/`.

| Package | Role | Filled in by |
|---|---|---|
| `packages/brand` | `brand.json`, the only source of product naming, its typed export, and the `brand-sync` tool behind `brand:apply` / `brand:check` | FND-0 |
| `packages/config` | Project file (YAML) schema, defaults, merge with provenance, diagnostics, environments, secrets, redactor. Browser-safe main entry + `/node` + restricted `/reveal` | FND-1 |
| `packages/contract` | Versioned results contract: run events, results, artifact layout | FND-3 |
| `packages/core` | The engine: run, record, replay, heal, verdicts. Currently `version()` and the redacting `logger` (all engine logging goes through it) | engine phases |
| `packages/cli` | CLI binary (name from brand) for CI, coding agents and power users | engine phases |
| `packages/mcp` | MCP server for coding agents | agents phase |
| `packages/action` | GitHub Action (`action.yml`) | GitHub/CI phase |
| `bench/fixtures/shop` | Acme Shop (`@testament/fixture-shop`, private): the demo project and first Bench fixture, with variants, plain-English tests, gold `manifest.yaml` and a Playwright reference suite. See `bench/README.md` | FND-4 |

## Dependency direction

```
cli ──► core ──► config ──► brand
 │        │                   ▲
 │        └──► contract (FND-3), model adapter (FND-2)
 └──────────────────────────────┘  everything that shows a name reads brand
mcp, action ──► core, contract (later)
```

- The engine is self-contained. It never imports or references the apps repo;
  the arrow only points apps → engine (`test/guards.test.ts` enforces this).
- No telemetry and no network calls in engine code (also enforced by the guard test).
  Model calls in FND-2 go through the adapter layer, only when the user asks.
- Bench fixtures are servers, not engine code. They bind to 127.0.0.1 and never
  call out; the guard test scans them too, with one named exception per file
  (`NETWORK_EXCEPTIONS`). Nothing under `packages/` imports a fixture.
- Apps consume these packages by semver, never by copying code.

## Where future phases plug in

- FND-1 (done): `packages/config`. Project file `{name}.config.yaml`, resolution
  order defaults → project → environment overrides → env vars → run options.
  See `packages/config/README.md`.
- FND-2 AI model adapter and provider pool: its own package, used by `core`. It
  registers a `models` config section (`registerSection`) and puts model
  defaults in `packages/config/defaults.yaml`.
- FND-3 results contract: `contract`, consumed by every reader (CLI, MCP, apps).
- FND-4 (done): `bench/fixtures/shop`. `startShop({ variant, port })` is what the
  desktop app will launch as the demo project; `/__test/` hooks are what AUT-10
  setup and the Bench runner use. Browser tests run only in `bench:fixtures:test`
  (CI job `fixtures`); `pnpm check` stays browser-free.

## Releases

Changesets (`pnpm changeset`, `pnpm version-packages`). All public packages share
one version (a `fixed` group). Access stays `restricted` until the public launch.
