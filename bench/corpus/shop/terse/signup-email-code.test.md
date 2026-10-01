---
name: New user signs up and verifies their email
tags: [smoke, auth, email]
start: /signup
auth: none
data:
  email: "{{unique.email}}"
timeout: 2m
---

<!-- corpus: terse re-phrasing of tests/signup-email-code.test.md -->

1. email {{data.email}}
2. pw {{secret.SHOP_PASSWORD}}
3. sign up
4. expect: heading check your email
5. paste the code from the email into verification code
6. verify
7. expect: heading dashboard
8. expect: "No projects yet."
