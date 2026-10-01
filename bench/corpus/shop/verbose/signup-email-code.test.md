---
name: New user signs up and verifies their email
tags: [smoke, auth, email]
start: /signup
auth: none
data:
  email: "{{unique.email}}"
timeout: 2m
---

<!-- corpus: verbose re-phrasing of tests/signup-email-code.test.md -->

A new user signs up and has to confirm their email with a code before they get in. On the sign-up page fill in the email {{data.email}} and the password {{secret.SHOP_PASSWORD}} and click "Sign up". The heading should change to "Check your email". Take the code from the verification email, put it into the "Verification code" field and click "Verify". The user should end up on the dashboard (heading "Dashboard"), and since they're new the projects list should say "No projects yet."
