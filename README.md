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

## Use your AI subscription

No API key? If you pay for Claude (Pro/Max/Team) or ChatGPT (Plus/Pro), install
Claude Code or Codex, sign in with its own command (`claude auth login` /
`codex login`), and the engine uses it as its AI model. `login` shows what's
ready; `models --check` verifies it. The tool runs locked down (no shell, no
files, no web), we never touch its sign-in, and it's local only. Google
subscriptions can't be used this way (use a Gemini API key). Details and vendor
terms: [packages/models/README.md](packages/models/README.md#use-your-ai-subscription-mod-6).

## Renaming

Edit `packages/brand/brand.json`, then run `pnpm brand:apply` here and in `apps/`.
`pnpm brand:check` fails if a product-name literal appears outside brand.json,
LICENSE, docs and lockfiles.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
