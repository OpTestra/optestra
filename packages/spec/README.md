# @testament/spec

The test file format: `.test.md` files turned into a typed, validated model
that every later phase runs from, plus the lint rules and the editor language
service. This README is the file-format and lint reference (the WEB-1 docs are
built from it).

Parsing is deterministic and uses no AI: the same file and inputs give the same
model and the same step keys on every OS. Secrets are never resolved here.
User mistakes never throw: each one is a diagnostic with a code, severity,
message, exact fix, file and line/column range.

## Entry points

| Import | Use | Runs in |
|---|---|---|
| `@testament/spec` | `parseTest`, `expandTest`, `printTest`, the model types, diagnostics, generators, `textKey`, globs; `checkTest`, `lintTest`, `lintProject`, the lint rules; `createLanguageService`. Registers the `tests` and `lint` config sections | browser and Node |
| `@testament/spec/node` | `loadTests`, `loadTest`, `findTestFiles`, `nodeFileReader` | Node |
| `@testament/spec/lint-words.yaml` | the word lists and patterns behind the lint rules | data |

The main entry imports only `yaml`, `zod`, `@testament/config` and
`@testament/contract` (a test enforces it). Flow files are read through a
`FileReader` callback, so the web app can run parsing and expansion against
files stored in the cloud.

```ts
import { expandTest, mapReader, parseTest, printTest } from "@testament/spec";

const { spec, diagnostics } = parseTest(text, "tests/checkout.test.md", { config });
const expanded = await expandTest(spec, {
  readFile: mapReader(files),        // or nodeFileReader(projectDir), or the cloud store
  seed: `${runId}/${worker}`,        // generated values differ per run and worker
  environment: "staging",            // frontmatter overrides
  vars: config.environments.staging.vars, // {{env.X}}
});
const text2 = printTest(spec);       // canonical text
```

```ts
import { loadTests } from "@testament/spec/node";
const { tests, flows, diagnostics } = await loadTests(projectDir, config); // config may be undefined
```

## A test file

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

One test per file. The same format is used for websites and Android.

## Frontmatter

YAML between two `---` lines at the top of the file. Unknown keys are a
warning (`UNKNOWN_KEY`) and are kept when printing.

| Field | Value | Notes |
|---|---|---|
| `name` | text, **required** | What the test checks. |
| `kind` | `test` (default) or `flow` | Flows are reusable pieces included with `Use:`; they are loadable but not listed as runnable tests. |
| `params` | map name → default | Flows only. An empty value (`email:`) means required. Defaults may use `data`, `env`, `secret`, `unique`, `faker`. |
| `tags` | list, e.g. `[smoke, payments]` | For filtering (`list --tag`). |
| `start` | text | A path (`/pricing`), an absolute URL, or for Android a screen or deep link. May contain variables. A flow's `start` is used only when the flow runs on its own; when included it is ignored. |
| `auth` | text | An auth profile name, or `none`. |
| `data` | map name → value | Values for `{{data.name}}`. One value each (text, number, true/false). Values may use other data, `env`, `secret`, `unique` and `faker`; they are resolved in dependency order and loops are an error. |
| `setup`, `teardown` | list of hooks | AUT-10, run outside the UI (execution comes later). Each hook is one of `request: "METHOD path"` (with optional `body` and `headers`), `run: <script>` or `sql: <statement>`. Methods: GET POST PUT PATCH DELETE HEAD OPTIONS; the path starts with `/` or is an http(s) URL. |
| `timeout` | `"90s"`, `"3m"`, `"1h"` | Stored in seconds; a bare number is an error. |
| `heal` | `strict`, `review` or `auto` | HEAL-5 fix policy for this test. |
| `allowDestructive` | list from `delete pay send invite cancel` | SAF-4: destructive actions this test may do in production mode. |
| `dataset` | path to a `.csv` or `.json` file | AUT-9 (parsed only). |
| `environments` | map env name → `{ start, data, timeout }` | Per-environment overrides. `data` merges key by key. |

```yaml
setup:
  - request: POST /__test/seed
    body: { trial: pro }
  - run: scripts/seed.sh
  - sql: DELETE FROM carts WHERE user = 'ada'
environments:
  staging:
    start: https://staging.example.com/pricing
    timeout: 5m
    data:
      email: staging-user@example.com
```

## Steps

