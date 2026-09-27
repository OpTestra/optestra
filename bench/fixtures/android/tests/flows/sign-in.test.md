---
name: Sign in
kind: flow
params:
  email: ada@example.com
  password: "{{secret.SHOP_PASSWORD}}"
---

1. Type {{params.email}} into "Email"
2. Type {{params.password}} into "Password"
3. Tap "Sign in"
4. Expect: the screen heading is "Projects"
