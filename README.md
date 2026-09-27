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

## Quickstart: your first test in five minutes

In the repository of your web app, with the app running:

```sh
npx testament init                       # project file, tests/example.test.md, .env.example, .gitignore lines
npx testament author tests/example.test.md   # the AI does the steps once and saves the recording
npx testament run                        # replays the recording (no AI when nothing changed)
```

`init` asks three things (name, base URL, AI setup: your Claude or ChatGPT
subscription, an API key, or later), never overwrites a file, leaves an
existing Playwright setup alone and puts keys only in `.env`. For CI, pass
everything as flags: `init --yes --name Shop --url http://localhost:3000 --ai
claude-code`. It ends with `doctor`, which you can run any time:

```sh
npx testament doctor          # one line per check: ok / warn / FAIL, each problem with its fix
npx testament doctor --json   # exit 0 all ok, 1 warnings with --strict, 2 any failure
```

The recorded test is also a plain Playwright spec you own:

```sh
npx testament generate                        # tests/.testament/*.spec.ts
npx playwright test -c tests/.testament       # runs without this tool
npx testament export --out ../my-playwright   # a standalone Playwright project
```

Timed on the demo shop (a copy of `bench/fixtures/shop` with no project file,
Claude Code subscription, the shop already running): `init` 0.8 s, `author`
of the example test 7.8 s (one AI call), `generate` 0.8 s, `npm install` 1.6 s,
plain `npx playwright test` 1.9 s: about 21 s of commands, plus the time to
answer `init`'s three questions. See
[What happens if Testament disappears](packages/codegen/docs/if-testament-disappears.md).

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
