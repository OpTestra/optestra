---
name: Returning user can sign in
tags: [smoke, auth]
auth: none
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
timeout: 1m
---

<!-- corpus: sloppy re-phrasing of tests/sign-in.test.md -->

1. Type ada@example.com into "E-mail"
2. Type {{secret.SHOP_PASSWORD}} into "password"
3. Tap "Log in"
4. Expect: the screen heading is "Projects"
5. Expect: the list shows "Website redesign"
