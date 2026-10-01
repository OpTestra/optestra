---
name: Returning user can log in and out
tags: [smoke, auth]
start: /login
auth: none
setup:
  - request: POST /__test/seed
timeout: 1m
---

<!-- corpus: verbose re-phrasing of tests/login.test.md -->

A returning user should be able to log in and log out again. On the login page, enter ada@example.com as the email and {{secret.SHOP_PASSWORD}} as the password, then click "Log in". The user should arrive on the dashboard: the page heading is "Dashboard" and the URL contains /dashboard. Then click "Log out", after which the page heading should be "Acme Shop" again.
