---
name: Profile changes are saved
tags: [settings, forms]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: spoken re-phrasing of tests/settings-profile.test.md -->

um the user's logged in already, so go to settings, change the full name to ada king, and set the time zone to europe slash london, and click save changes, it should say profile saved, then reload the page and the full name should still say ada king and the time zone should still be europe london
