# @testament/recording

The recording format (REP-1). For each test, one file lists what was done for
every step (the commands, with locators, fingerprints, templates and learned
waits) and the typed checks. Later runs replay it without AI (LOOP-4).

Recordings store **commands, never results** (LRN-1, LRN-2). Nothing in a file
says a step passed.

| Import | Use | Runs in |
|---|---|---|
| `@testament/recording` | zod schemas and types, `serializeRecording` / `parseRecording`, `routeOf`, `stepKey`, `checkKey`, `RECORDING_EPOCH`, templates (`toTemplate`, `templateParts`, `templateRefs`) | browser and Node (the apps display recordings) |
| `@testament/recording/node` | `recordingPath`, `readRecording`, `writeRecording` (atomic) | Node |

## Where it lives

`<tests dir>/.testament/<testId>.steps.json`, next to the tests. The folder
name comes from brand, and the file is committed to git. `testId` is the
contract's `testIdFromPath`, e.g. `tests__login`. The authoring reports live in
the project's own data folder (`.testament/authoring/`), which stays local.

## Shape

The file is written with keys in schema order, 2-space JSON and one field per
line, so the same recording always gives the same bytes and git diffs show
only real changes.

```jsonc
{
  "recordingVersion": 1,
  "testId": "tests__create-project",
  "testPath": "tests/create-project.test.md",
  "target": "web",
  "recordedWith": { "engineVersion", "epoch", "browser", "device", "environment", "model", "promptVersion" },
  "updatedAt": "…",
  "steps": [            // action and exact steps, in test order
    {
      "key": "…",       // StepResult.key, see below
      "textKey": "…", "route": "/dashboard",
      "text": "Click \"Create project\"",   // the line as written, variables by name
      "kind": "action",                      // action | exact
      "commands": [{
        "action":      { "type": "click", "target": { "kind": "role", "role": "button", "name": "Create project", "exact": true } },
        "fingerprint": { "primary", "fallbacks": [], "role", "name", "tag", "attributes", "anchorText", "framePath", "box" },
        "expectPost":  { "urlChange"?, "appeared"?: [{ "role", "name", "text"? }], "removed"?, "requests"?: [{ "method", "route", "status"? }] },
        "wait":        { "settledMs", "waitedFor": { "network", "dom", "busy" }, "until"? }
      }],
      "reasoning": "the New project dialog opened",   // the model's short note, scrubbed
      "source": "ai",                                 // ai | exact | record
      "recordedAt": "…"
    }
  ],
  "checks": [          // one per Expect / Soft / exact expect step
    { "key", "textKey", "text": "a dialog titled \"New project\" is open", "soft": false,
      "check": { "type": "pending" }, "generatedBy": "ai", "recordedAt": "…" }
  ]
}
```

- **action**: a LOOP-0 action (`goto click dblclick fill select check uncheck
  press hover scroll upload back reload waitFor`). Its target is always a
  locator (`LocatorSchema`, the same shape as `@testament/browser`'s
  `LocatorSpec`, with an optional iframe path), never a ref.
- **fingerprint**: what re-finding the element without AI needs (HEAL-1).
  - `primary` is the top unique locator candidate.
  - `fallbacks` are the rest, in Playwright's priority order.
  - The facts come from the harness's `candidates(ref)`.
  - It is null for commands without an element, and for exact commands.
- **expectPost**: what replay should see after the command (VER-5). Every string
  in it is a template.
- **wait**: how long the page took to settle (LRN-4). `until` is for learned
  wait conditions (LOOP-4).

### Values are templates (REP-7)

Values in a recording are templates:
- `{{data.email}}`, `{{params.password}}` or `{{env.PLAN}}` for variables;
- `{{secret.NAME}}` for secrets;
- anything else is literal text.

A literal `{{` is written `\{{`, the same rule as in test files. So one
recording works for many test users, and no resolved variable value or secret
value ever enters it.

- `toTemplate(typed, variables)`: keeps known references, turns a value that
  equals a variable's value into its reference, and escapes stray `{{`.
- `templateParts(template, values)` is what a driver uses at replay: text,
  `{ secret: NAME }` (typed by the driver) or `{ unresolved: ref }`.

### Checks

The check op union is defined now, so LOOP-2 and LOOP-3 build on it without a
schema change:

| `type` | Fields |
|---|---|
| `text` | `target`, `match: equals \| contains`, `value` (template) |
| `url` | `match: is \| contains \| matches`, `value` |
| `element_state` | `target`, `state: visible \| hidden \| enabled \| disabled \| checked \| unchecked \| focused \| editable \| empty` |
| `count` | `target`, `n` / `min` / `max` |
| `network` | `method`, `url` pattern, `status` |
| `aria_snapshot` | `target`, `snapshot` |
| `code` | verbatim Playwright code |
| `pending` | not compiled yet (what LOOP-1 writes for Expect/Soft lines) |

Every op with a target can also take a `scope` locator, which carries its own
frame path. Exact expect ops (`Exact: expect url contains /x`) are already typed
and are written with `generatedBy: "exact"`.

## Keys (REP-7)

- **`route`** is `routeOf(url)`, taken from the page when the step began:
  - the path only (no host, query or hash);
  - numeric, UUID, ULID and long-hex segments become `:id`;
  - no trailing slash.

  So `/orders/1042/items/?x=1` becomes `/orders/:id/items`. Non-http pages
  keep their scheme (`about:blank`).
- **`key`** is `stepKey(textKey, route, epoch)`: FNV-1a 64-bit hex of
  `["s1", textKey, route, epoch]`. `textKey` comes from `@testament/spec`:
  - it is built from the step's text with variables by name, its flow chain
    and its occurrence;
  - values never enter it;
  - step numbers don't either.
- **`checkKey(textKey, epoch)`** is the key of a check. It ignores the route, so
  a check is found again whatever page it was written on.

### The epoch

`RECORDING_EPOCH` (currently `1`) is **not** the package version. Bump it only
when replay semantics change, meaning what a recorded command means or how keys
are built. Upgrading the engine therefore doesn't throw recordings away. A
recording with a different epoch keeps its commands, but its keys no longer
match, so each step is re-planned on the next authoring run.

## Re-authoring

Writing a recording replaces the file:
- A step recorded in this run replaces the old one with the same `textKey`.
- A step not reached this time (for example, after a failure earlier in the
  test) keeps its previous recording.
- Steps that no longer exist in the test are dropped.
- Compiled checks survive re-authoring; `pending` ones are rewritten.
