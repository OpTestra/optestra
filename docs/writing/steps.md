# Steps

The body of a test is line-based. Numbered lines are steps; indented lines right after a step continue it (they are joined with a space). Steps run in file order: the number is for display, and out-of-order or skipped numbers are only a warning.

| Line | Kind | |
|---|---|---|
| `1. Click "Save"` | action | Plain English. The first run works out how; later runs replay it. |
| `2. Expect: the heading is "Saved"` | expect | Becomes a real [check](../runs/checks-and-verdicts.md). Kept exactly as written: nothing rewrites, merges or drops an expectation. |
| `3. Soft: the chart looks reasonable` | soft | Warns when it fails; never fails the test, and never makes it pass on its own. |
| `Never: click "Delete account"` | guard | Numbered or not, anywhere in the file; applies to the whole test. |
| `4. Use: flows/login.test.md { email: "{{data.admin}}" }` | flow | Includes a [flow](./flows.md). |
| `5. Exact: click role=button[name="Save"]` | exact | The fixed syntax below: no AI needed. |
| a ` ```ts ` block right after a step line | exact | Playwright code, kept verbatim. See [Code steps](#code-steps). |
| `<!-- … -->` | | A comment, kept when printing. |

Prefixes are case-insensitive (`expect:` works). Any other text outside steps is a warning (`TEXT_OUTSIDE_STEPS`) and is kept.

## Action steps

Say exactly what to do, the way you'd tell a colleague: which button, which field, what value.

```markdown
1. Fill "Email" with {{data.email}}
2. Fill "Password" with {{secret.TEST_PASSWORD}}
3. Click "Log in"
```

A vague step ("Log in normally", "Click it") can be done many ways, so a pass proves little; lint warns about it (`vague-step`). On the first run the AI works out the actions through a closed set of tools (click, double-click, fill, select, check, uncheck, press, hover, scroll, upload, go to a page, back, reload, wait for, and read the test inbox) and the harness records them. It never sees a secret's value: it types `{{secret.NAME}}` and the harness fills it in.

A step counts as done only if the page visibly changed (unless every action was of a kind that legitimately changes nothing, like hover or scroll). A button that does nothing fails the step with `no_visible_effect`, whatever the AI says.

## Expect and Soft

```markdown
6. Expect: a message says "Project created"
7. Expect: the projects list shows "Q3 roadmap"
8. Soft: the chart looks reasonable
```

Each `Expect:` line is compiled once, while the test is recorded, into a typed check that code evaluates on every run with no AI. Most phrasings compile by rules; see [Checks and verdicts](../runs/checks-and-verdicts.md#the-phrase-rules) for the phrases, and `%cli% checks <file>` for what each line became. Keep one check per line (`compound-expect`), and name something on the screen (`expect-not-observable`): "Expect: it works" can't fail.

A `Soft:` line compiles the same way. Only a visual or qualitative soft line ("looks reasonable") may become a model-judged check, which can only ever warn.

## Never

```markdown
Never: click "Delete account"
Never: go to /admin
```

A guard is checked before every action, in every mode. It matches on its quoted text: `Never: click "Delete account"` matches a target whose accessible name or text equals or contains "delete account" (case, quotes and spacing ignored). A leading verb limits which actions it applies to: click, press or submit → clicks; fill or type → fills; select → selects; visit or go → navigation (matched on the URL). A refused action is recorded in the report.

## Exact steps

`Exact:` steps use a fixed syntax and need no AI, even on the first run.

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

Locators: `role=button[name="Save"]` (or just `role=heading`), `label="Email"`, `testid=save`, `text="Save"`, `placeholder="Search"`, `css=.selector`. Quoted values allow `\"` and `\\`; bare values stop at a space. Values, options and URLs are `"quoted"` or the rest of the line (`select` stops before ` in <locator>`), and may contain variables. Anything else is `EXACT_SYNTAX`, reported at the exact position.

## Code steps

A fenced ` ```ts ` block right after a step line is Playwright code, kept verbatim:

````markdown
3. Pick the delivery date
   ```ts
   await page.getByLabel("Date").fill("2031-01-31");
   ```
4. ```ts
   await page.keyboard.press("Escape");
   ```
````

The text before the fence is the step's label. The browser harness has no way to run code, by design, so a test with code steps runs through its [generated Playwright spec](../export.md) (regenerated first if stale, then Playwright Test) and is not healed. The project needs `@playwright/test` installed.
