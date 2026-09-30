<!-- Generated from the CLI's command definitions (packages/cli/src/program.ts) by `pnpm --filter ./docs gen`. Do not edit: a test fails when this page is out of date. -->

# CLI reference

Every command of `%cli%`, with its arguments and flags. Every command also takes `-h, --help`; `%cli% -v` (`--version`) prints the engine version. Commands that take `-C, --dir` find the project in the nearest folder above the current one that has a `%config%`.

Exit codes follow one rule for every command that runs or checks something: **0** everything is fine, **1** a real problem (a failed test, a lint error, a failed check), **2** couldn't run (blocked tests, a missing or invalid project file, a missing recording). The guides give each command's exact cases.

| Command | What it does |
|---|---|
| [`config`](#config) | show the resolved project settings for an environment and where each came from |
| [`models`](#models) | show each AI role's provider pool, key status and usage caps |
| [`decisions`](#decisions) | show the decision routing, thresholds and tasks; --check the backends, --bench their speed, --eval their accuracy, --stats a run's decisions |
| [`decider setup`](#decider-setup) | laya: find the local Ollaya and, if you agree, download the model (never installs Ollaya); jev/kev: how to set them up |
| [`results`](#results) | summarise a finished run folder and exit with its CI code (0 passed, 1 failed, 2 blocked) |
| [`merge-runs`](#merge-runs) | merge shard run folders (run --shard i/n) into one run folder, then summarise it like run |
| [`report`](#report) | write the offline HTML report of a run (default: the project's latest run) |
| [`list`](#list) | list the project's runnable tests with their step and problem counts |
| [`show`](#show) | show one test file as the engine reads it (exit 2 when it has errors) |
| [`lint`](#lint) | check test files for problems and weak tests (exit 1 on errors, 2 if a file can't be parsed) |
| [`author`](#author) | let the AI carry out a test's steps once and save the recording that later runs replay |
| [`new`](#new) | draft a test from one sentence by exploring the app (AI); prints it, and saves it only with --accept or --out |
| [`mcp`](#mcp) | start the MCP server for coding agents (stdio) on this project: list, draft, save and run tests, read results, accept heals |
| [`run`](#run) | run tests: replay each recording with no AI, evaluate every check, write a results folder (exit 0 passed, 1 failed, 2 blocked) |
| [`heal`](#heal) | review a run's heals (default: the latest run): the recording diff, why, confidence; accept or reject them |
| [`checks`](#checks) | show what each Expect line of a test was compiled into: the check, how it was made, its sanity test |
| [`auth`](#auth) | list auth profiles and their saved login sessions per environment |
| [`inbox check`](#inbox-check) | check the configured inbox: reachable and API key valid |
| [`inbox last`](#inbox-last) | debug: the latest email to an address: subject and the code/link a test would use |
| [`login`](#login) | show which AI subscription tools (Claude Code, Codex) are ready, and how to sign in to them |
| [`generate`](#generate) | write the plain Playwright spec of each recorded test next to its recording (runs without this tool) |
| [`install-browsers`](#install-browsers) | download the browsers tests run in (Chromium; add --firefox, --webkit or --all) |
| [`snapshot`](#snapshot) | debug: print what the agent sees on a page, and any refused requests |
| [`init`](#init) | set up a project in this repository: project file, an example test, .env.example and .gitignore lines (never overwrites a file) |
| [`doctor`](#doctor) | check the project, tests, secrets, AI setup, browsers and recordings; every problem comes with its fix |
| [`export`](#export) | write a standalone Playwright project from the recorded tests (npm install && npx playwright test), or for an Android project a Maestro workspace (maestro test .) |
| [`android setup`](#android-setup) | check the Android SDK, emulator and system images; print the exact install commands and sizes |
| [`android doctor`](#android-doctor) | check everything a local Android run needs, without changing anything |
| [`android snapshot`](#android-snapshot) | debug: install an APK on a fresh emulator and print what the agent sees on its first screen |

## config {#config}

show the resolved project settings for an environment and where each came from

```sh
%cli% config [options]
```

| Option | | Default |
|---|---|---|
| `-e, --env <name>` | environment to resolve |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## models {#models}

show each AI role's provider pool, key status and usage caps

```sh
%cli% models [options]
```

| Option | | Default |
|---|---|---|
| `-e, --env <name>` | environment to resolve |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--check` | check every provider's API key with the cheapest possible call |  |
| `--json` | print machine-readable JSON |  |

## decisions {#decisions}

show the decision routing, thresholds and tasks; --check the backends, --bench their speed, --eval their accuracy, --stats a run's decisions

```sh
%cli% decisions [options]
```

| Option | | Default |
|---|---|---|
| `--check` | check every decision backend: key valid, reachable, model installed |  |
| `--bench` | measure decision latency on the demo task (after a warm-up) |  |
| `--eval` | score the decisions on the committed eval sets (exit 1 on a false label) |  |
| `--backend <name>` | for --bench: jev, kev, laya or all (default: the selected backend); for --eval: rules (default), jev, kev or laya |  |
| `--n <count>` | for --bench: decisions per backend | `"50"` |
| `--model-only` | for --eval with a backend: rules off, to measure the model alone |  |
| `--stats <runDir>` | print per-task decision metrics from a run folder |  |
| `-e, --env <name>` | environment to resolve |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## decider setup {#decider-setup}

laya: find the local Ollaya and, if you agree, download the model (never installs Ollaya); jev/kev: how to set them up

```sh
%cli% decider setup [options] <backend>
```

| Argument | |
|---|---|
| `<backend>` | laya, jev or kev |

| Option | | Default |
|---|---|---|
| `--model <name>` | the Laya model (default: decisions.laya.model) |  |
| `-y, --yes` | download without asking |  |
| `-e, --env <name>` | environment to resolve |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## results {#results}

summarise a finished run folder and exit with its CI code (0 passed, 1 failed, 2 blocked)

```sh
%cli% results [options] <runDir>
```

| Argument | |
|---|---|
| `<runDir>` | the run folder (contains run.json) |

| Option | | Default |
|---|---|---|
| `--json [file]` | print the machine-readable JSON summary, or write it to `<file>` |  |
| `--junit <file>` | also write JUnit XML to `<file>` |  |
| `--markdown <file>` | also write the Markdown summary (PR comment, job summary) to `<file>` |  |
| `--report-url <url>` | link the Markdown summary to the full report at this URL |  |
| `--healed-passes` | count healed tests as passed (default: they fail the exit code) |  |
| `--flaky-passes` | do not fail the exit code for flaky tests |  |

## merge-runs {#merge-runs}

merge shard run folders (run --shard i/n) into one run folder, then summarise it like run

```sh
%cli% merge-runs [options] <dirs...>
```

| Argument | |
|---|---|
| `<dirs...>` | run folders, or folders that contain them (searched two levels) |

| Option | | Default |
|---|---|---|
| `--out <dir>` | the merged run folder to create |  |
| `--healed-passes` | count healed tests as passed (default: the project's heal policy) |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## report {#report}

write the offline HTML report of a run (default: the project's latest run)

```sh
%cli% report [options] [runDir]
```

| Argument | |
|---|---|
| `[runDir]` | the run folder (contains run.json) |

| Option | | Default |
|---|---|---|
| `--out <dir>` | write index.html here instead of into the run folder |  |
| `--open` | open the report in the default browser |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## list {#list}

list the project's runnable tests with their step and problem counts

```sh
%cli% list [options]
```

| Option | | Default |
|---|---|---|
| `-t, --tag <tag>` | only tests with this tag |  |
| `-e, --env <name>` | environment whose overrides and vars apply |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## show {#show}

show one test file as the engine reads it (exit 2 when it has errors)

```sh
%cli% show [options] <file>
```

| Argument | |
|---|---|
| `<file>` | the .test.md file |

| Option | | Default |
|---|---|---|
| `--expanded` | inline flows and bind variables (secrets stay `{{secret.NAME}}`) |  |
| `-e, --env <name>` | environment whose overrides and vars apply |  |
| `--seed <seed>` | seed for generated values like `{{unique.email}}` | `"preview"` |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## lint {#lint}

check test files for problems and weak tests (exit 1 on errors, 2 if a file can't be parsed)

```sh
%cli% lint [options] [paths...]
```

| Argument | |
|---|---|
| `[paths...]` | test files or folders (default: every test and flow in the project) |

| Option | | Default |
|---|---|---|
| `--fix` | apply the safe fixes (never changes an Expect:, Soft: or Never: line) |  |
| `--strict` | count warnings as errors |  |
| `-e, --env <name>` | environment whose overrides and vars apply |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## author {#author}

let the AI carry out a test's steps once and save the recording that later runs replay

```sh
%cli% author [options] <file>
```

| Argument | |
|---|---|
| `<file>` | the .test.md file |

| Option | | Default |
|---|---|---|
| `-e, --env <name>` | environment to run against |  |
| `--headed` | show the browser or emulator window |  |
| `--device <preset>` | device preset, e.g. desktop, laptop, iphone-15 (Android: a device profile, e.g. pixel-8) |  |
| `--browser <name>` | chromium (default), firefox or webkit |  |
| `--android <version>` | Android projects: the Android version (default: android.version) |  |
| `--video` | also record a video |  |
| `-C, --dir <path>` | project folder (default: the test's nearest project) |  |

## new {#new}

draft a test from one sentence by exploring the app (AI); prints it, and saves it only with --accept or --out

```sh
%cli% new [options] <sentence>
```

| Argument | |
|---|---|
| `<sentence>` | what the test should show, e.g. "a returning user can log in" |

| Option | | Default |
|---|---|---|
| `--accept` | save the draft in the tests folder (only when lint is clean) |  |
| `--out <file>` | write the draft to this file instead (never over an existing file) |  |
| `--start <path>` | where the test starts, e.g. /login (default /) |  |
| `-e, --env <name>` | environment to explore |  |
| `--headed` | show the browser window |  |
| `--json` | print machine-readable JSON (never asks) |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## mcp {#mcp}

start the MCP server for coding agents (stdio) on this project: list, draft, save and run tests, read results, accept heals

```sh
%cli% mcp [options]
```

| Option | | Default |
|---|---|---|
| `-e, --env <name>` | default environment for runs and drafts |  |
| `--headed` | show the browser windows |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## run {#run}

run tests: replay each recording with no AI, evaluate every check, write a results folder (exit 0 passed, 1 failed, 2 blocked)

```sh
%cli% run [options] [tests...]
```

| Argument | |
|---|---|
| `[tests...]` | test files or folders (default: every test) |

| Option | | Default |
|---|---|---|
| `-t, --tag <tag...>` | only tests with this tag (repeatable) |  |
| `--grep <text>` | only tests whose name contains this |  |
| `--shard <i/n>` | run only slice i of n (split by test id; merge with merge-runs) |  |
| `-e, --env <name>` | environment to run against |  |
| `--base-url <url>` | run against this URL (e.g. a preview deploy) instead of baseUrl |  |
| `--replay-only` | no AI at all: a missed or unrecorded step fails (strict CI) |  |
| `--rerecord` | ignore the recordings and record every step again with AI |  |
| `--retries <n>` | extra attempts after a failure (default: run.retries) |  |
| `--workers <n>` | tests in parallel, one browser or emulator each (default 1) |  |
| `--budget <usd>` | AI budget for this run in dollars (default: run.budget.maxPerRunUsd) |  |
| `--headed` | show the browser or emulator windows |  |
| `--browser <name>` | chromium (default), firefox or webkit; repeat for a matrix (one result per browser × device) | `[]` |
| `--device <preset>` | device preset, e.g. desktop, laptop, iphone-15 (Android: a device profile, e.g. pixel-8); repeat for a matrix | `[]` |
| `--locale <code>` | browser locale, or the Android app's language, e.g. de-DE |  |
| `--timezone <id>` | browser or device timezone, e.g. Europe/Berlin |  |
| `--evidence <mode>` | full \| failures \| minimal (default: run.evidence, else full in CI and failures elsewhere) |  |
| `--android <version>` | Android projects: the Android version (default: android.version); repeat for a matrix | `[]` |
| `--no-video` | don't record a video per attempt |  |
| `--verbose` | print every step, heal and warning |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## heal {#heal}

review a run's heals (default: the latest run): the recording diff, why, confidence; accept or reject them

```sh
%cli% heal [options] [runDir]
```

| Argument | |
|---|---|
| `[runDir]` | the run folder (contains run.json) |

| Option | | Default |
|---|---|---|
| `--list` | only list the heals (the default without --accept/--reject) |  |
| `--accept <ids...>` | apply these heals to the recording (heal ids, or all) |  |
| `--reject <ids...>` | reject these heals (the recording stays as it is) |  |
| `--json` | print machine-readable JSON |  |
| `-e, --env <name>` | environment for regenerating the portable spec |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## checks {#checks}

show what each Expect line of a test was compiled into: the check, how it was made, its sanity test

```sh
%cli% checks [options] <file>
```

| Argument | |
|---|---|
| `<file>` | the .test.md file |

| Option | | Default |
|---|---|---|
| `--json` | print JSON |  |
| `-e, --env <name>` | environment (for the project settings) |  |
| `-C, --dir <path>` | project folder (default: the test's nearest project) |  |

## auth {#auth}

list auth profiles and their saved login sessions per environment

```sh
%cli% auth [options]
```

| Option | | Default |
|---|---|---|
| `--clear [profile]` | delete saved sessions (all, or one profile's) |  |
| `-e, --env <name>` | with --clear: only this environment's sessions |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## inbox check {#inbox-check}

check the configured inbox: reachable and API key valid

```sh
%cli% inbox check [options]
```

| Option | | Default |
|---|---|---|
| `-e, --env <name>` | environment to resolve |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## inbox last {#inbox-last}

debug: the latest email to an address: subject and the code/link a test would use

```sh
%cli% inbox last [options]
```

| Option | | Default |
|---|---|---|
| `--to <address>` | the recipient address |  |
| `--wait <seconds>` | how long to wait for an email | `"5"` |
| `-e, --env <name>` | environment whose allowed domains apply to links |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## login {#login}

show which AI subscription tools (Claude Code, Codex) are ready, and how to sign in to them

```sh
%cli% login [options]
```

## generate {#generate}

write the plain Playwright spec of each recorded test next to its recording (runs without this tool)

```sh
%cli% generate [options] [tests...]
```

| Argument | |
|---|---|
| `[tests...]` | test files or folders (default: every recorded test) |

| Option | | Default |
|---|---|---|
| `--force` | overwrite generated files that were changed by hand |  |
| `--check` | write nothing; exit 1 if a spec is out of date or changed by hand (for CI) |  |
| `-e, --env <name>` | environment whose base URL and allowed domains the specs use |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## install-browsers {#install-browsers}

download the browsers tests run in (Chromium; add --firefox, --webkit or --all)

```sh
%cli% install-browsers [options]
```

| Option | | Default |
|---|---|---|
| `--firefox` | also install Firefox |  |
| `--webkit` | also install WebKit (the Safari engine) |  |
| `--all` | install Chromium, Firefox and WebKit |  |
| `--with-deps` | also install system libraries (Linux, needs sudo) |  |

## snapshot {#snapshot}

debug: print what the agent sees on a page, and any refused requests

```sh
%cli% snapshot [options] <url>
```

| Argument | |
|---|---|
| `<url>` | page to open (relative URLs use the environment's baseUrl) |

| Option | | Default |
|---|---|---|
| `-e, --env <name>` | environment whose baseUrl and allowed domains apply |  |
| `--device <preset>` | device preset, e.g. desktop, laptop, ipad, iphone-15, pixel-8 |  |
| `--browser <name>` | chromium (default), firefox or webkit |  |
| `--screenshot <file>` | also save a PNG screenshot |  |
| `--storage-state <file>` | start with these cookies and local storage (Playwright storage state JSON) |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--json` | print machine-readable JSON |  |

## init {#init}

set up a project in this repository: project file, an example test, .env.example and .gitignore lines (never overwrites a file)

```sh
%cli% init [options] [dir]
```

| Argument | |
|---|---|
| `[dir]` | the repository folder (default: the current folder) |

| Option | | Default |
|---|---|---|
| `-y, --yes` | don't ask: use the flags and the detected defaults (for CI) |  |
| `--name <name>` | project name (default: package.json name or the folder name) |  |
| `--url <url>` | base URL of the app (default: from the framework, e.g. http://localhost:3000) |  |
| `--target <target>` | web (default) or android |  |
| `--app <path>` | android: the APK path |  |
| `--ai <setup>` | AI setup: claude-code, codex, anthropic, openai, google, openrouter, openai-compatible, later |  |
| `--ai-base-url <url>` | for --ai openai-compatible: the API base URL |  |
| `--ai-model <model>` | for --ai openrouter or openai-compatible: the model |  |
| `--key-stdin` | read the API key for --ai from stdin (it goes to .env only) |  |
| `--no-doctor` | don't run the doctor checks at the end |  |
| `--suggest` | explore the running app and propose 3 starter tests (AI); each is saved only when you say yes |  |
| `--agents` | append the instructions for coding agents to AGENTS.md / CLAUDE.md without asking |  |

## doctor {#doctor}

check the project, tests, secrets, AI setup, browsers and recordings; every problem comes with its fix

```sh
%cli% doctor [options]
```

| Option | | Default |
|---|---|---|
| `-e, --env <name>` | check only this environment (default: all) |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |
| `--strict` | exit 1 when there are warnings |  |
| `--json` | print machine-readable JSON |  |

## export {#export}

write a standalone Playwright project from the recorded tests (npm install && npx playwright test), or for an Android project a Maestro workspace (maestro test .)

```sh
%cli% export [options]
```

| Option | | Default |
|---|---|---|
| `-o, --out <dir>` | folder to create (default: ./playwright-export) |  |
| `-e, --env <name>` | environment whose base URL and allowed domains the tests use |  |
| `--force` | write into a folder that isn't empty |  |
| `-C, --dir <path>` | project folder (default: nearest folder with the project file) |  |

## android setup {#android-setup}

check the Android SDK, emulator and system images; print the exact install commands and sizes

```sh
%cli% android setup [options]
```

| Option | | Default |
|---|---|---|
| `--android <versions...>` | Android versions to set up (default: 16) |  |
| `--install` | run sdkmanager for what is missing, after showing the sizes and asking |  |
| `-y, --yes` | with --install: install without asking |  |
| `--json` | print machine-readable JSON |  |

## android doctor {#android-doctor}

check everything a local Android run needs, without changing anything

```sh
%cli% android doctor [options]
```

| Option | | Default |
|---|---|---|
| `--json` | print machine-readable JSON |  |

## android snapshot {#android-snapshot}

debug: install an APK on a fresh emulator and print what the agent sees on its first screen

```sh
%cli% android snapshot [options] <apk>
```

| Argument | |
|---|---|
| `<apk>` | the APK to install |

| Option | | Default |
|---|---|---|
| `--allow <domains...>` | hosts the app may reach, e.g. api.example.com or 10.0.2.2:4180 |  |
| `--android <version>` | Android version (default: 16) |  |
| `--device <profile>` | device profile, e.g. pixel-8, small-phone, pixel-tablet |  |
| `--screenshot <file>` | also save a PNG screenshot |  |
| `--window` | show the emulator window |  |
| `--json` | print machine-readable JSON |  |
