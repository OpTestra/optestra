---
name: Sign-up form explains what is wrong
tags: [auth, forms]
start: /signup
auth: none
---

<!-- corpus: sloppy re-phrasing of tests/signup-validation.test.md -->

1. fill "email" with not-an-email
2. fill "password" with short
3. click "Sign up"
4. Expect: the text "Enter a valid email address, like name@example.com." is shown
5. Expect: the text "Password must be at least 8 characters." is shown
6. Expect: the page heading is "Create your account"
