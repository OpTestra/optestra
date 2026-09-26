---
"@testament/decide": minor
"@testament/config": minor
"@testament/cli": minor
---

Add `@testament/decide`, the decision layer: typed decision tasks (choice, score
and noul questions), a rules → decision model → escalate pipeline with hard time
limits, `race` for during-run decisions and `decideBatch` for after-run ones, a
content-addressed decision cache, per-task metrics, a labelled-examples store and
the `DecisionBackend` interface (only a mock backend for now). No task may output
a verdict. The `decisions` config section defaults to rules only. The demo task
`page_is_error` exercises every path. The CLI gains `decisions [--stats <runDir>] [--json]`.
