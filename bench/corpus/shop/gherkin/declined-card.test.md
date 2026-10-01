---
name: A declined card shows an error and no trial starts
tags: [payments]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: gherkin re-phrasing of tests/declined-card.test.md -->

Scenario: A declined card shows an error and no trial starts
  Given I am logged in via flows/login.test.md
  When I go to /pricing
  And I click "Start free trial" on the Pro plan
  And I fill the card form with test card 4000 0000 0000 0002, expiry 12/34, CVC 123
  And I click "Start trial"
  Then I should see an error "Your card was declined."
  And the URL should contain /checkout
