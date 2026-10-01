---
"@optestra/report": minor
"@optestra/cli": minor
---

Add reports and exports from a run (EVD-0). The new `@optestra/report` package
renders a run folder as a self-contained offline HTML report (failure groups,
headline and screenshot first, per-step evidence, heal proposals with signals,
AI calls and cost, works with JS off, styled from one tokens file), JUnit XML,
a versioned JSON summary for coding agents with its JSON Schema, a length-capped
Markdown summary for the PR comment and job summary, and a shared quiet terminal
formatter. The CLI gains `report [runDir] [--out] [--open]` and
`results --junit <file> --json [file] --markdown <file>`; `results` now prints
AI calls per test and the failure groups, and `results --json` prints the JSON summary.
