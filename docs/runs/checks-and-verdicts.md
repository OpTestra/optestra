# Checks and verdicts

**A pass means a real check passed.** Every `Expect:` and `Soft:` line becomes one typed check while the test is recorded. The check is shown to you, stored in the recording and evaluated on every run by plain code in the browser harness, with no model. The verdict is then decided by code from the checks and steps. A model never decides pass or fail.

## How an Expect line becomes a check

1. **Rules first.** The line is matched against phrase rules (data, in `packages/core/src/checks/phrases.json`). The rule picks a concrete locator by looking at the live page, preferring roles and labels. No model is involved; every Expect line in the demo shop's suite compiles this way.
2. **AI second.** Only a line no rule can map goes to the planner model, with the rules that were tried and the page as untrusted content. It answers with a typed check, or says it can't write a faithful one. A line that uses a secret is never compiled and never sent.
3. **Evaluate once** on the page (waiting up to 5 s). A failure is kept as "failed while authoring", with expected and actual, and shown in the report: it may be a real bug.
4. **Sanity test** (below).
5. **Summary.** One sentence generated from the check itself, never by a model, for example "Checked that the main heading is exactly 'Welcome to Pro'". Reports show it under "What was checked".

The line itself is never changed, split, merged or dropped. A line that can't be compiled faithfully stays **pending**, with the reason, instead of getting a weaker check. A pending check fails the test in replay-only mode.

```sh
%cli% checks tests/create-project.test.md
```

prints each line, its summary, the check, how it was made (`rules/heading`, `ai`, `exact`), the sanity test and the authoring result.

### The phrase rules

| Phrase (examples) | Check |
|---|---|
| `the page heading is "X"` | text equals on the level-1 heading (any heading when the page has no h1) |
| `the URL contains /x` · `is` · `matches` · `ends with` · `starts with` · `we are on /x` | URL contains / is / matches |
| `a message says "X"` · `a notification shows "X"` | text contains on the status region, else the alert, else the page's visible text |
| `an error says "X"` | text contains on the alert, else an element marked as an error; if X isn't on the page at all, the alert (so it fails, visibly) |
| `the text "X" is shown` · `the page shows "X"` · `"X" is visible` | text contains on the page's visible text |
| `the page doesn't show "X"` · `"X" is gone` | the text X is hidden |
| `a dialog titled "X" is open` | the dialog named X is visible |
| `a "X" button is shown` · `the "X" link is disabled` · `the checkbox "X" is checked` · `the image "X" is visible` | the state of the button, link, checkbox, image… named X |
| `the projects list shows "X"` · `the orders table says "X"` | text contains on the list or table the page names that way, else the only one |
| `the orders table shows 5 orders` | the count of visible rows (tables) or items (lists) |
| `the first order in the table is A-1002 ($8.90)` | the first visible data row matches every part, in order |
| `"Full name" contains "Ada King"` · `"Time zone" is "Europe/London"` | the value of the field with that label |

Values keep their variables (`{{data.plan}}`), bound when the check runs. Text matching collapses whitespace; "equals" is otherwise exact. Where a rule has a choice (status, alert or visible text), it takes the most specific place where the expected text is, after waiting up to 3 s for it. The result is never weaker than "the page shows X".

### Check types

| Type | Passes when |
|---|---|
| `text` | the visible text of one of the matched elements equals, contains or matches the value; for a form field, its value |
| `url` | the page URL is, contains or matches the value |
| `element_state` | a matched element is visible, hidden, enabled, disabled, checked, unchecked, focused, editable or empty |
| `count` | the number of matched elements is n, or between min and max |
| `value` | a field's current value equals or contains the value |
| `network` | a request with that method, URL and status was sent since the current action step began |
| `aria_snapshot` | every line of the snapshot appears, in order, in the element's accessibility snapshot |
| `code` | verbatim Playwright code; runs from the generated spec only |
| `soft_judgment` | a model says yes about a screenshot; `Soft:` lines only, and it can only warn |
| `pending` | never: the line has no check yet, and the reason is shown |

Checks wait like Playwright's assertions: retried every 100 ms until they pass or time out (5 s). A secret is never a check value: a check that refers to one is refused.

## The sanity test

A check must be able to fail. Each one is evaluated once more, with no waiting, on two pages where it should not hold:

- **an empty page** (`about:blank`, offline, no scripts);
- **the page just before the preceding action**: a static copy of the DOM with live field values and open dialogs written in, styles inlined, and scripts, frames and secret values removed.

A check that passes on the empty page proves nothing. On the before-page, it depends on whether the action changed what the check looks at: if the check's subject (its matched text, URL, count or state) is the same before and after, the check verifies something the action wasn't meant to change ("the URL contains /checkout" after a declined card), and the before-page is skipped. If the subject changed and the check still passed before, it proves nothing ("the page shows 'Acme'", which is on every page). Absence checks hold on an empty page by nature, so that page isn't used for them.

A check that proves nothing is regenerated once by the AI compiler; if that doesn't help, it is kept and flagged for you, and **it can never count as proof**.

## Soft checks

`Soft:` lines compile like any other, rules first. Only a visual or qualitative soft line ("the chart looks reasonable") may become a `soft_judgment`: a screenshot and a yes/no question for a model. It is marked warn-only and can never make a test pass. Soft judgments are not sanity-tested. Reports list soft-check warnings apart from failures.

## Verdicts

| Verdict | Means | Decided by |
|---|---|---|
| **passed** | every hard check of the final attempt passed, with no heal | the checks (every step that ran, if the test has no hard checks) |
| **healed** | passed, with a heal in the final attempt | the same, plus the heal is shown for review |
| **failed** | the final attempt failed, after retries | the failing check, or the failing step (element not found, nothing happened) |
| **flaky** | failed, then passed on a retry | the failed attempt's decider and the final attempt's passing checks |
| **blocked** | couldn't run | the blocked reason |

**Blocked is neither a pass nor a failure.** The reasons: `missing_secret`, `disallowed_domain`, `ai_unavailable`, `budget_exceeded`, `app_down`, `app_install_failed`, `config_error`, `aborted`, `captcha`, `inbox_unavailable`, `login_failed`, `setup_failed`. An error page or a 5xx is not "couldn't run": the step fails, and the cause says whether it was the product or the environment.

The results schema enforces this: a verdict's `decidedBy` can name a check, a step or a blocked reason, and there is no way to name a model or a decision. A passed test has no heal; a healed test must have one.

## Why it failed

After each test, the failure is labelled with a **cause**, from the requests, console errors, the page at the failure and the flow chain:

| Cause | |
|---|---|
| `product_bug` | the app is wrong |
| `test_drift` | the test no longer matches the app (a changed page, a strict policy) |
| `environment` | the app was unreachable, a gateway error, rate limiting, or trouble that went away on retry |
| `test_data` | "already exists", "coupon expired", "no such user"… |
| `blocked` | set from the blocked reason, never decided |

Rules decide most causes; a [decision model](../ai/decisions.md) may answer what rules can't, and below its confidence threshold the cause is left undecided rather than guessed. The cause is a label with its evidence. **It never changes a verdict.** After the run, failures with the same underlying problem are grouped ("… · affects 7 tests"), and each test gets a **headline**: the one line that matters, such as the failing check's expected and actual.
