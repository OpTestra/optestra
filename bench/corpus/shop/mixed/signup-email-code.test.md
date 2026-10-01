---
name: New user signs up and verifies their email
tags: [smoke, auth, email]
start: /signup
auth: none
data:
  email: "{{unique.email}}"
timeout: 2m
---

<!-- corpus: mixed re-phrasing of tests/signup-email-code.test.md -->

1. Fill "Email" with {{data.email}}
2. Type the password {{secret.SHOP_PASSWORD}} into the password field
3. Click "Sign up"
4. Expect: the page heading is "Check your email"
5. Get the code from the verification email and put it in the Verification code box
6. Click "Verify"
7. Expect: the page heading is "Dashboard"
8. Expect: the projects list says "No projects yet."
