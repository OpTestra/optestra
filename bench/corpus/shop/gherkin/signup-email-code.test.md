---
name: New user signs up and verifies their email
tags: [smoke, auth, email]
start: /signup
auth: none
data:
  email: "{{unique.email}}"
timeout: 2m
---

<!-- corpus: gherkin re-phrasing of tests/signup-email-code.test.md -->

Scenario: New user signs up and verifies their email
  Given I am on the sign-up page
  When I fill "Email" with {{data.email}}
  And I fill "Password" with {{secret.SHOP_PASSWORD}}
  And I click "Sign up"
  Then the page heading should be "Check your email"
  When I enter the code from the verification email into "Verification code"
  And I click "Verify"
  Then the page heading should be "Dashboard"
  And the projects list should say "No projects yet."
