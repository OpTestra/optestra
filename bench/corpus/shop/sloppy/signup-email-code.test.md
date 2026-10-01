---
name: New user signs up and verifies their email
tags: [smoke, auth, email]
start: /signup
auth: none
data:
  email: "{{unique.email}}"
timeout: 2m
---

<!-- corpus: sloppy re-phrasing of tests/signup-email-code.test.md -->

1. Fill "Email adress" with {{data.email}}
2. Fill "Pasword" with {{secret.SHOP_PASSWORD}}
3. Click "Sign Up"
4. Expect: the page heading is "Check your email"
5. Enter the code from the verification email into "Verification code"
6. Expect: the page heading is "Dashboard"
7. Expect: the projects list says "No projects yet."
