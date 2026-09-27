# @testament/auth

Login building blocks (SEC-3, SEC-4, SEC-5): **auth profiles** with saved login
sessions, **TOTP secrets** typed like any other secret, and **test email
inboxes** (Mailpit, Mailosaur, MailSlurp) that hand back a verification code or
a magic link. Node only; the pure code/link extraction is also
`@testament/auth/extract` (browser-safe).

AUTH-0 built and tested the parts. AUTH-1 wired them into runs and authoring
(see `packages/core/README.md`, "Auth profiles" and "Test inboxes"): the runner
calls `ensureProfile` with the real login flow and a `check.url` validation,
opens sessions with the saved state, and connects `{{inbox.…}}` and the agent's
`read_inbox` tool to `InboxValues`.

Importing `@testament/auth` registers the `auth` and `inbox` config sections and
the `totp` secret type. Import it before loading config or resolving secrets.

## What is stored where (for the data page, SAF-5)

| What | Where | Who can read it |
|---|---|---|
| Profile definitions (flow, params, check, reuse, ttl) | the project file, `auth.profiles` | committed with the project |
| Saved login sessions (Playwright storage state: cookies + local storage) | `<project>/<dataDir>/auth/<environment>/<profile>/<worker>.json`, e.g. `.testament/auth/staging/admin/w0.json` | the owner only: folders `0700`, files `0600`, written atomically. The folder has its own `.gitignore` (`*`) and the data dir is git-ignored. Never in artifacts, reports or logs |
| TOTP seeds, inbox API keys | secret sources (`.env`, environment variables, later the keychain / vault), like every secret | never in the project file |
| TOTP codes, inbox codes and links | nowhere: produced at the moment they are typed | registered with the redactor, so logs and evidence show `[secret:NAME]` |
| Emails | in your inbox provider | the engine reads one message when a step needs it and keeps nothing |

Every cookie and local-storage value of a saved or loaded session (6 characters
or longer) is registered with the redactor as `[session:<profile>]`, so no log,
report or error message can show it. Shorter values (`consent=1`) are left out,
since registering them would scrub every `1` in every log.

## Auth profiles and saved sessions (SEC-3)

```yaml
auth:
  profiles:
    admin:
      flow: flows/login-admin.test.md   # the flow that logs in (relative to tests.dir)
      params: { email: "{{data.admin_email}}" }
      check: { url: /dashboard }         # how to tell a saved session still works
      reuse: per-worker                  # per-worker (default) | shared
      ttlMinutes: 60                     # default 60
```

- A test's `auth: admin` names a profile. `auth: none` means start logged out,
  and no `auth:` means the test does its own logging in.
  `testAuth(spec.frontmatter.auth, config.auth)` resolves it, and
  `checkTestAuth(spec, config.auth)` reports `AUTH_PROFILE_UNKNOWN`, with its
  position and the known names. `checkProfiles(config.auth, exists)` reports
  `AUTH_FLOW_MISSING`.
- `per-worker` gives each parallel worker its own session, for tests that change
  server data. `shared` reuses one session for all workers, and they log in only
  once: a lock file serializes them across processes, and one promise per key
  within a process.
- A saved session is only reused when it:
  - is younger than `ttlMinutes`;
  - was made for the same profile definition (a hash of `flow`, `params` and
    `check`, so editing the profile invalidates it);
  - passes the injected `validate` when the profile has a `check`.

```ts
import { ensureProfile, SessionStore } from "@testament/auth";

const store = new SessionStore({ projectDir });
const result = await ensureProfile("admin", {
  store,
  auth: config.auth,
  environment: "staging",
  worker: 0,
  runFlow: async ({ profile }) => ({ ok: true, storageState }),   // the runner replays the flow
  validate: async ({ storageState, check }) => true,            // the runner opens check.url
});
// { status: "ready", storageState, source: "saved" | "login", expiresAt }
// { status: "failed", reason: "unknown_profile" | "login_failed" | "store_error", message }
```

`ensureProfile` never throws. A `runFlow` or `validate` that throws counts as a
failed login or a session that no longer works. `SessionStore` also has `load`,
`save`, `list` (without contents) and `clear({ profile?, environment? })`.

## TOTP secrets (SEC-4)

```yaml
secrets:
  ADMIN_TOTP: { domains: [app.example.com], type: totp }
auth:
  totp: { minRemainingSeconds: 5 }   # default 5
```

