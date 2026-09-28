# Troubleshooting

Start with `doctor`. It checks everything a run needs and prints one line per check, `ok`, `warn` or `FAIL`, each problem with its exact fix.

```sh
%cli% doctor                 # all environments
%cli% doctor --env staging   # one environment
%cli% doctor --json --strict # CI: exit 0 all ok, 1 warnings (with --strict), 2 any failure
```

The desktop app's **Setup check** runs the same checks.

## doctor's checks

| Check | A problem means | Fix |
|---|---|---|
| **Node.js** | Node is older than 24 | Install Node 24 (`nvm install 24`) |
| **Project file** | `%config%` is missing or has errors (or warnings) | The first problem's exact fix is shown; see [Project file problems](#project-file-problems). No project file: run `%cli% init` in your repository, or run inside a project folder |
| **Tests** | no test files, or tests with lint errors or warnings | Add a `.test.md` file (`init` writes an example); run `%cli% lint` for each problem (`--fix` applies the safe ones) |
| **Secrets** | a declared secret has no value (names only; values are never shown) | Set each one in `.env`, `.env.<environment>` or the environment |
| **AI models** | no usable model for the planner or fixer role | Sign in to Claude Code (`claude auth login`) or Codex (`codex login`), or set an API key in `.env`. `%cli% login` shows what's ready |
| **AI provider …** | a provider's key is invalid, or it is unreachable or misconfigured | The fix for that provider; `%cli% models --check` for details |
| **Decisions** / **Decision backend …** | the decision backend you chose can't be used (no key, not reachable, model not installed) | The fix shown; `%cli% decisions --check` |
| **Test inbox** | the inbox section is wrong, the inbox is unreachable or its key is invalid | Fix the `inbox` section; `%cli% inbox check` for details |
| **Browsers** | Chromium can't start | `%cli% install-browsers` (on Linux, `--with-deps` installs the system libraries) |
| **Base URL (env)** | the base URL can't be reached, answers with an error, or is outside the allowed domains | Start your app at that address, or change `environments.<env>.baseUrl`; add its host to `allowedDomains` |
| **Profile flows recorded** | an auth profile's login flow is missing (fail) or not recorded yet (warn) | Create the flow (`kind: flow`) or fix `auth.profiles.<name>.flow`; run a test that uses the profile once |
| **Recordings** | some tests aren't recorded yet: they run with the AI until they are | `%cli% author <file>` for each |
| **Playwright specs** | generated specs are stale, can't be generated, or were edited by hand | `%cli% generate` (`--force` replaces hand-edited files) |
| **Your Playwright setup** | your own Playwright config would also pick up the generated specs | The fix shown: exclude the generated folder in your config |

## Blocked tests

A blocked test couldn't run. It is never a pass or a failure; the reason says what to fix.

| Reason | Means | Fix |
|---|---|---|
| `missing_secret` | a secret the test types has no value (or a protected preview's secret is missing, which blocks every test) | Set it in `.env` or the environment; in CI, pass it to the job. Expected on pull requests from forks |
| `disallowed_domain` | the page went, or a secret would have been typed, outside the allowed domains | Add the host to `allowedDomains`, or the secret's `domains`. `%cli% snapshot <url>` shows refused requests |
| `ai_unavailable` | a step needs AI (not recorded, or a heal needs the fixer) and no model could answer | Set up a model (`%cli% doctor`); or record locally and commit the recording |
| `budget_exceeded` | the run's AI budget ran out | Raise `run.budget.maxPerRunUsd` or pass `--budget` |
| `app_down` | the app didn't answer | Start it, or check `baseUrl` |
| `config_error` | the project file or the test has an error, an env var is missing, or an auth profile is unknown | `%cli% doctor`, `%cli% lint` |
| `inbox_unavailable` | no email arrived in time, or no inbox is configured | Check `%cli% inbox check`, your app's SMTP settings and `inbox.timeoutSeconds` |
| `login_failed` | an auth profile's login couldn't complete | Run the profile's flow on its own; `%cli% auth --clear` drops saved sessions |
| `setup_failed` | a setup hook failed | Check the hook's request against your app |
| `app_install_failed` | Android: the APK didn't install | The message has Android's own `INSTALL_FAILED_…` reason |
| `captcha`, `aborted` | a CAPTCHA was in the way; the run was stopped | Turn CAPTCHAs off in your test environment |

## Common failures

- **"the right element was used, but nothing happened"**: the recorded button was found and clicked, but none of its recorded effect showed. The app didn't react (a real bug, or a slow reaction beyond 3 s).
- **A check that "proves nothing"**: its sanity test showed it would pass without the step doing anything. `%cli% checks <file>` shows which; rephrase the `Expect:` line to name what should change.
- **Pending checks**: an `Expect:` line couldn't be compiled faithfully. In replay-only mode the test fails. Rephrase it (see [the phrase rules](./runs/checks-and-verdicts.md#the-phrase-rules)) or record again with a model available.
- **"re-record this test"**: it healed in 3 of its last 10 runs. `%cli% run <file> --rerecord`.
- **Flaky**: failed, then passed on a retry. The report's cause and the failed attempt's check say what differed.

## Project file problems

Loading never stops on a mistake: an invalid value falls back to its default (or is dropped) and is reported with a code, the exact fix and the line.

| Code | |
|---|---|
| `PROJECT_NOT_FOUND` | no `%config%` here or in any folder above |
| `YAML_SYNTAX`, `YAML_DUPLICATE_KEY`, `CONFIG_NOT_OBJECT` | the file isn't valid YAML, or not a map |
| `VERSION_MISSING`, `VERSION_UNSUPPORTED` | `version: 1` is missing or wrong |
| `UNKNOWN_KEY` (warning) | a key that doesn't exist (see the [reference](./reference/config.md)) |
| `REQUIRED_MISSING`, `INVALID_VALUE` | a required value is missing, or a value is invalid |
| `ENV_NONE_DEFINED`, `ENV_NOT_SELECTED` (warnings), `ENV_NOT_FOUND`, `ENV_DEFAULT_UNKNOWN` | no environments, none chosen, or an unknown one |
| `ENV_BASE_URL_MISSING`, `ENV_APP_MISSING` | an environment has no `baseUrl` (web) or `app` (Android) |
| `SECRET_NAME_INVALID`, `SECRET_DUPLICATE`, `SECRET_NO_DOMAINS`, `SECRET_UNDECLARED` | a secret's name isn't UPPER_SNAKE_CASE, is declared twice, has no domains, or isn't declared |
| `SECRET_MISSING`, `SECRET_INVALID` | a secret has no value, or a bad one (a TOTP seed that doesn't parse); the value is never shown |
| `ENV_VAR_INVALID`, `ENV_VAR_UNKNOWN` (warning) | a `%ENV%…` variable has a bad value, or names no setting |
| `RUN_OPTION_INVALID` | a command's option has a bad value |
| `ENV_FILE_SYNTAX` (warning) | a line in `.env` can't be read |

`%cli% config` shows every resolved value and where it came from (default, project file, environment, variable or flag, with the file and line).

## Getting help

Open an issue at [github.com/%repo%](https://github.com/%repo%/issues) with the output of `%cli% doctor --json` and, for a failing test, `%cli% results <runDir> --json`. Neither shows a secret's value.
