---
"@optestra/decide": minor
"@optestra/config": minor
"@optestra/cli": minor
---

Add the four after-run decisions to `@optestra/decide`: `failure_cause`,
`flaky_or_real` (advice only), `duplicate_or_new` (failure groups) and
`heal_class`. Their rules are data-driven and every decided answer carries its
evidence. The runner helpers are `inputFromTestResult`, `classifyFailure`,
`groupFailures` and `classifyHeal`. Decision backends are now chosen per phase
(`decisions.during` / `decisions.after`, with `backend` as the shorthand). A
backend is never called for a task whose time limit it can't meet, and it stops
being called after repeated timeouts. Labelled eval sets for the four tasks ship
with a rules-only baseline. The CLI gains `decisions --eval [--backend]
[--model-only]` and shows the routing per phase.
