# Testament engine

> "Testament" is a placeholder name. All naming comes from
> [`packages/brand/brand.json`](packages/brand/brand.json).

The open-source (MIT) engine behind Testament: it runs, records, replays and heals
tests of websites and Android apps written in plain English. It works on its own,
with no account. The desktop app, web app and cloud consume it as normal packages.

**Status:** skeleton (FND-0). No engine logic yet.

## Requirements

- Node 24 (see `.nvmrc`)
- pnpm 10 (`corepack enable`; the version is pinned in `package.json`)

## Commands

```sh
pnpm install
pnpm check          # format check, lint, typecheck, test, build, brand:check
pnpm build
npx testament --version   # CLI from the workspace (name comes from brand.json)
```

## Renaming

Edit `packages/brand/brand.json`, then run `pnpm brand:apply` here and in `apps/`.
`pnpm brand:check` fails if a product-name literal appears outside brand.json,
LICENSE, docs and lockfiles.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
