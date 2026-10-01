---
name: Profile changes are saved
tags: [settings, forms]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: terse re-phrasing of tests/settings-profile.test.md -->

1. settings page
2. full name = Ada King
3. tz = Europe/London
4. save changes
5. expect: profile saved msg
6. reload
7. expect: full name is still Ada King
8. expect: time zone is Europe/London
