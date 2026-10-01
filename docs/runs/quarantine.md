# Muting a test

A test that fails for a known reason (a bug with an issue open, a flaky third party) can be muted until a date. While muted it still runs, with all its evidence, and keeps its real verdict, but its failure doesn't fail the run, the PR check or an alert. Reports show it apart, as muted. The day after its date it counts again, and the run says so.

```sh
%cli% mute tests/checkout.test.md --reason "payment sandbox down, #412" --until 14d
%cli% mute --list
%cli% unmute tests/checkout.test.md
```

- `--reason` is required: a mute is a decision someone made, with the why.
- `--until` is a date (`2026-10-15`) or a span from today (`14d`, `2w`). A mute lasts at most 90 days.
- An existing mute, running or expired, is only changed with `--renew`: renewing is a decision too.

The mutes live in the project file, so they are reviewed like any change:

```yaml
quarantine:
  - test: tests/checkout.test.md
    reason: "payment sandbox down, #412"
    until: 2026-10-15
```

`test` is the test file, or its test id.

## What muted changes

| | Muted test that failed |
|---|---|
| Exit code, `results`, the Action's check | Doesn't count (the run passes if everything else does) |
| Terminal | `MUTED` with the date and the reason, and a "Muted" section |
| HTML report | A "Muted tests" section and a Muted badge |
| JSON summary | `muted: { reason, until }`, `totals.muted` |
| JUnit | `<skipped message="Muted until … (failed): reason">` |
| Markdown summary | A "Muted tests" block |

A muted test that passes is just reported as passed (and muted): unmute it.

## Suggestions, never automatic

Nothing is muted by itself. When a test fails intermittently (flaky now, or failing and passing across its recent runs), the run suggests muting it: "looks flaky: mute it while it's fixed", with the reason. The suggestion is `muteSuggested` in the results; muting is still your call.
