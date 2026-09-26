---
name: Returning user can log in and out
tags: [smoke, auth]
start: /login
auth: none
setup:
  - request: POST /__test/seed
timeout: 1m
---

1. Fill "Email" with ada@example.com
2. Fill "Password" with {{secret.SHOP_PASSWORD}}
3. Click "Log in"
4. Expect: the page heading is "Dashboard"
5. Expect: the URL contains /dashboard
6. Click "Log out"
7. Expect: the page heading is "Acme Shop"
