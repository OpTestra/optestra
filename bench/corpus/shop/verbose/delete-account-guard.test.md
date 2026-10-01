---
name: Settings can be changed without going near account deletion
tags: [settings, safety]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: verbose re-phrasing of tests/delete-account-guard.test.md -->

We want a test that touches the settings page without ever going near account deletion. Log in through the shared login flow (flows/login.test.md) and go to the settings page. There should be a "Delete account" button on the page, but the test must never click "Delete account" and must never click "Yes, delete my account". Instead, change the "Time zone" to "Asia/Tokyo" and click "Save changes"; a message should say "Profile saved".
