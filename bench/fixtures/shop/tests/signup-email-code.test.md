---
name: New user signs up and verifies their email
tags: [smoke, auth, email]
start: /signup
auth: none
data:
  email: "{{unique.email}}"
timeout: 2m
---

1. Fill "Email" with {{data.email}}
2. Fill "Password" with {{secret.SHOP_PASSWORD}}
3. Click "Sign up"
4. Expect: the page heading is "Check your email"
5. Enter the code from the verification email into "Verification code"
6. Click "Verify"
7. Expect: the page heading is "Dashboard"
8. Expect: the projects list says "No projects yet."
