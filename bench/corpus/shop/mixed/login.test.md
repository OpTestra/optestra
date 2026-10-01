---
name: Returning user can log in and out
tags: [smoke, auth]
start: /login
auth: none
setup:
  - request: POST /__test/seed
timeout: 1m
---

<!-- corpus: mixed re-phrasing of tests/login.test.md -->

1. Enter ada@example.com in the email field
2. Fill "Password" with {{secret.SHOP_PASSWORD}}
3. Click "Log in"
4. Expect: the page heading is "Dashboard"
5. Expect: the URL contains /dashboard
6. Log out using the button in the header
7. Expect: the page heading is "Acme Shop"
