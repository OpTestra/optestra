---
name: A wrong password is refused
tags: [auth]
auth: none
setup:
  - request: POST /__test/seed
---

1. Type ada@example.com into "Email"
2. Type not-the-password into "Password"
3. Tap "Sign in"
4. Expect: a message says "Email or password is incorrect."
5. Expect: the screen heading is "Sign in to Acme Shop"
