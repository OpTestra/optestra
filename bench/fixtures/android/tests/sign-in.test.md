---
name: Returning user can sign in
tags: [smoke, auth]
auth: none
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
timeout: 1m
---

1. Type ada@example.com into "Email"
2. Type {{secret.SHOP_PASSWORD}} into "Password"
3. Tap "Sign in"
4. Expect: the screen heading is "Projects"
5. Expect: the list shows "Website redesign"
