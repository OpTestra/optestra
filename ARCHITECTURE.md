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
| `packages/contract` | Versioned results contract: run events, results, artifact layout | FND-3 |
| `packages/core` | The engine: run, record, replay, heal, verdicts. Currently `version()`; re-exports the redacting `logger` (all engine logging goes through it) | engine phases |
| `packages/cli` | CLI binary (name from brand) for CI, coding agents and power users | engine phases |
| `packages/mcp` | MCP server for coding agents | agents phase |
| `packages/action` | GitHub Action (`action.yml`) | GitHub/CI phase |
| `bench/` | Evaluation fixtures (not a package yet) | FND-4 |

## Dependency direction

```
cli ──► core ──► config ──► brand
 │                 ▲          ▲
 └──► models ──────┘──────────┘   (models never imports core, so core can use models later)
mcp, action ──► core, contract (later)
```

- The engine is self-contained. It never imports or references the apps repo;
  the arrow only points apps → engine (`test/guards.test.ts` enforces this).
- No telemetry. **One network exception:** `packages/models/src/transport.ts`, the
  only file allowed to make network calls. It sends requests only to configured
  provider hosts, and only when a caller asks for a completion or key check. Only
  `packages/models` may depend on the AI SDK. `test/guards.test.ts` enforces all of this.
- Apps consume these packages by semver, never by copying code.

## Where future phases plug in

- FND-1 (done): `packages/config`. Project file `{name}.config.yaml`, resolution
  order defaults → project → environment overrides → env vars → run options.
  See `packages/config/README.md`.
- FND-2 (done): `packages/models`. `createModels(...).complete(role, request)`,
  a `models` config section, default model ids in `packages/config/defaults.yaml`,
  and prices in `packages/models/prices.yaml`. See `packages/models/README.md`.
- FND-3 results contract: `contract`, consumed by every reader (CLI, MCP, apps).
- FND-4 demo site and first fixture: `bench/`.

## Releases

Changesets (`pnpm changeset`, `pnpm version-packages`). All public packages share
one version (a `fixed` group). Access stays `restricted` until the public launch.
