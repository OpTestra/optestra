---
name: Returning user can log in and out
tags: [smoke, auth]
start: /login
auth: none
setup:
  - request: POST /__test/seed
timeout: 1m
---

<!-- corpus: terse re-phrasing of tests/login.test.md -->

1. email ada@example.com
2. password {{secret.SHOP_PASSWORD}}
3. log in
4. expect: dashboard heading
5. expect: url /dashboard
6. log out
7. expect: heading "Acme Shop"