The `.env` value is the base32 seed (the text under the QR code) or the full
`otpauth://totp/…?secret=…&digits=…&period=…&algorithm=…` URI. Digits (6–8),
period and SHA1/SHA256/SHA512 are honoured. Typing `{{secret.ADMIN_TOTP}}`
types the code of that moment (RFC 6238, `node:crypto`). If fewer than
`minRemainingSeconds` are left in the period, it first waits for the next code,
so the code is still valid when the form is submitted.

How it works:
- `@testament/config` has **secret types**. `@testament/auth` registers
  `totp`, and `resolveSecrets` checks the seed.
  - A bad seed is `SECRET_INVALID`, with the fix and without the value; the
    secret is then left out, so a fill gets `missing_secret`.
  - A good seed becomes a **dynamic** `SecretValue`.
- The browser's secret fill awaits `prepareSecret(secret)` from
  `@testament/config/reveal` right before typing. For a TOTP secret that
  produces the current code.
  - The code is registered with the secret's redactor and the session's own
    redactor before it is typed.
  - The fill happens inside the paused trace, like every secret fill.
- The seed and its base32 text (as written, upper and lower case) are
  registered with the redactor when the secret is resolved. `revealSecret` of a
  TOTP secret gives the seed; only `prepareSecret` gives a code.
- `totp`, `hotp`, `verifyTotp`, `freshTotp`, `parseTotpSeed` and `base32Decode`
  are exported for tests and tools.

Domains still rule: a TOTP secret, like any secret, is typed only into a frame
on one of its `domains` (SEC-2, enforced by the browser harness).

## Inboxes (SEC-5)

```yaml
inbox:
  provider: none            # none | mailpit | mailosaur | mailslurp
  timeoutSeconds: 60
  mailpit:   { url: http://127.0.0.1:8025, domain: example.test }
  mailosaur: { baseUrl: https://mailosaur.com, serverId: abc123, keySecret: MAILOSAUR_API_KEY }
  mailslurp: { baseUrl: https://api.mailslurp.com, inboxId: …, keySecret: MAILSLURP_API_KEY }
```

`createInbox(config, { sources, environment })` returns `{ ok: true, inbox }`, or
a typed reason (`not_configured`, `unauthorized` for a missing or disallowed
key). It makes no network call. The `Inbox` interface:

```ts
interface Inbox {
  provider: "mailpit" | "mailosaur" | "mailslurp";
  host: string;                        // every request goes here
  emailDomain: string | undefined;     // for {{unique.email}} (ENV-3)
  address(hint?): Promise<{ ok: true; address } | InboxFailure>;
  waitForMessage({ to, subjectContains?, since, timeoutMs, signal? }):
    Promise<{ ok: true; message: { id, from, to, subject, text, html, receivedAt } } | InboxFailure>;
  check(): Promise<InboxCheck>;        // reachable, key valid
}
// InboxFailure = { ok: false, reason: timeout | unauthorized | unavailable | not_configured | bad_response | aborted, message, fix? }
```

| Provider | Addresses | Waiting | Key |
|---|---|---|---|
| Mailpit | any `<name>@<mailpit.domain>` (Mailpit catches everything) | polls `GET /api/v1/search?query=to:"…"` every 500 ms, then `GET /api/v1/message/<id>` | none |
| Mailosaur | `<name>@<serverId>.mailosaur.net` | long poll `POST /api/messages/await` | HTTP basic (`key:`), only to `baseUrl`'s host |
| MailSlurp | an inbox created with `POST /inboxes` (or `inboxId`) | long poll `GET /waitForLatestEmail` | `x-api-key`, only to `baseUrl`'s host |

- A key named by `keySecret` but not declared under `secrets:` is allowed only
  on its provider's own host, as for model keys. A declared one must list that
  host in its `domains`.
- `inboxEmailDomain(config.inbox)` is the domain to pass as `emailDomain` to
  `expandTest`, so `{{unique.email}}` lands in the inbox. It is undefined for
  MailSlurp, where addresses are created, not derived.
- Messages received up to 2 s before `since` still count (`CLOCK_SKEW_MS`).
- **One network file.** All inbox HTTP goes through `src/inbox/transport.ts`.
  It is pinned to the configured host and scheme, never follows redirects, and
  never throws. It is also the only file here that reveals a key. The guard test
  (`test/guards.test.ts`) enforces this.

