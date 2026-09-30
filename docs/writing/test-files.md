# Test files

A test is a Markdown file ending in `.test.md`, in the project's tests folder (`tests/` by default). One test per file. The same format is used for websites and Android apps.

```markdown
---
name: New customer can start a Pro trial
tags: [smoke, payments]
start: /pricing
auth: none
data:
  email: "{{unique.email}}"
timeout: 3m
---

1. Click "Start free trial" on the Pro plan
2. Sign up with {{data.email}} and password {{secret.SHOP_PASSWORD}}
3. Expect: the page heading is "Check your email"
4. Use: flows/verify-email.test.md { email: "{{data.email}}" }
5. Exact: expect url contains /dashboard
6. Soft: the welcome illustration looks right

Never: click "Delete account"
```

Above the second `---` is the **frontmatter**: YAML settings for this test. Below it are the **steps**, one per numbered line: see [Steps](./steps.md).

Reading a test uses no AI: the same file and inputs always give the same result and the same step keys, on every OS. Mistakes never stop the whole project from loading: each one is a problem with a code, a message, the exact fix and its line and column. `%cli% lint` and the editor show them; `%cli% show <file>` prints the test as the engine reads it (`--expanded` inlines flows and fills in variables, secrets stay `{{secret.NAME}}`).

## Frontmatter

Unknown keys are a warning (`UNKNOWN_KEY`) and are kept.

