---
name: A trial costs nothing today
tags: [payments]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
    body: { trial: pro }
---

<!-- corpus: gherkin re-phrasing of tests/billing-zero-due.test.md -->

Scenario: A trial costs nothing today
  Given I am logged in as the seeded user on a Pro trial
  When I go to the billing page
  Then I should see "Pro plan"
  And I should see "$0.00 due today"
