<!-- Generated from the project file's JSON Schema and built-in defaults (packages/config) by `pnpm --filter ./docs gen`. Do not edit: a test fails when this page is out of date. -->

# Project file reference

Every key of `%config%`, with its type, its built-in default and what it does. `<env>`, `<NAME>` and similar stand for names you choose. Unknown keys are a warning (`UNKNOWN_KEY`) and are ignored. The same schema is published as JSON (`%scope%/models/schema.json` holds the project file with the models section), for editors.

Values are resolved in this order, lowest first: the built-in defaults, the project file, the selected environment's overrides (`run`, `secrets`, `models` and `decisions` can be set inside an environment), environment variables (`%ENV%<SECTION>_<FIELD>`, e.g. `%ENV%RUN_RETRIES=0`), then the flags of the command. `%cli% config` shows the result and where each value came from.

## version

| Key | Type | Default | |
|---|---|---|---|
| `version` | 1 |  |  |

## project

| Key | Type | Default | |
|---|---|---|---|
| `project` | object |  | The project. |
| `project.name` | string |  | Project name shown in the apps. |
| `project.target` | "web" \| "android" |  | What this project tests: web or android. |

## defaultEnvironment

| Key | Type | Default | |
|---|---|---|---|
| `defaultEnvironment` | string |  | Environment used when none is chosen. |

## environments

| Key | Type | Default | |
|---|---|---|---|
| `environments` | map of object |  | Named environments, e.g. local, preview, staging, production. |
| `environments.<env>.baseUrl` | string |  | Web: the site's base URL. |
| `environments.<env>.app` | string |  | Android: path to the APK or an upload reference. |
| `environments.<env>.allowedDomains` | list of string |  | Domains tests may visit. Default: the host of baseUrl. |
| `environments.<env>.production` | boolean | `false` | Production mode: destructive actions are blocked unless a test declares them. |
| `environments.<env>.vars` | map of string | `{}` | Plain values tests can use, by name. |
| `environments.<env>.protection` | object |  | Protected preview environments: headers sent only to allowed hosts in each secret's domains. |
| `environments.<env>.protection.vercelBypass` | string |  | Vercel Deployment Protection: the secret holding the Protection Bypass for Automation token (sent as x-vercel-protection-bypass). |
| `environments.<env>.protection.cloudflareAccess` | object |  | Cloudflare Access service token (CF-Access-Client-Id / CF-Access-Client-Secret). |
| `environments.<env>.protection.cloudflareAccess.clientId` | string |  | Secret with the service token's Client ID. |
| `environments.<env>.protection.cloudflareAccess.clientSecret` | string |  | Secret with the service token's Client Secret. |
| `environments.<env>.protection.basicAuth` | object |  | HTTP basic auth (Authorization: Basic …), unless a request sets its own. |
| `environments.<env>.protection.basicAuth.username` | string |  | Secret with the user name. |
| `environments.<env>.protection.basicAuth.password` | string |  | Secret with the password. |
| `environments.<env>.protection.headers` | map of string |  | Any other headers: header name → the secret holding its value. |
| `environments.<env>.secrets` | map of object |  | Overrides of "secrets" for this environment. |
| `environments.<env>.run` | object |  | Overrides of "run" for this environment. |
| `environments.<env>.models` | object |  | Overrides of "models" for this environment. |
| `environments.<env>.decisions` | object |  | Overrides of "decisions" for this environment. |
| `environments.<env>.android` | object |  | Overrides of "android" for this environment. |

## secrets

