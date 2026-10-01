---
name: A trial costs nothing today
tags: [payments]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
    body: { trial: pro }
---

<!-- corpus: acceptance re-phrasing of tests/billing-zero-due.test.md -->

As a customer on a Pro trial
I want to see that nothing is due today
So that I trust the trial is really free

AC:
- Given I'm logged in as the seeded user with a Pro trial, when I open the billing page
- Then the page shows "Pro plan"
- And the page shows "$0.00 due today"
