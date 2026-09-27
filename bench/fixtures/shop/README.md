# Acme Shop (Bench fixture `shop`)

A small SaaS-style website: the target every later engine phase is tested
against, and the built-in demo project (ONB-5). Plain Node `http`,
server-rendered HTML, vanilla ES modules in `public/`, an in-memory store. No
framework, no bundler, no network. See [`../../README.md`](../../README.md) for
how Bench uses it.

```
src/
  variants.ts   every variant: behaviour switches (Bugs) and cosmetic switches (Surface)
  store.ts      in-memory data, fixed clock (TODAY = 2026-01-15), counter ids
  pages.ts      HTML for every page
  server.ts     routes, test hooks; startShop({ variant, port })
  smtp.ts       optional loopback-only Mailpit delivery
  cli.ts        `start -- --variant <name> --port <n>`
public/         client scripts + correct.css / cosmetic.css
tests/          plain-English tests (+ flows/login.test.md, files/avatar.png)
manifest.yaml   gold answers
e2e/            Playwright reference suite, verdict reporter, browser-free checks
```

## Determinism

Ids come from counters, dates from a fixed clock, and the verification code is
derived from the email address (`verificationCode(email)`), so the same variant
plus the same requests gives byte-identical pages, including after a restart.
The only intentional non-determinism is `env-flaky`'s seeded pattern
(`FLAKY_PATTERN` in `src/variants.ts`), which is itself a pure function of the
request count. The dashboard loads projects after a fixed 600 ms delay, and it
creates projects only after that load finishes, so requests reach the API in
the same order every time.

Pages send `Content-Security-Policy: default-src 'self'` and reference nothing
off-origin.

## Pages and routes

