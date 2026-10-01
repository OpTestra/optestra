---
name: Settings can be changed without going near account deletion
tags: [settings, safety]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: spoken re-phrasing of tests/delete-account-guard.test.md -->

okay so this one's a safety one, log in with the login flow, go to the settings page, and you should see a delete account button but do not click it, do not click delete account and definitely don't click yes delete my account, instead change the time zone to asia slash tokyo and click save changes and it should say profile saved
