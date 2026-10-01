---
"@optestra/recording": minor
"@optestra/core": minor
"@optestra/browser": minor
"@optestra/models": minor
"@optestra/cli": minor
---

Add the first AI run and the recording (LOOP-1). `@optestra/recording` defines
the committed per-test recording (commands with locators, fingerprints,
templates and learned waits; typed check ops; keys from textKey + route + a
recording epoch). `@optestra/core` gains `authorTest`: setup request hooks, an
agent loop that drives the browser harness through tools mirroring its closed
action set, rule-based guards checked before acting, a VER-5 check that fails
steps with no visible effect, exact ops without a model, limits and budgets,
and a redacted authoring report. The browser session gains `hookRequest` for
setup hooks; models gains a `/testing` scripted model. The CLI gains `author`.
