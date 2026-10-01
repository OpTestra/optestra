---
name: Sign-up form explains what is wrong
tags: [auth, forms]
start: /signup
auth: none
---

<!-- corpus: verbose re-phrasing of tests/signup-validation.test.md -->

The sign-up form should explain what's wrong when the input is bad, instead of failing silently. On the sign-up page type not-an-email as the email and short as the password and click "Sign up". The page should show the text "Enter a valid email address, like name@example.com." and also "Password must be at least 8 characters.", and the user should stay on the form, so the heading is still "Create your account".
