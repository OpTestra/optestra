---
name: New user signs up and verifies their email
tags: [smoke, auth, email]
start: /signup
auth: none
data:
  email: "{{unique.email}}"
timeout: 2m
---

<!-- corpus: acceptance re-phrasing of tests/signup-email-code.test.md -->

As a new user
I want to verify my email with a code
So that only real addresses get accounts

Acceptance criteria:
- I sign up with email {{data.email}} and password {{secret.SHOP_PASSWORD}}
- After clicking "Sign up" the heading is "Check your email"
- When I enter the code from the verification email into "Verification code" and click "Verify", the heading is "Dashboard"
- The projects list says "No projects yet."
