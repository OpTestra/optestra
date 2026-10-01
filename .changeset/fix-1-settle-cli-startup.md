---
"@optestra/browser": patch
"@optestra/decide": patch
"@optestra/models": minor
"@optestra/cli": patch
---

Fix two intermittent problems (FIX-1). Settle's quiet window now counts from
the start of the settle at the earliest, so a request an action starts a few ms
after it returns keeps the page unsettled instead of settling at 0 ms. A
request's post-state `status` is `"pending"` while it has no response (it was
recorded as `"failed"` before), and failed requests keep Playwright's failure
text in `failure`. The `failure_cause` decision accepts pending requests. The
CLI loads each command's implementation only when it runs, so `--help`,
`config`, `list`, `show` and `lint` no longer load Playwright or the AI SDK;
`@optestra/models/section` registers the `models` project-file section
without the AI SDK.