The body is line-based. Numbered lines are steps; indented lines right after a
step continue it (they are joined with a space). Steps run in file order; the
number is for display, and out-of-order or skipped numbers are a warning.

| Line | Step kind (contract `StepKind`) | |
|---|---|---|
| `1. Click "Save"` | `action` | Plain English. |
| `2. Expect: the heading is "Saved"` | `expect` | Becomes a real check. Kept verbatim with its position; nothing rewrites, merges or drops an expectation. |
| `3. Soft: the chart looks reasonable` | `soft` | VER-3: warns when it fails, never makes a test pass alone. |
| `Never: click "Delete account"` | `guard` | May be numbered or unnumbered and appear anywhere; applies to the whole test. |
| `4. Use: flows/login.test.md { email: "{{data.admin}}" }` | `flow` | Includes a flow. See below. |
| `5. Exact: click role=button[name="Save"]` | `exact` | The fixed syntax below. |
| a fenced ` ```ts ` block right after a step line | `exact` | Code kept verbatim, executed later (LOOP), never here. |
| `<!-- … -->` | — | A comment, kept when printing. |

Prefixes are case-insensitive (`expect:` works) and are printed as `Expect:`,
`Soft:`, `Never:`, `Use:`, `Exact:`. Any other non-empty text outside steps is a
warning (`TEXT_OUTSIDE_STEPS`) and is kept when printing. A step that cannot be
parsed (for example a bad `Exact:` line) is kept as text too.

Code step:

````markdown
3. Pick the delivery date
   ```ts
   await page.getByLabel("Date").fill("2031-01-31");
   ```
4. ```ts
   await page.keyboard.press("Escape");
   ```
````

The text before the fence is the step's label. Code lines keep their own
indentation relative to the fence.

## Exact steps (AUT-3)

`Exact: <op>`:

| Op | Example |
|---|---|
| `goto <url>` | `Exact: goto /settings` |
| `click <locator>` | `Exact: click role=button[name="Save"]` |
| `fill <locator> with <value>` | `Exact: fill label="Email" with {{data.email}}` |
| `select <option> in <locator>` | `Exact: select "Europe/London" in label="Time zone"` |
| `press <key>` | `Exact: press Enter`, `Exact: press Control+A` |
| `expect url contains\|is <value>` | `Exact: expect url contains /dashboard` |
| `expect <locator> text\|contains "<value>"` | `Exact: expect role=heading text "Welcome to Pro"` |
| `expect <locator> visible\|hidden\|enabled\|disabled` | `Exact: expect text="Saved" visible` |
| `expect <locator> count <n>` | `Exact: expect css=.order-row count 5` |

Locators: `role=button[name="Save"]` (or just `role=heading`), `label="Email"`,
`testid=save`, `text="Save"`, `placeholder="Search"`, `css=.selector`. Quoted
values allow `\"` and `\\`; bare values stop at a space. `<value>`, `<option>`
and `<url>` are `"quoted"` or the rest of the line (`select` stops before ` in
<locator>`). Values may contain variables. Anything else is `EXACT_SYNTAX` at the
exact position.

## Variables (AUT-4)

`{{namespace.name}}`, spaces inside the braces allowed (`{{ data.email }}`).
Write `\{{` for literal braces.

| Namespace | Meaning |
|---|---|
| `data.x` | From the frontmatter `data` (or the environment override). |
| `env.X` | The selected environment's `vars` in the project settings. |
| `secret.X` | A credential, UPPER_SNAKE_CASE. **Never resolved by this package**: it stays a typed reference and only the browser/Android driver fills it in (SEC-1). With a project config, it must be declared there. |
| `params.x` | Flows only: a param of this flow. |
| `unique.email`, `unique.id`, `unique.name` | Fresh values per run (ENV-3). `unique.email` uses `example.test` unless `emailDomain` is set. |
| `faker.name`, `faker.firstName`, `faker.lastName`, `faker.email`, `faker.company`, `faker.phone`, `faker.city` | Realistic values from small built-in word lists. |

