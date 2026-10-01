---
name: Returning user can sign in
tags: [smoke, auth]
auth: none
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
timeout: 1m
---

<!-- corpus: terse re-phrasing of tests/sign-in.test.md -->

1. email ada@example.com
2. pw {{secret.SHOP_PASSWORD}}
3. sign in
4. expect: heading projects
5. expect: list has "Website redesign"
