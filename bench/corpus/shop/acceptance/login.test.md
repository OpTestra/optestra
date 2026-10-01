---
name: Returning user can log in and out
tags: [smoke, auth]
start: /login
auth: none
setup:
  - request: POST /__test/seed
timeout: 1m
---

<!-- corpus: acceptance re-phrasing of tests/login.test.md -->

As a returning user
I want to log in and out
So that my account stays mine

Acceptance criteria:
- With email ada@example.com and password {{secret.SHOP_PASSWORD}}, clicking "Log in" takes me to the dashboard
- The page heading is "Dashboard" and the URL contains /dashboard
- Clicking "Log out" takes me back to a page whose heading is "Acme Shop"