| Route | What |
|---|---|
| `GET /` | Home (`?deleted=1` shows "Your account has been deleted.") |
| `GET /pricing` | Starter $9, Pro $29, Team $79; each has "Start free trial" (→ sign-up, or checkout when logged in) |
| `GET/POST /signup` | Email + password, visible validation errors (`aria-invalid`, described-by) |
| `GET/POST /verify` | 6-digit code from the verification email; then checkout (if a plan was picked) or dashboard |
| `GET/POST /login`, `POST /logout` | Session cookie `acme_session` |
| `GET/POST /login/code` | Two-factor login, only for a user seeded with `totp`: "Authentication code" (RFC 6238, 6 digits, 30 s) |
| `GET /error` | "Something went wrong" (where `broken-login-redirect` lands) |
| `GET /dashboard` | Projects list (loaded client-side), "Create project" → modal `<dialog>` → toast; `?welcome=pro` shows "Welcome to Pro" |
| `GET/POST /api/projects` | JSON list / create |
| `GET /checkout?plan=` | Card fields in an iframe (`/pay/frame`, title "Secure card payment") + "Start trial" |
| `POST /pay/tokens`, `POST /api/subscribe` | Tokenise card, start trial. `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined ("Your card was declined.") |
| `GET /billing` | "Pro plan · free trial until …", "$0.00 due today" |
| `GET /settings` | Profile (name, read-only email, time zone `<select>`), avatar upload (PNG/JPEG ≤ 1 MB), "Delete account" behind a confirm `alertdialog` |
| `POST /api/profile`, `POST /api/avatar`, `GET /avatar`, `POST /settings/delete` | Settings actions |
| `GET /orders` | Sortable orders table (column header buttons, `aria-sort`), plus "Show refunded orders": a clickable `<div>` with no role |

Accessibility: landmarks, headings, labels and roles are correct everywhere
except the deliberate `<div>` above. Only some elements carry `data-testid`.

## Test hooks

All under `/__test/`, always on (this is a fixture), JSON in and out.

| Hook | What |
|---|---|
| `POST /__test/reset` | Clear all app data. Add `?environment=1` to also restart the `env-flaky` pattern (environment trouble outlives data resets). |
| `POST /__test/seed` | Create a verified user with six orders. Body (all optional): `email`, `password`, `name`, `trial` (`starter`/`pro`/`team`), `projects` (names), `totp` (a base32 seed: logging in then asks for an authentication code). Defaults: `ada@example.com` / `shop-demo-pass` / Ada Lovelace. Seeding keeps the user's login sessions, so a saved session (auth profiles) stays valid. |
| `GET /__test/outbox?to=<email>` | Emails sent, newest last: `{ emails: [{ to, subject, text }] }` |
| `GET /__test/state` | `{ variant, users: [{ email, verified, plan, projects }] }` |

If `MAILPIT_SMTP=127.0.0.1:1025` is set, verification emails are also delivered
to that local Mailpit (SEC-5). Non-loopback hosts are refused.

`shopInbox(shop)` (exported) is a test inbox over the shop's own outbox, read in
process with no network: the engine's e2e tests and the Bench use it when
Mailpit isn't running. It has the shape of `@testament/auth`'s `Inbox`.

## Auth profile

The project file defines the `ada` profile (`flows/login.test.md`, checked by
opening `/dashboard`). `billing-zero-due`, `settings-profile` and `sort-orders`
use it (`auth: ada`, start on `/dashboard`); the other logged-in tests keep
`Use: flows/login.test.md`, so both paths stay tested. In the manifest, a
profile's login is step 0.

## Cosmetic change list

Everything the `cosmetic` build changes (all of it is `COSMETIC_SURFACE` in
`src/variants.ts`). Headings, messages, amounts, input labels other than "Full
name", and behaviour are identical.

**Styles and layout**: `cosmetic.css` instead of `correct.css`: dark theme, serif
font, header reversed (brand on the right), pricing as a stacked list instead of
a 3-column grid, pill buttons, toasts top-centre instead of bottom-right,
right-aligned table, dialog buttons reversed.

**Classes renamed**

| correct | cosmetic |
|---|---|
| `site-header` | `topbar` |
| `site-nav` | `menu` |
| `page` | `content` |
| `panel` | `box` |
| `btn` / `btn-primary` / `btn-danger` | `button` / `button--main` / `button--warn` |
| `plans` / `plan` / `plan--<id>` | `pricing-grid` / `pricing-tile` / `pricing-tile--<id>` |
| `field` / `field-error` | `form-row` / `form-row__error` |
| `toasts` | `notices` |
| `orders-table` | `data-table` |
| `fake-link` | `text-action` |

**Ids renamed**

| correct | cosmetic |
|---|---|
| `signup-form`, `signup-email`, `signup-password` | `register-form`, `register-email`, `register-password` |
| `login-form`, `login-email`, `login-password` | `signin-form`, `signin-email`, `signin-password` |
| `verify-code` | `otp` |
| `create-project`, `project-name` | `add-project`, `new-project-name` |
| `profile-name`, `profile-timezone` | `user-name`, `user-tz` |
| `avatar-file` | `photo-input` |

**Test ids**: `plan-<id>` → `pricing-<id>`; `project-list` → `projects`;
`due-today` → `amount-due`; `orders-table` removed.

**Reordered DOM**: pricing plans Team, Pro, Starter (was Starter, Pro, Team);
"Log out" first in the nav (was last); settings shows Avatar before Profile.

**Moved buttons**: "Create project" below the projects list (was in the section
header); checkout "Start trial" above the card frame (was below).

**Reworded labels**

| correct | cosmetic |
|---|---|
| Start free trial | Start your free trial |
| Sign up (button) | Create account |
| Log in (button) | Sign in |
| Create project | Add project |
| Create (dialog) | Save project |
| Save changes | Save profile |
| Full name (label) | Your name |
| Upload avatar | Upload photo |
| Show / Hide refunded orders | Include / Exclude refunded orders |
| Start trial (checkout) | Start my trial |

Nav links ("Pricing", "Log in", "Sign up", "Dashboard" …) keep their names.
