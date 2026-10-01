---
name: New user signs up and verifies their email
tags: [smoke, auth, email]
start: /signup
auth: none
data:
  email: "{{unique.email}}"
timeout: 2m
---

<!-- corpus: spoken re-phrasing of tests/signup-email-code.test.md -->

so on the sign up page put in the data email and the shop password and click sign up, and the heading should change to check your email, then grab the code from the verification email and put it in the verification code box and click verify, and then you should land on the dashboard, heading dashboard, and the projects list should say no projects yet with a full stop
