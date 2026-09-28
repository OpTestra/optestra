# Auth profiles and inboxes

Three building blocks for logins: **auth profiles** (log in once, reuse the session), **TOTP secrets** (two-factor codes typed like any other secret) and **test inboxes** (read the verification code or magic link an app emails).

## Auth profiles

A profile is a named login, done by a [flow](./writing/flows.md):

```yaml
# %config%
auth:
  profiles:
    admin:
      flow: flows/login-admin.test.md   # the flow that logs in (relative to tests.dir)
      params: { email: "{{data.admin_email}}" }
      check: { url: /dashboard }         # how to tell a saved session still works
      reuse: per-worker                  # per-worker (default) | shared
      ttlMinutes: 60                     # default 60
```

A test picks it in its frontmatter:

```yaml
# the test's frontmatter
auth: admin     # start logged in as admin
```

`auth: none` starts logged out, with a clean session. Without `auth:`, the test does its own logging in.

**How it runs.** After a test's setup hooks and before its start page, the runner looks for a saved session for this environment, profile and worker. It is reused when it is younger than `ttlMinutes`, was made for this profile definition (editing `flow`, `params` or `check` invalidates it), and still works: the test's session loads it and opens `check.url`; landing anywhere else (the login page) means it doesn't. Otherwise the profile's flow is **replayed like a test**, from its own recording (authored in normal mode if it isn't recorded yet), in a separate session with no trace, video or network log. Its cookies and local storage are saved and loaded into the test's session.

So a test's trace never contains the login, and later tests skip the login steps entirely. The result shows one step, `auth: admin (logs in with flows/login-admin.test.md)`, when the flow ran.

- `per-worker` gives each parallel worker its own session, for tests that change server data. `shared` reuses one session for all workers; they log in only once (a lock file serializes them).
- A login flow that **fails** makes the test **failed**, like a failing `Use:` flow. One that can't run for our reasons stays **blocked** with that reason (`missing_secret`, `inbox_unavailable`, …); anything else is `login_failed`. An unknown profile blocks the test (`config_error`).
- The generated Playwright spec logs in with the profile's flow every time (it has no saved sessions).

**Where sessions are stored:** `<project>/%dataDir%/auth/<environment>/<profile>/<worker>.json`, readable only by you (folders `0700`, files `0600`), with their own `.gitignore`, never in artifacts, reports or logs. Every cookie and storage value of 6 characters or more is registered with the redactor, so no log, report or error message can show it.

```sh
%cli% auth                     # profiles and their saved sessions per environment (never a cookie)
%cli% auth --clear             # delete all saved sessions
%cli% auth --clear admin -e staging
```

`%cli% doctor` checks that every profile's flow exists (fail) and is recorded (warn: the first run records it with the AI).

## TOTP secrets

```yaml
secrets:
  ADMIN_TOTP: { domains: [app.example.com], type: totp }
auth:
  totp: { minRemainingSeconds: 5 }   # default 5
```

The value (in `.env` or the environment) is the base32 seed, the text under the QR code, or the full `otpauth://totp/…?secret=…` URI. Digits (6–8), period and SHA1/SHA256/SHA512 are honoured. Typing `{{secret.ADMIN_TOTP}}` types the code of that moment. If fewer than `minRemainingSeconds` are left in the period, it waits for the next code first, so the code is still valid when the form is submitted.

The seed is checked when secrets load: a bad one is `SECRET_INVALID` (with the fix, without the value) and the fill is then blocked with `missing_secret`. The code is produced at the moment of typing, registered with the redactor first, and typed while the trace is paused, like every secret. Domains still rule: it is typed only into a frame on one of its `domains`.

## Inboxes

For sign-ups that email a code or a link:

```yaml
inbox:
  provider: mailpit         # none (default) | mailpit | mailosaur | mailslurp
  timeoutSeconds: 60
  mailpit:   { url: http://127.0.0.1:8025, domain: example.test }
  # mailosaur: { baseUrl: https://mailosaur.com, serverId: abc123, keySecret: MAILOSAUR_API_KEY }
  # mailslurp: { baseUrl: https://api.mailslurp.com, keySecret: MAILSLURP_API_KEY }
```

| Provider | Addresses | Key |
|---|---|---|
| Mailpit (local or in CI) | any `<name>@<mailpit.domain>`: Mailpit catches everything | none |
| Mailosaur | `<name>@<serverId>.mailosaur.net` | `MAILOSAUR_API_KEY`, sent only to `baseUrl`'s host |
| MailSlurp | an inbox created through its API (or `inboxId`) | `MAILSLURP_API_KEY`, sent only to `baseUrl`'s host |

Start Mailpit with `docker run -d -p 8025:8025 -p 1025:1025 axllent/mailpit` and point your app's SMTP at port 1025.

In a test, use the inbox values, or just say it:

```markdown
---
name: New user signs up and verifies their email
start: /signup
auth: none
data:
  email: "{{unique.email}}"
---

1. Fill "Email" with {{data.email}}
2. Fill "Password" with {{secret.SHOP_PASSWORD}}
3. Click "Sign up"
4. Expect: the page heading is "Check your email"
5. Enter the code from the verification email into "Verification code"
6. Click "Verify"
7. Expect: the page heading is "Dashboard"
```

`{{unique.email}}` uses the inbox's domain, so every attempt gets a fresh, deliverable address. When a step needs the email, the latest message to the test's address is read: the one-time code is extracted and **typed by the harness like a secret** (`[secret:INBOX_CODE]` in logs), and a link is opened only on the [allowed domains](./environments.md#allowed-domains). The recording keeps `{{inbox.code}}` or `{{inbox.link}}`, never the value. While authoring, the agent asks for the email with its `read_inbox` tool and gets a handle ("its code is ready as `{{inbox.code}}`"), never the code itself.

- No email within `inbox.timeoutSeconds`: the test is **blocked** (`inbox_unavailable`): the app may be fine.
- An email without a code: the test **fails**.
- A link to another host: **blocked** (`disallowed_domain`).
- No inbox configured: the step is blocked `inbox_unavailable` before any AI is spent.

Code extraction looks for 4–8 digits (or `123-456`, `123 456`, or 4–8 letters and digits) near words like code, verify, OTP or PIN, and ignores dates, times, prices, years, phone numbers, order ids and anything in a URL. Links are ranked verify, magic, confirm and reset first; unsubscribe, help and privacy links go last.

```sh
%cli% inbox check                           # reachable, and the key valid
%cli% inbox last --to ada+1@example.test    # the latest email: sender, subject, code, allowed link (never the body)
```

Emails stay in your inbox provider: the engine reads one message when a step needs it and keeps nothing. All inbox traffic goes through one pinned transport that talks only to the configured host and never follows redirects.
