# Quickstart: the CLI in five minutes

The CLI is every engine action as a command, for CI pipelines, coding agents and anyone who prefers a terminal. You need Node 24 and your web app running somewhere the machine can reach (`localhost` is fine).

## Install

```sh
npm install -D %scope%/cli
npx %cli% --version
```

::: info Before the first release
The npm packages are published with the first release. Until then, build the CLI from the repository: `git clone https://github.com/%repo%`, then `pnpm install && pnpm build` (pnpm 10, Node 24), and run `node packages/cli/bin/cli.js` wherever these pages say `%cli%`.
:::

## 1. Set up the project

In your web app's repository:

```sh
npx %cli% init
```

`init` asks three things: the project name, the base URL (where the app runs while you test) and the AI setup: your Claude or ChatGPT subscription, an API key (Anthropic, OpenAI, Google, OpenRouter, or any OpenAI-compatible API), or later. It then writes:

| File | |
|---|---|
| `%config%` | the project file, with one environment `local` at your base URL |
| `tests/example.test.md` | an example test (in `%cli%/` instead, if `tests/` already holds other files) |
| `.env.example` | the names of the keys and secrets, never values |
| `.gitignore` lines | ignore `.env` and the local data folder, keep recordings committed |
| `.env` | only if you typed an API key: keys go here, never in the project file |

It never overwrites a file, leaves an existing Playwright setup alone, and running it twice changes nothing. It ends with [`doctor`](../troubleshooting.md), which checks the project, the tests, secrets, AI, the browser and whether your base URL answers. For CI or scripts, pass everything as flags:

```sh
npx %cli% init --yes --name Shop --url http://localhost:3000 --ai claude-code
```

If you use your Claude or ChatGPT plan, sign in with the vendor's own tool first (`claude auth login` or `codex login`). `%cli% login` shows which tools are ready. See [Use your AI subscription](../ai/subscription.md).

## 2. Record the test once

```sh
npx %cli% author tests/example.test.md
```

The AI carries out each step once, through the [safe browser harness](../security/safety-model.md), and saves the **recording** next to the test in `tests/%dataDir%/`. Every `Expect:` line is compiled into a typed check, evaluated once and sanity-tested. It prints one line per step (status, actions, AI calls and cost) and, for each check, how it was made and its summary. Add `--headed` to watch.

## 3. Run it

```sh
npx %cli% run
```

Every test replays from its recording with **no AI**, and every check is evaluated fresh. You get one line per test (verdict, duration, AI calls, cost), the headline of each failure, and the results folder. Exit code 0 passed, 1 failed, 2 blocked (couldn't run). Open the HTML report with:

```sh
npx %cli% report --open
```

## 4. Own the code

The recorded test is also a plain Playwright spec:

```sh
npx %cli% generate                        # tests/%dataDir%/*.spec.ts
npx playwright test -c tests/%dataDir%       # runs without %Name%
npx %cli% export --out ../my-playwright   # a standalone Playwright project
```

See [If %Name% disappears](../if-it-disappears.md).

## How long it takes

Timed on the demo shop (a copy of the engine's shop fixture with no project file, the shop already running, Claude Code subscription): `init` 0.8 s, `author` of the example test 7.8 s (one AI call), `generate` 0.8 s, `npm install` 1.6 s, plain `npx playwright test` 1.9 s: about 21 seconds of commands, plus the time to answer `init`'s three questions.

## Next

- [Write your own tests](../writing/test-files.md) and check them with [`lint`](../writing/lint.md).
- [Environments](../environments.md): staging, previews, secrets and allowed domains.
- [Run it on every pull request](../ci/github-action.md).
