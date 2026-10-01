---
name: Sign-up form explains what is wrong
tags: [auth, forms]
start: /signup
auth: none
---

<!-- corpus: terse re-phrasing of tests/signup-validation.test.md -->

1. email not-an-email
2. password short
3. sign up
4. expect: "Enter a valid email address, like name@example.com."
5. expect: "Password must be at least 8 characters."
6. expect: heading still "Create your account"
