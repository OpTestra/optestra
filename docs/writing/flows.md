# Flows

A flow is a reusable piece of a test, like logging in. It is a test file with `kind: flow`:

```markdown
---
name: Log in
kind: flow
params:
  email: ada@example.com
  password: "{{secret.SHOP_PASSWORD}}"
start: /login
---

1. Fill "Email" with {{params.email}}
2. Fill "Password" with {{params.password}}
3. Click "Log in"
4. Expect: the page heading is "Dashboard"
```

Include it from a test with `Use:`, passing params as an inline map:

```markdown
1. Use: flows/login.test.md { email: "{{data.admin}}" }
2. Click "Create project"
```

`Use:` inlines the flow's steps, recursively.

- **Paths** are relative to the including file, then to the tests folder (`tests.dir`). A leading `/` means the project root. Paths never leave the project.
- **Params** are evaluated in the caller's scope and override the flow's defaults. An empty default (`email:`) means required. A missing required param (`FLOW_PARAM_MISSING`) or an unknown one (`FLOW_PARAM_UNKNOWN`) is an error. Each param is one value.
- **Scope.** A flow sees its own `data` and `params`, not the caller's `data`.
- The flow's `start` is ignored when it is included (it is used when the flow runs on its own). Its `Never:` guards join the test.
- Loops are `FLOW_CYCLE`; nesting deeper than 8 is `FLOW_DEPTH`.
- Flows are loaded like tests but not listed as runnable tests. A flow no test uses is a lint note (`unused-flow`).

## Recording and results

Every step keeps where it came from: the `Use:` steps that led to it and its own line in the flow. Reports show the flow as a named group of steps. A step recorded inside a flow is keyed by the flow chain and its text, so the same flow used by many tests is recorded per test and route.

A failed step inside a `Use:` flow (a broken login, say) makes the test **failed**, never blocked, and the headline names the `Use:` step: a broken login is a real failure, not "couldn't run".

## Flows as logins

A flow can also be an [auth profile](../auth.md): tests that say `auth: admin` start logged in, and the login flow runs once and its session is saved and reused, instead of running in every test.