Generated values are deterministic: each depends on the run `seed`, the test id
and where it is used (the data key, or the step's key). Same seed, same values;
include the run id and worker in the seed so runs and workers differ. To reuse
one value in several steps, put it in `data`. More generators can be added with
`new GeneratorRegistry().register("unique.slug", fn)` and passed as
`generators`, without parser changes.

## Flows (AUT-5)

```markdown
---
name: Log in
kind: flow
params:
  email: ada@example.com
  password: "{{secret.SHOP_PASSWORD}}"
start: /login
---

1. Fill "Email" with {{params.email}}
2. Fill "Password" with {{params.password}}
3. Click "Log in"
```

`Use: <path> { name: value, … }` inlines the flow's steps, recursively.

- The path is relative to the including file, then to the tests folder
  (`tests.dir`). A leading `/` means the project root. Paths never leave the project.
- Caller params are evaluated in the caller's scope and override defaults. A
  missing required param (`FLOW_PARAM_MISSING`) or an unknown one
  (`FLOW_PARAM_UNKNOWN`) is an error. Params values are one value each.
- A flow sees its own `data` and `params`, not the caller's `data`.
- The flow's `start` is ignored when included. Its guards join the test.
- Loops are `FLOW_CYCLE`; nesting deeper than 8 (`maxDepth`) is `FLOW_DEPTH`.
- Every expanded step keeps its origin: the `Use:` steps that led to it
  (file, line, number, range), then its own position, and its `flowPath`.

## Expanded model

`expandTest(spec, ctx)` returns an `ExpandedTest`: id (from the contract's
`testIdFromPath`), frontmatter values after environment overrides, bound `data`
(and `params` for a flow run on its own), `steps` and `guards` as
`ExpandedStep`s, the `files` it read, and the problems it found in the test and
its flows. Each `ExpandedStep` has `kind`, `number`, `text` (as written), `bound`
segments, `display` (values filled in, secrets shown as `{{secret.NAME}}`),
`textKey`, `flowPath`, `origin`, and for exact steps the op with bound values or
the code.

Bound segments: `{ kind: "text" }`, `{ kind: "value", ref: "data.email", text }`,
`{ kind: "secret", name }`, `{ kind: "unresolved", ref: "env.X" }` (env vars not
passed in).

## Step keys (REP-4, REP-7)

Each expanded step has a `textKey`: FNV-1a 64-bit hex of
`["k1", kind, flowChain, normalizedText, occurrence]`.

- `normalizedText`: whitespace collapsed, curly/single quotes and backticks
  turned into `"`, variable references written `{{ns.name}}` by name. Values
  never enter the key, so one recorded login works for many test users.
- `flowChain`: the flows the step came through, outermost first.
- `occurrence`: 0, 1, … for steps with the same kind, chain and text.

Inserting, removing or rewording a step changes no other step's key, except
that inserting a step identical to a later one shifts that one's occurrence.
Step numbers do not enter the key. The recording layer (LOOP) combines
`textKey` + route/screen + engine version into the contract's `StepResult.key`;
this package never sees routes. Changing the recipe means bumping
`TEXT_KEY_VERSION`.

## Printing

`printTest(spec)` writes the canonical text; the desktop editor, "Describe it"
and Record mode write files through it. `parseTest(printTest(x))` equals `x`
apart from source positions (`withoutSource`), and printing a canonical file
gives it back byte for byte. Canonical form:

- frontmatter keys in the order of the table above (`FRONTMATTER_KEYS`), lists
  of words as `[a, b]`, maps inside hooks as `{ k: v }`, durations in the
  largest exact unit (`120s` → `2m`), empty fields left out;
- one blank line after the frontmatter; runs of blank lines collapsed; no
  trailing blank lines; LF line endings and a final newline;
- one line per step (continuation lines joined), `N. ` numbers, canonical
  prefixes and exact ops, code blocks indented under their step;
- comments and stray text kept as written. YAML comments inside the frontmatter
  are not kept.

## Project loading (`/node`)

The `tests` config section (registered when this package loads; defaults in
`@testament/config`'s `defaults.yaml`):

```yaml
tests:
  dir: tests               # relative to the project folder
  include: ["**/*.test.md"] # globs relative to dir: ** * ? {a,b}
```

Test ids come from the contract's `testIdFromPath`, which drops the whole
`.test.md` suffix: `tests/login.test.md` → `tests__login`.

`loadTests(projectDir, config, { environment, seed })` finds the files (sorted,
skipping `node_modules` and dot folders), parses and expands each, and returns
`tests` (`kind: test`) and `flows` separately. Pass `config: undefined` for a
folder without a project file: default settings, secrets not checked.

CLI: `list [--tag t] [--env e] [--json]` and `show <file> [--expanded] [--env e]
[--seed s] [--json]`. Both exit 2 when there is any error. `lint` is below.

## Lint (AUT-6)

Vague tests produce meaningless passes: "Expect: it works" can't fail, so it
proves nothing. Lint is the first defence, before any AI is involved. It is
rule-based and deterministic (same file + same config → same findings), and
runs in the browser too.

```ts
import { checkTest } from "@testament/spec";

const { spec, expanded, findings } = await checkTest(text, "tests/checkout.test.md", {
  readFile, config, environment: "staging",
});
```

`checkTest` is the one answer every caller gives: parse, expand and lint
problems in one sorted list. Each finding is a Diagnostic (below) plus:

- `rule`: the lint rule id (absent for parse and expansion problems, whose
  `code` says what they are; lint findings have `code: "LINT"`);
- `fixes`: `[{ title, edits: [{ range, newText }], safe }]`.

`lintTest(spec, { expanded, text, config })` runs just the per-file rules and
`lintProject(files, config)` the project-level ones (duplicate names, unused
flows). `applySafeFixes(text, check)` applies safe fixes until none is left.

**Expectations are never auto-edited (HEAL-3).** A fix that touches an
`Expect:`, `Soft:`, `Never:` or exact `expect` line is never `safe`, whatever the
rule says; it can be offered in the editor for the user to apply by hand. A
property test checks this over many generated files, and that `--fix` is
idempotent.

Word lists and patterns are data, in `lint-words.yaml` (English; Android verbs
like tap and swipe count like web verbs). After editing it run
`pnpm --filter ./packages/spec gen:words`; a test fails if you forget. Callers
may also pass their own `words`.

### Settings

```yaml
lint:
  rules:                  # per rule: off | info | warning | error
    compound-expect: off
    fixed-wait: error
  strict: false           # true: warnings fail the exit code too (CI)
```

Unknown rule ids get a `LINT_RULE_UNKNOWN` warning.

### CLI

`lint [paths…] [--json] [--fix] [--strict] [--env e]`: files or folders
(default: every test and flow in the project). Output is grouped by file, one line
per finding (`file:line:col  severity  rule  message`), then a summary. `--fix`
applies only safe fixes and prints what it changed.

| Exit | When |
|---|---|
| 0 | no errors |
| 1 | a lint error, or a warning with `--strict` / `lint.strict` |
| 2 | a file can't be parsed or expanded, a path doesn't exist, or the project settings have errors |

### Rules

<!-- lint-rules:start (generated by `pnpm --filter ./packages/spec gen:rule-docs`) -->
| Rule | Default | What it catches |
|---|---|---|
| [`vague-step`](#vague-step) | warning | A step that doesn't say exactly what to do. |
| [`expect-not-observable`](#expect-not-observable) | warning | An Expect: with nothing a check could look at. |
| [`no-expectations`](#no-expectations) | error | A test with no real check. |
| [`soft-only`](#soft-only) | error | Every check is Soft:, so the test can never fail. |
| [`missing-start`](#missing-start) | warning | The test doesn't say where it starts. |
| [`compound-expect`](#compound-expect) | info | One Expect: checks several things. |
| [`literal-credential`](#literal-credential) | warning | A password or token written into the test. |
| [`fixed-email`](#fixed-email) | info | A fixed email address in a sign-up. |
| [`destructive-undeclared`](#destructive-undeclared) | warning | A destructive step (delete, pay, send, invite, cancel) that the test doesn't declare. |
| [`vague-guard`](#vague-guard) | warning | A Never: that names nothing specific. |
| [`fixed-wait`](#fixed-wait) | warning | A fixed wait like "Wait 5 seconds". |
| [`duplicate-test-name`](#duplicate-test-name) | warning | Two tests with the same name. |
| [`unused-flow`](#unused-flow) | info | A flow no test uses. |

### vague-step

**warning.** A step that doesn't say exactly what to do. A step like "Log in normally" or "Click it" can be done many ways, so a pass proves little and the recording may do the wrong thing.

Bad:

```markdown
1. Log in normally
```

Good:

```markdown
1. Fill "Email" with {{data.email}}
2. Fill "Password" with {{secret.TEST_PASSWORD}}
3. Click "Log in"
```

### expect-not-observable

**warning.** An Expect: with nothing a check could look at. "Expect: it works" names nothing on the screen, so it can't fail: the test passes even when the app is broken.

Bad:

```markdown
5. Expect: it works
```

Good:

```markdown
5. Expect: the page heading is "Order confirmed"
```

### no-expectations

**error.** A test with no real check. Without an Expect: that looks at something, the test only proves that the steps could be clicked through, not that the app did the right thing.

Bad:

```markdown
1. Click "Start trial"
2. Fill the card form
```

Good:

```markdown
1. Click "Start trial"
2. Fill the card form
3. Expect: the page heading is "Welcome to Pro"
```

### soft-only

**error.** Every check is Soft:, so the test can never fail. Soft checks only warn (VER-3). A test whose only checks are soft passes no matter what the app does.

Bad:

```markdown
3. Soft: the dashboard looks right
```

Good:

```markdown
3. Expect: the page heading is "Dashboard"
4. Soft: the chart looks reasonable
```

### missing-start

**warning.** The test doesn't say where it starts. Without a start page (or a first step that navigates), the test begins wherever the browser happens to be, which changes from run to run.

Bad:

```markdown
---
name: Profile is saved
---

1. Fill "Full name" with Ada
```

Good:

```markdown
---
name: Profile is saved
start: /settings
---

1. Fill "Full name" with Ada
```

Fix: Adds "start: /" to the frontmatter for you to complete (not applied automatically).

### compound-expect

**info.** One Expect: checks several things. When one line checks two things and fails, the verdict can't say which one broke. One check per line points at the exact problem.

Bad:

```markdown
4. Expect: the page shows "Pro plan" and the URL contains /billing
```

Good:

```markdown
4. Expect: the page shows "Pro plan"
5. Expect: the URL contains /billing
```

Fix: Offers to split it into one Expect: per line (never applied automatically).

### literal-credential

**warning.** A password or token written into the test. Test files are shared, committed and shown to the AI. Credentials belong in secrets, which the driver types in without anyone seeing them (SEC-1).

Bad:

```markdown
2. Fill "Password" with hunter2hunter2
```

Good:

```markdown
2. Fill "Password" with {{secret.TEST_PASSWORD}}
```

Fix: Offers to replace it with {{secret.NAME}}; you then declare NAME in the project's secrets.

### fixed-email

**info.** A fixed email address in a sign-up. A sign-up with the same email every time fails as soon as two runs overlap, or on the second run (ENV-3). A generated address is new each run.

Bad:

```markdown
1. Fill "Email" with ada@example.com
2. Click "Sign up"
```

Good:

```markdown
data:
  email: "{{unique.email}}"
…
1. Fill "Email" with {{data.email}}
2. Click "Sign up"
```

Fix: Adds `email: "{{unique.email}}"` to data and uses {{data.email}} in the steps. Applied by --fix when the address appears in no Expect:, Soft: or Never: line.

### destructive-undeclared

**warning.** A destructive step (delete, pay, send, invite, cancel) that the test doesn't declare. In production environments, destructive actions are blocked unless the test declares them (SAF-4). Undeclared, this step will be Blocked there.

Bad:

```markdown
3. Click "Delete project"
```

Good:

```markdown
allowDestructive: [delete]
…
3. Click "Delete project"
```

Fix: Offers to add the action to allowDestructive (never applied automatically: it is a safety decision).

### vague-guard

**warning.** A Never: that names nothing specific. "Never: break anything" can't be enforced: the agent needs a concrete action or element to avoid.

Bad:

```markdown
Never: break anything
```

Good:

```markdown
Never: click "Delete account"
```

### fixed-wait

**warning.** A fixed wait like "Wait 5 seconds". Fixed waits are the most common cause of flaky tests: too short on a slow day, wasted time on a fast one. Runs learn how long each step needs to settle (LRN-4).

Bad:

```markdown
4. Wait 5 seconds
```

Good:

```markdown
4. Expect: the message "Saved" is shown
```

Fix: Removes the step and renumbers the ones after it. Applied by --fix only when no Expect:, Soft: or Never: line would be renumbered.

### duplicate-test-name

**warning.** Two tests with the same name. Results, reports and PR comments show tests by name. Two with the same name can't be told apart.

Bad:

```markdown
tests/a.test.md: name: Checkout works
tests/b.test.md: name: Checkout works
```

Good:

```markdown
tests/a.test.md: name: Guest checkout works
tests/b.test.md: name: Member checkout works
```

### unused-flow

**info.** A flow no test uses. An unused flow is never run, so it quietly goes stale.

Bad:

```markdown
tests/flows/old-login.test.md (kind: flow), not in any Use: step
```

Good:

```markdown
Use it from a test (Use: flows/old-login.test.md), or delete it.
```
<!-- lint-rules:end -->

## Language service (APP-5)

`createLanguageService({ config, readFile, listFiles?, generators?,
authProfiles?, isSecretSet?, environment? })` gives the desktop and web editors
plain functions over (text, path, position), with LSP-like shapes and 1-based
positions matching the model. Browser-safe; no server or AI.

| Function | Returns |
|---|---|
| `diagnostics(text, path)` | the `checkTest` findings |
| `completions(text, path, position)` | after `{{`: namespaces, then members (data keys, declared secret names, flow params, generator members, env var names); at a line start: the next step number, `Expect:`, `Soft:`, `Never:`, `Use:`, `Exact:`; after `Use:`: flow paths; after `Exact:`: ops, keywords, locator kinds and roles; in frontmatter: missing keys and enum values (kind, heal, auth profiles, allowDestructive, hook types, HTTP methods, environment keys). Nothing inside a fenced code block. |
| `hover(text, path, position)` | field docs; variable info (data: its template; unique/faker: generated per run; secret: name, domains, set or missing, **never the value**); flow summary (name, params with defaults and what this step passes); exact-op docs; rule docs for a finding there |
| `codeActions(text, path, range)` | the fixes of findings in the range, with `safe` |
| `format(text, path)` | edits to the canonical `printTest` text (none when already canonical) |
| `outline(text, path)` | steps with kind, number, label and range |
| `definition(text, path, position)` | on a `Use:` line: the flow file |

Items: `CompletionItem { label, kind, detail?, insertText, range }` (replace
`range` with `insertText`), `Hover { contents (markdown), range? }`,
`CodeAction { title, kind: "quickfix", edits, safe, diagnostic }`,
`OutlineItem { kind, number, label, range }`, `Definition { path, range }`.
`listFiles` feeds `Use:` completion; `isSecretSet(name)` reports only whether a
secret has a value. Every call takes about 1 ms on a 200-step file (a benchmark
test requires under 20 ms).

## Diagnostics

Same shape as `@testament/config` (`code`, `severity`, `message`, `fix`,
`file`, `line`, `path`) plus `range` (1-based line and column, end exclusive,
columns in UTF-16 units). `path` is the frontmatter field (`setup[0].request`)
when the problem is there. Codes are stable.

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
| `VAR_NAMESPACE_UNKNOWN` | error | Not one of data, env, secret, params, unique, faker. |
| `VAR_MEMBER_UNKNOWN` | error | Not a known `unique.*` / `faker.*` generator. |
| `VAR_UNDEFINED` | error | `{{data.x}}` or `{{params.x}}` that is not defined. |
| `SECRET_NAME_INVALID` | error | A secret name that is not UPPER_SNAKE_CASE. |
| `SECRET_UNDECLARED` | error | A secret not declared in the project settings (only with a config). |
| `DATA_CYCLE` | error | Data values refer to each other in a loop. |
| `ENV_UNDEFINED` | error | `{{env.X}}` not in the environment's vars (only when vars are passed). |
| `FLOW_NOT_FOUND` | error | The `Use:` path does not exist. |
| `FLOW_NOT_A_FLOW` | error | The included file is a test (`kind: flow` missing). |
| `FLOW_CYCLE` | error | Flows include each other in a loop. |
| `FLOW_DEPTH` | error | Flows nested too deep. |
| `FLOW_PARAM_MISSING` | error | A required param is not passed (or has no default when the flow runs alone). |
| `FLOW_PARAM_UNKNOWN` | error | A passed param the flow does not declare. |
| `TESTS_DIR_MISSING` | warning | The tests folder does not exist. |
| `LINT` | per rule | A lint rule finding; `rule` names the rule (see Lint). |
| `LINT_RULE_UNKNOWN` | warning | `lint.rules` names a rule that doesn't exist. |
