---
"@testament/recording": minor
"@testament/core": minor
"@testament/browser": minor
"@testament/cli": minor
---

Add the check compiler (LOOP-2). While a test is authored, every `Expect:` and
`Soft:` line becomes a typed check: phrase rules first (data in
`phrases.json`, no model, locators picked from the live page), the planner
only for lines no rule maps. Each check is evaluated once and sanity-tested on
an empty page and on a copy of the page from before the preceding action; a
check that proves nothing is regenerated once, then flagged. `@testament/recording`
gains the `value` and `soft_judgment` ops, `text` `matches`, heading levels on
role locators, `generatedBy: rules`, summaries (`describeCheck`), sanity
results, `failedAtAuthoring` and `bindCheck`; LOOP-1 recordings still parse.
The browser session gains the read-only `check(op, options)` evaluator
(auto-waiting, expected vs actual, secrets refused) and `pageCopy()`. The CLI
`author` shows each compiled check, and `checks <test>` lists them.
