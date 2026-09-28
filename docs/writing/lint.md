<!-- Generated from the lint rule definitions (packages/spec, via its README's generated reference) by `pnpm --filter ./docs gen`. Do not edit: a test fails when this page is out of date. -->

# Lint rules

Vague tests produce meaningless passes: `Expect: it works` can't fail, so it proves nothing. Lint is the first defence, before any AI is involved. It is rule-based and deterministic (the same file and settings always give the same findings), and it runs in the editor as you type, in `%cli% lint`, and in `%cli% doctor`.

```sh
%cli% lint                  # every test and flow in the project
%cli% lint tests/checkout.test.md --fix   # apply the safe fixes
%cli% lint --strict --json  # CI: warnings fail too; machine-readable
```

Set a rule's level, or make warnings fail, in the project file:

```yaml
lint:
  rules:
    compound-expect: off   # off | info | warning | error
    fixed-wait: error
  strict: false           # true: warnings fail the exit code too
```

`lint` exits 0 with no errors, 1 on a lint error (or a warning with `--strict`), and 2 when a file can't be parsed or expanded, a path doesn't exist or the project file has errors.

**Expectations are never auto-edited.** A fix that touches an `Expect:`, `Soft:`, `Never:` or exact `expect` line is never applied by `--fix`; the editor offers it for you to apply by hand.

## Rules

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

Fix: Offers to replace it with `{{secret.NAME}}`; you then declare NAME in the project's secrets.

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

Fix: Adds `email: "{{unique.email}}"` to data and uses `{{data.email}}` in the steps. Applied by --fix when the address appears in no Expect:, Soft: or Never: line.

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
