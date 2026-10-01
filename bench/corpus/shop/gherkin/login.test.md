---
name: Returning user can log in and out
tags: [smoke, auth]
start: /login
auth: none
setup:
  - request: POST /__test/seed
timeout: 1m
---

<!-- corpus: gherkin re-phrasing of tests/login.test.md -->

Scenario: Returning user can log in and out
  Given I am on the login page
  When I fill "Email" with ada@example.com
  And I fill "Password" with {{secret.SHOP_PASSWORD}}
  And I click "Log in"
  Then the page heading should be "Dashboard"
  And the URL should contain /dashboard
  When I click "Log out"
  Then the page heading should be "Acme Shop"