| Field | Value | Notes |
|---|---|---|
| `name` | text, **required** | What the test checks. Results, reports and PR comments show tests by name. |
| `kind` | `test` (default) or `flow` | [Flows](./flows.md) are reusable pieces included with `Use:`. They are not listed as runnable tests. |
| `params` | map name → default | Flows only. An empty value (`email:`) means required. |
| `tags` | list, e.g. `[smoke, payments]` | For filtering: `%cli% run --tag smoke`, `%cli% list --tag smoke`. |
| `start` | text | Where the test starts: a path (`/pricing`), an absolute URL, or for Android a screen or deep link. May contain variables. |
| `auth` | text | An [auth profile](../auth.md) name (the test starts logged in), or `none` (start logged out). Without it, the test does its own logging in. |
| `data` | map name → value | Values for `{{data.name}}`: see [Variables](./variables.md). |
| `setup`, `teardown` | list of hooks | Run outside the UI, before and after the steps. See below. |
| `timeout` | `"90s"`, `"3m"`, `"1h"` | The test's time limit. A bare number is an error. Default: `run.timeoutSeconds` (300). |
| `heal` | `strict`, `review` or `auto` | The [fix policy](../runs/healing.md#policies) for this test. Default: `run.healPolicy`. |
| `allowDestructive` | list from `delete pay send invite cancel` | Destructive actions this test may do in a [production environment](../environments.md#production-mode). |
| `dataset` | path to a `.csv` or `.json` file | Run the test once per row, relative to the test file. See [Datasets](#datasets). |
| `environments` | map env name → `{ start, data, timeout }` | Per-environment overrides. `data` merges key by key. |

### Setup and teardown hooks

```yaml
# frontmatter
setup:
  - request: POST /__test/seed
    body: { trial: pro }
teardown:
  - request: DELETE /__test/carts
```

Each hook is one of `request: "METHOD path"` (with optional `body` and `headers`), `run: <script>` or `sql: <statement>`. Methods: GET POST PUT PATCH DELETE HEAD OPTIONS; the path starts with `/` or is an http(s) URL.

`request` hooks go through the browser harness, so they are checked against the [allowed domains](../environments.md#allowed-domains), follow no redirects and carry the session's cookies.

`run` and `sql` hooks are declared, scoped and safe:

- **`run: <script>`** starts one command from the project folder, with no shell (pipes, redirects and `$VARS` are refused: put them in a script file). The command must be listed in the project file's `hooks.run.allow`: a program on the PATH (`node`, `pnpm`) or a project path glob (`scripts/*`); a path can't lead outside the project, not even through a link. It gets the project's secrets as environment variables, and it is stopped after `hooks.run.timeoutSeconds` (60). Its output is scrubbed, so a secret it prints shows as `[secret:NAME]`.
- **`sql: <statement>`** runs one statement through the database's own client, `psql` or `mysql` (`hooks.sql.client`), against the connection string in the secret named by `hooks.sql.connection`. The connection goes to the client in its environment (`PGPASSWORD`, `MYSQL_PWD`), never on its command line or in output. It never runs in a [production environment](../environments.md#production-mode) unless the hook says `production: true`. The client must be installed; there is no built-in database driver.

```yaml
# the project file
hooks:
  run:
    allow: ["scripts/*"]
    timeoutSeconds: 60
  sql:
    connection: TEST_DATABASE_URL
    client: psql
```

```yaml
# frontmatter
setup:
  - run: scripts/seed.js --plan pro
  - sql: DELETE FROM carts WHERE owner = 'ada@example.com'
teardown:
  - run: scripts/cleanup.js
```

A setup hook that fails stops the test: blocked `config_error` when it isn't allowed, `missing_secret` without its connection, `setup_failed` when it runs and fails. **Teardown hooks always run**, after a failure too; their failures are logged as warnings. The generated Playwright spec runs `request` hooks and skips `run` and `sql` ones with the reason.

### Datasets

```yaml
# frontmatter
dataset: data/projects.csv
```

```csv
project,owner
Q3 roadmap,ada@example.com
"Budget, 2027",{{unique.email}}
```

The test runs once per row, each column bound as `{{data.<column>}}` (a column replaces a `data` value of the same name, and a cell may use `{{unique.email}}`). A CSV file has a header row; a JSON file is an array of flat objects (text, numbers, true/false). Each row is its own result, `<test id>#<row>` (named `<name> #<row>`); every row replays the test's one recording, so only the first run of a new test spends AI. Up to 200 rows.

A dataset that can't be read blocks the test with the reason and the fix: `DATASET_NOT_FOUND`, `DATASET_EMPTY`, or `DATASET_INVALID` (a row with the wrong number of values, a column name that can't be `{{data.x}}`, a `{{data.x}}` the test uses that no column or `data` value defines).

### Per-environment overrides

```yaml
# frontmatter
environments:
  staging:
    start: https://staging.example.com/pricing
    timeout: 5m
    data:
      email: staging-user@example.com
```

## Canonical form

The editors, **Format** and every file %Name% writes use one canonical text: frontmatter keys in the order of the table above, lists of words as `[a, b]`, durations in the largest exact unit (`120s` becomes `2m`), one blank line after the frontmatter, one line per step with `N. ` numbers, canonical prefixes (`Expect:`, `Soft:`, `Never:`, `Use:`, `Exact:`), LF line endings and a final newline. Comments (`<!-- … -->`) and stray text are kept as written; YAML comments inside the frontmatter are not.

## Problems a test file can have

| Code | Severity | When |
|---|---|---|
| `FRONTMATTER_MISSING` | error | The file does not start with `---`. |
| `FRONTMATTER_UNCLOSED` | error | No closing `---`. |
| `YAML_SYNTAX` | error | The frontmatter is not valid YAML. |
| `YAML_DUPLICATE_KEY` | error | A key appears twice. |
| `FRONTMATTER_NOT_OBJECT` | error | The frontmatter is not `key: value` fields. |
| `UNKNOWN_KEY` | warning | Not a known field (kept, ignored). |
| `REQUIRED_MISSING` | error | No `name`. |
| `INVALID_VALUE` | error | A field has the wrong type or value (e.g. `timeout: 90`, `tags: smoke`). |
| `HOOK_INVALID` | error | A setup/teardown hook is malformed. |
| `DATASET_NOT_FOUND` | error | The dataset file doesn't exist (found when the test runs). |
| `DATASET_EMPTY` | error | The dataset has no rows. |
| `DATASET_INVALID` | error | The dataset can't be used: see [Datasets](#datasets). |
| `PARAMS_OUTSIDE_FLOW` | error | `params:` or `{{params.x}}` in a test. |
| `NO_STEPS` | warning | No steps (guards don't count). |
| `TEXT_OUTSIDE_STEPS` | warning | Text that is not a step or a comment. |
| `STEP_NUMBER_ORDER` | warning | A step number is not the previous + 1. |
| `STEP_EMPTY` | error | `3.` or `3. Expect:` with nothing after it. |
| `USE_SYNTAX` | error | `Use:` params are not an inline map of single values. |
| `EXACT_SYNTAX` | error | An `Exact:` line does not follow the grammar. |
| `EXACT_CODE_LANG` | error | A code block is not ` ```ts `. |
| `FENCE_UNCLOSED` | error | A code block never closes. |
| `TEMPLATE_UNCLOSED` | error | `{{` without `}}`. |
| `TEMPLATE_SYNTAX` | error | `{{…}}` that is not `{{namespace.name}}`. |
| `VAR_NAMESPACE_UNKNOWN` | error | Not one of data, env, secret, params, unique, faker, inbox. |
| `VAR_MEMBER_UNKNOWN` | error | Not a known `unique.*`, `faker.*` or `inbox.*` member. |
| `VAR_UNDEFINED` | error | `{{data.x}}` or `{{params.x}}` that is not defined. |
| `SECRET_NAME_INVALID` | error | A secret name that is not UPPER_SNAKE_CASE. |
| `SECRET_UNDECLARED` | error | A secret not declared in the project file. |
| `DATA_CYCLE` | error | Data values refer to each other in a loop. |
| `ENV_UNDEFINED` | error | `{{env.X}}` not in the environment's `vars`. |
| `FLOW_NOT_FOUND` | error | The `Use:` path does not exist. |
| `FLOW_NOT_A_FLOW` | error | The included file is a test (`kind: flow` missing). |
| `FLOW_CYCLE` | error | Flows include each other in a loop. |
| `FLOW_DEPTH` | error | Flows nested more than 8 deep. |
| `FLOW_PARAM_MISSING` | error | A required param is not passed (or has no default when the flow runs alone). |
| `FLOW_PARAM_UNKNOWN` | error | A passed param the flow does not declare. |
| `TESTS_DIR_MISSING` | warning | The tests folder does not exist. |
| `LINT` | per rule | A [lint rule](./lint.md) finding. |
| `LINT_RULE_UNKNOWN` | warning | `lint.rules` names a rule that doesn't exist. |

## Where tests live

```yaml
tests:
  dir: tests               # relative to the project folder
  include: ["**/*.test.md"] # globs relative to dir: ** * ? {a,b}
```

Test ids come from the path with the whole `.test.md` suffix dropped: `tests/login.test.md` is `tests__login`. Files are found in sorted order, skipping `node_modules` and dot folders.
