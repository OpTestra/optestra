---
name: Log in
kind: flow
params:
  email: ada@example.com
  password: "{{secret.SHOP_PASSWORD}}"
start: /login
---

1. Go to /login
2. Fill "Email" with {{params.email}}
3. Fill "Password" with {{params.password}}
4. Click "Log in"
5. Expect: the page heading is "Dashboard"
