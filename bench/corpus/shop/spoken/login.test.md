---
name: Returning user can log in and out
tags: [smoke, auth]
start: /login
auth: none
setup:
  - request: POST /__test/seed
timeout: 1m
---

<!-- corpus: spoken re-phrasing of tests/login.test.md -->

so on the login page type in the email ada at example dot com and the password, the shop password, then click log in, no sorry the button's called login, log in, whatever, and then you should be on the dashboard so the heading says dashboard and the url has slash dashboard, and then click log out and the heading should go back to acme shop
