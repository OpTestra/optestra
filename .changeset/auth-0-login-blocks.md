---
"@testament/auth": minor
"@testament/config": minor
"@testament/browser": minor
"@testament/spec": minor
"@testament/cli": minor
---

Add the login building blocks (AUTH-0). `@testament/auth` has auth profiles
(`auth.profiles`, a test's `auth: name`) with a saved-session store
(`SessionStore`, `ensureProfile` with an injected login flow and check;
owner-only, git-ignored, values redacted), the `totp` secret type (RFC 6238,
fresh-code wait), and test inboxes (Mailpit, Mailosaur, MailSlurp) behind one
pinned transport, with code/link extraction and `InboxValues`. Config gains
secret types, dynamic secrets, `prepareSecret` and `SECRET_INVALID`. The browser's
secret fill awaits `prepareSecret`. The spec gains the `{{inbox.code|link|subject}}`
namespace (bound `unresolved`). The CLI gains `auth [--clear]`, `inbox check` and
`inbox last`.
