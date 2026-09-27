---
"@testament/core": minor
"@testament/browser": minor
"@testament/contract": minor
"@testament/spec": minor
"@testament/codegen": minor
"@testament/cli": minor
---

Logins and email codes in real runs (AUTH-1). A test with `auth: <profile>`
starts logged in: a saved session is reused after its `check`, else the
profile's flow is replayed like a test (its own recording) in an evidence-free
session and its storage state saved; a broken login fails the test, our own
problems block it. `{{inbox.code}}` / `{{inbox.link}}` are read from the test
inbox and typed or opened by the harness like secrets; the agent gets a
`read_inbox` tool that returns only a handle (prompt `planner-v3`), and
`{{unique.email}}` uses the inbox's domain. The browser gains
`session.storageState()` / `useStorageState()`, `goto { secret }` and the
`secret_unavailable` refusal. Contract 1.2 adds the blocked reasons
`inbox_unavailable`, `login_failed` and `setup_failed`. The spec lets a flow run
on its own take params. Generated specs log in with the profile's flow. The CLI
shows saved sessions per worker, and doctor checks that profile flows are recorded.