### Extraction

`extractCode(message)` finds the one-time code:
- 4–8 digits, `123-456` / `123 456`, or 4–8 letters and digits, returned
  without separators;
- near words like code, verify, OTP, PIN, sign-in, or right after "code is" /
  "code:" / "enter";
- ignoring dates, times, prices, amounts, percentages, years, phone numbers,
  identifiers like `A-1003`, anything in a URL, and numbers after words like
  order, invoice, account, # or ref.

`extractLinks(message, allowedDomains)` returns `{ links, refused }`:
- `links` are the http(s) links on allowed hosts, best first. Verify, magic,
  confirm and reset links are `kind: "action"`; unsubscribe, help and privacy
  links go last.
- `refused` holds links to any other host. They are never returned as the link
  to follow (`pickLink`).

Host matching follows the browser allowlist's rules: `example.com` exactly,
`*.example.com` for subdomains only, and an optional `:port`.

The word lists are data in `src/inbox/patterns.json`. The test corpus
(`src/inbox/extract.test.ts`) has 20 realistic emails, including ones with
order numbers, prices, dates, times, years, phone and zip codes, and a German
date. All 20 extract correctly.

### `{{inbox.code}}`, `{{inbox.link}}`, `{{inbox.subject}}`

The spec binds these as `unresolved`, so a recording keeps the template and
never the one-time value. At run time:

```ts
const values = createInboxValues({ inbox, allowedDomains, timeoutMs: config.inbox.timeoutSeconds * 1000 });
await values.get("code", { to: email, since: stepStartedAt });
// { ok: true, member: "code", value: SecretValue "[secret:INBOX_CODE]", subject, receivedAt }
// { ok: false, reason: timeout | no_code | no_link | link_not_allowed | unknown_member | …, message, fix? }
```

- Code and link come back as `SecretValue`s (`INBOX_CODE`, `INBOX_LINK`),
  registered with the redactor and typed only on the environment's
  `allowedDomains`.
- A link is only returned when its host is allowed; otherwise the result is
  `link_not_allowed`.
- One wait serves all three members of the same lookup, so they always come
  from one email.

`inboxSecret(values, "code", () => lookup, { allowedDomains })` is the same
value as a dynamic secret. A browser session can be opened with it before the
email exists (`secrets: { INBOX_CODE }`), and it is read from the inbox when
`{ secret: "INBOX_CODE" }` is typed. A miss fails the fill with the typed
reason (`InboxValueError`).

## CLI

- `testament auth` lists profiles with their saved-session status per
  environment: valid until …, expired, or none. It also reports profiles
  whose flow is missing (exit 1), then each saved session by profile,
  environment and worker. It never shows a cookie. With
  `--clear [profile] [-e env]` it deletes saved sessions instead.
- `testament doctor` checks "Profile flows recorded": every profile's login
  flow exists (fail) and has a recording (warn: the first run records it with
  the AI).
- `testament inbox check` checks the configured provider: reachable, and key
  valid. Exit 0 when OK, 1 when the check fails, 2 when no inbox is configured.
- `testament inbox last --to <address> [--wait 5]` prints the latest email's
  sender, subject, time, extracted code and allowed link, plus the hosts of
  refused links. It is for debugging and never prints a body.

## Tests

- `pnpm test` runs the unit tests:
  - TOTP against the RFC 6238 and RFC 4226 vectors, the fresh-code wait with
    fake timers, and otpauth parsing;
  - the extraction corpus;
  - session store expiry, permissions, per-worker and shared keys, locks and
    redaction;
  - the transports and adapters against loopback fakes of Mailpit, Mailosaur
    and MailSlurp;
  - key domains, typed misses and config sections.
- `pnpm --filter @testament/auth test:browser`, part of `pnpm
  bench:fixtures:test`, runs the e2e tests:
  - a TOTP fill in Chromium: a valid code on the allowed host, refused on
    another host, and the code in no output or trace;
  - a shop sign-up whose code is read from a real Mailpit, using the shop's own
    project settings (`bench/fixtures/shop/testament.config.yaml`).
- The Mailpit e2e is skipped, with a message, when Mailpit isn't running. Start
  Mailpit with `docker run -d -p 8025:8025 -p 1025:1025 axllent/mailpit`. CI
  runs it as a service with `REQUIRE_MAILPIT=1`.
