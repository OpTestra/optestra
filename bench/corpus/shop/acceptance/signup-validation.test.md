---
name: Sign-up form explains what is wrong
tags: [auth, forms]
start: /signup
auth: none
---

<!-- corpus: acceptance re-phrasing of tests/signup-validation.test.md -->

As someone filling in the sign-up form
I want clear messages about bad input
So that I can fix it

AC:
- Signing up with email not-an-email and password short shows "Enter a valid email address, like name@example.com."
- It also shows "Password must be at least 8 characters."
- The page heading is still "Create your account"
