---
name: New customer can start a Pro trial
tags: [smoke, payments]
start: /pricing
auth: none
data:
  email: "{{unique.email}}"
timeout: 3m
---

<!-- corpus: gherkin re-phrasing of tests/checkout-trial.test.md -->

Scenario: New customer can start a Pro trial
  Given I am on the pricing page
  When I click "Start free trial" on the Pro plan
  And I sign up with {{data.email}} and password {{secret.SHOP_PASSWORD}}
  Then the page heading should be "Check your email"
  When I enter the code from the verification email and click "Verify"
  And I fill the card form with test card 4242 4242 4242 4242, expiry 12/34, CVC 123
  And I click "Start trial"
  Then the page heading should be "Welcome to Pro"
  And the URL should contain /dashboard
  When I go to the billing page
  Then I should see "$0.00 due today"
  But I never click "Delete account"
