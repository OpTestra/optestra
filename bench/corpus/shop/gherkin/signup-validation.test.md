---
name: Sign-up form explains what is wrong
tags: [auth, forms]
start: /signup
auth: none
---

<!-- corpus: gherkin re-phrasing of tests/signup-validation.test.md -->

Scenario: Sign-up form explains what is wrong
  Given I am on the sign-up page
  When I fill "Email" with not-an-email
  And I fill "Password" with short
  And I click "Sign up"
  Then I should see "Enter a valid email address, like name@example.com."
  And I should see "Password must be at least 8 characters."
  And the page heading should be "Create your account"