| Key | Type | Default | |
|---|---|---|---|
| `secrets` | map of object | `{}` | Secrets the tests may use, by NAME. Values never live in this file. |
| `secrets.<NAME>.domains` | list of string |  | Domains this secret may be typed into. Typing it anywhere else is refused. |
| `secrets.<NAME>.description` | string |  | What the secret is for. |
| `secrets.<NAME>.type` | "text" \| "totp" |  | text (default): typed as it is. totp: the value is a TOTP seed (base32 or an otpauth:// URI); typing it types the current one-time code. |

## run

| Key | Type | Default | |
|---|---|---|---|
| `run` | object |  | How tests run. |
| `run.timeoutSeconds` | integer | `300` | Maximum time for one test, in seconds. |
| `run.retries` | integer | `1` | Extra attempts after a failure before the test is reported as failed. |
| `run.healPolicy` | "strict" \| "review" \| "auto" | `"review"` | strict: never heal; review: propose fixes for approval; auto: apply and flag. |
| `run.mode` | "replay-only" \| "normal" \| "rerecord" | `"normal"` | replay-only: never call AI; normal: AI only when a step breaks; rerecord: record again. |
| `run.evidence` | "full" \| "failures" \| "minimal" |  | full: trace, network log and a screenshot per step for every test. failures: the same is recorded, but a clean pass keeps only its screenshots, video and console. minimal: no trace or network log, screenshots only where a step failed (a retry records full evidence). Default: full in CI, failures elsewhere. |
| `run.budget` | object |  | AI budget caps. |
| `run.budget.maxPerRunUsd` | number | `1` | AI spend cap for one test run, in USD. |
| `run.budget.maxPerSuiteUsd` | number | `10` | AI spend cap for one suite run, in USD. |

## tests

| Key | Type | Default | |
|---|---|---|---|
| `tests` | object |  | Where the test files are. |
| `tests.dir` | string | `"tests"` | Folder with the tests, relative to the project folder. |
| `tests.include` | list of string | `["**/*.test.md"]` | Globs (relative to dir) of the files that are tests or flows. |

## lint

| Key | Type | Default | |
|---|---|---|---|
| `lint` | object |  | Test lint rules. |
| `lint.rules` | map of "off" \| "info" \| "warning" \| "error" | `{}` | Rule levels by id (vague-step, expect-not-observable, no-expectations, soft-only, missing-start, compound-expect, literal-credential, fixed-email, destructive-undeclared, vague-guard, fixed-wait, duplicate-test-name, unused-flow): off, info, warning or error. |
| `lint.strict` | boolean | `false` | Warnings count as errors for the exit code (CI). |

## hooks

| Key | Type | Default | |
|---|---|---|---|
| `hooks` | object |  | Setup and teardown hooks: what run: may start, and where sql: statements go. |
| `hooks.run` | object |  | run: hooks. |
| `hooks.run.allow` | list of string | `[]` | Commands run: hooks may start: a program on the PATH (node, pnpm) or a project path glob (scripts/*). |
| `hooks.run.timeoutSeconds` | number | `60` | Seconds before a run: hook is stopped. |
| `hooks.sql` | object |  | sql: hooks. |
| `hooks.sql.connection` | string |  | The declared secret holding the database connection string. |
| `hooks.sql.client` | "psql" \| "mysql" | `"psql"` | The database client that runs statements: psql (Postgres) or mysql. |
| `hooks.sql.timeoutSeconds` | number | `30` | Seconds before a statement is stopped. |

## models

| Key | Type | Default | |
|---|---|---|---|
| `models` | object |  | AI models. |
| `models.providers` | map of object |  | AI providers, by id. |
| `models.providers.<id>.kind` | "anthropic" \| "openai" \| "google" \| "openai-compatible" \| "azure" \| "bedrock" \| "claude-code" \| "codex" |  | Provider type. |
| `models.providers.<id>.baseUrl` | string |  | API base URL. Required for openai-compatible; optional for others. |
| `models.providers.<id>.keySecret` | string |  | Name of the secret holding the API key. Local servers may have none. |
| `models.providers.<id>.caps` | object |  | Usage caps. At 90% of any cap, calls move to the next provider. |
| `models.providers.<id>.caps.per5h` | object |  |  |
| `models.providers.<id>.caps.per5h.usd` | number |  | Spend cap in USD. |
| `models.providers.<id>.caps.perWeek` | object |  |  |
| `models.providers.<id>.caps.perWeek.usd` | number |  | Spend cap in USD. |
| `models.providers.<id>.caps.perMonth` | object |  |  |
| `models.providers.<id>.caps.perMonth.usd` | number |  | Spend cap in USD. |
| `models.providers.<id>.options` | map of string |  | Provider-specific settings: azure resourceName/apiVersion, bedrock region. |
| `models.providers.<id>.binary` | string |  | claude-code / codex: path to the CLI. Default: found on PATH (claude, codex). |
| `models.roles` | object |  | Ordered pool per role: the first healthy entry answers. |
| `models.roles.planner` | list of object | `[{"provider":"anthropic","model":"claude-sonnet-4-6"},{"provider":"openai","model":"gpt-6-sol"},{"provider":"google","model":"gemini-3.8-flash"},{"provider":"claude-code","model":"claude-sonnet-4-6"},{"provider":"codex","model":"default"}]` | Writes and re-records tests. |
| `models.roles.planner.[].provider` | string |  | Provider id from models.providers. |
| `models.roles.planner.[].model` | string |  | Model id at that provider. |
| `models.roles.fixer` | list of object | `[{"provider":"anthropic","model":"claude-haiku-4-5"},{"provider":"openai","model":"gpt-6-luna"},{"provider":"google","model":"gemini-3.5-flash-lite"},{"provider":"claude-code","model":"claude-haiku-4-5"},{"provider":"codex","model":"default"}]` | Cheap, fast single-step heals. |
| `models.roles.fixer.[].provider` | string |  | Provider id from models.providers. |
| `models.roles.fixer.[].model` | string |  | Model id at that provider. |
| `models.prices` | map of object | `{}` | Price overrides by model id, USD per million tokens. |
| `models.prices.<model>.input` | number |  |  |
| `models.prices.<model>.output` | number |  |  |
| `models.prices.<model>.cachedInput` | number |  |  |
| `models.prices.<model>.cacheWrite` | number |  |  |
| `models.timeoutSeconds` | number | `120` | Maximum time for one model request. |
| `models.allowDelegated` | boolean | `true` | Allow claude-code / codex (your own AI subscription through its CLI). The cloud sets false. |
| `models.delegatedCallsPerRun` | integer | `60` | Most calls one run may make through each subscription CLI (plans assume ordinary individual use). |

## decisions

| Key | Type | Default | |
|---|---|---|---|
| `decisions` | object |  | The decision layer: rules first, a decision model second. |
| `decisions.backend` | "auto" \| "none" \| "jev" \| "kev" \| "laya" | `"auto"` | Decision model behind the rules. auto: Jev if its key is set, else rules only. none: rules only. |
| `decisions.during` | "auto" \| "none" \| "jev" \| "kev" \| "laya" | `"auto"` | During-run decisions. auto: what `backend` names, else rules only. |
| `decisions.after` | "auto" \| "none" \| "jev" \| "kev" \| "laya" | `"auto"` | After-run decisions. auto: what `backend` names, else Jev when its key is set, else rules only. |
| `decisions.skipAfterTimeouts` | integer | `3` | Stop calling a backend for a task after this many timeouts in one run. |
| `decisions.jev` | object |  | Jev, hosted by TypeSafe AI. |
| `decisions.jev.baseUrl` | string | `"https://api.typesafe.ai"` | Scheme, host and optional port. Requests go only to this host. |
| `decisions.jev.model` | string | `"jev-latest"` | Model name sent with every request. |
| `decisions.jev.keySecret` | string | `"JEV_API_KEY"` | Secret holding the bearer key (leave unset when no key is needed). |
| `decisions.jev.priceUsdPerMillionInputTokens` | number | `0.042` | USD per million input tokens, for the run cost. |
| `decisions.jev.expectedLatencyMs` | integer | `400` | Typical latency of one request; a task with a shorter time limit never calls this backend. |
| `decisions.kev` | object |  | Kev, open models you host (System One API). |
| `decisions.kev.baseUrl` | string | `"http://127.0.0.1:8009"` | Scheme, host and optional port. Requests go only to this host. |
| `decisions.kev.model` | string | `"kev-latest"` | Model name sent with every request. |
| `decisions.kev.keySecret` | string |  | Secret holding the bearer key (leave unset when no key is needed). |
| `decisions.kev.priceUsdPerMillionInputTokens` | number | `0` | USD per million input tokens, for the run cost. |
| `decisions.kev.expectedLatencyMs` | integer | `500` | Typical latency of one request; a task with a shorter time limit never calls this backend. |
| `decisions.laya` | object |  | Laya, run locally through Ollaya. |
| `decisions.laya.baseUrl` | string | `"http://127.0.0.1:11435"` | Scheme, host and optional port. Requests go only to this host. |
| `decisions.laya.model` | string | `"laya:typed-decisions"` | Model name sent with every request. |
| `decisions.laya.keySecret` | string |  | Secret holding the bearer key (leave unset when no key is needed). |
| `decisions.laya.priceUsdPerMillionInputTokens` | number | `0` | USD per million input tokens, for the run cost. |
| `decisions.laya.expectedLatencyMs` | integer | `90` | Typical latency of one request; a task with a shorter time limit never calls this backend. |
| `decisions.laya.keepAlive` | string | `"30m"` | How long Ollaya keeps the model loaded between decisions. |
| `decisions.laya.warmUpTimeoutMs` | integer | `15000` | Time allowed for the warm-up decision at run start (model load). |
| `decisions.threshold` | number | `0.8` | Minimum confidence to act on a decision; below it the decision escalates. |
| `decisions.tasks` | map of object | `{}` | Per-task overrides by task name. |
| `decisions.tasks.<task>.enabled` | boolean |  | False turns the task off (it escalates). |
| `decisions.tasks.<task>.threshold` | number |  | Minimum confidence for this task. |
| `decisions.tasks.<task>.timeLimitMs` | integer |  | Hard time limit for one decision, in milliseconds. |
| `decisions.cache` | object |  | Decision cache under the project data folder. |
| `decisions.cache.enabled` | boolean | `true` | Reuse decision model answers for the same input. |
| `decisions.cache.ttlSeconds` | integer | `604800` | How long a cached answer stays valid. |

## auth

| Key | Type | Default | |
|---|---|---|---|
| `auth` | object |  | Login profiles and saved sessions. |
| `auth.profiles` | map of object |  | Named logins a test picks with auth: `<name>`. |
| `auth.profiles.<profile>.flow` | string |  | The flow that logs in, relative to tests.dir. |
| `auth.profiles.<profile>.params` | map of string | `{}` | Params passed to the flow. |
| `auth.profiles.<profile>.check` | object |  | How to tell a saved session still works. |
| `auth.profiles.<profile>.check.url` | string |  | A page only a logged-in user can open. |
| `auth.profiles.<profile>.check.text` | string |  | Text that must be on that page. |
| `auth.profiles.<profile>.reuse` | "per-worker" \| "shared" | `"per-worker"` | per-worker: one saved session per parallel worker; shared: one for all. |
| `auth.profiles.<profile>.ttlMinutes` | integer | `60` | A saved session is used for at most this many minutes. |
| `auth.totp` | object |  | TOTP secrets (type: totp). |
| `auth.totp.minRemainingSeconds` | integer | `5` | Wait for the next code when the current one expires sooner than this. |

## inbox

| Key | Type | Default | |
|---|---|---|---|
| `inbox` | object |  | Test email inboxes. |
| `inbox.provider` | "none" \| "mailpit" \| "mailosaur" \| "mailslurp" | `"none"` | Where test emails arrive. |
| `inbox.timeoutSeconds` | number | `60` | How long a test waits for an email, in seconds. |
| `inbox.mailpit` | object |  | Mailpit (local or CI). |
| `inbox.mailpit.url` | string | `"http://127.0.0.1:8025"` | Mailpit's web/API address. |
| `inbox.mailpit.domain` | string | `"example.test"` | Domain for generated addresses. |
| `inbox.mailosaur` | object |  | Mailosaur (hosted). |
| `inbox.mailosaur.baseUrl` | string | `"https://mailosaur.com"` |  |
| `inbox.mailosaur.serverId` | string |  | Your Mailosaur server id. |
| `inbox.mailosaur.keySecret` | string | `"MAILOSAUR_API_KEY"` | Secret holding the API key. Sent only to this provider's host. |
| `inbox.mailslurp` | object |  | MailSlurp (hosted). |
| `inbox.mailslurp.baseUrl` | string | `"https://api.mailslurp.com"` |  |
| `inbox.mailslurp.inboxId` | string |  | An existing inbox to reuse. |
| `inbox.mailslurp.keySecret` | string | `"MAILSLURP_API_KEY"` | Secret holding the API key. Sent only to this provider's host. |

## android

| Key | Type | Default | |
|---|---|---|---|
| `android` | object |  | Android runs: version and device profile (Android projects). |
| `android.version` | string | `"16"` | Android version the tests run on. |
| `android.device` | string | `"pixel-8"` | Device profile the tests run on (screen size and density). |
