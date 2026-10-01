---
name: Sign-up form explains what is wrong
tags: [auth, forms]
start: /signup
auth: none
---

<!-- corpus: mixed re-phrasing of tests/signup-validation.test.md -->

1. Fill "Email" with not-an-email
2. Use a password that's too short: short
3. Click "Sign up"
4. Expect: the text "Enter a valid email address, like name@example.com." is shown
5. Expect: the text "Password must be at least 8 characters." is shown
6. Expect: the page heading is "Create your account"
