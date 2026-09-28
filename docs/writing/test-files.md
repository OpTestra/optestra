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
| `dataset` | path to a `.csv` or `.json` file | Parsed only; data-driven runs come later. |
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

Today only `request` hooks run. They go through the browser harness, so they are checked against the [allowed domains](../environments.md#allowed-domains), follow no redirects and carry the session's cookies. A `run` or `sql` hook stops the test with `hook_unsupported` (the generated Playwright spec skips it with the reason).

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
