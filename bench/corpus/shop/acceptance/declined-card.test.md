---
name: A declined card shows an error and no trial starts
tags: [payments]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: acceptance re-phrasing of tests/declined-card.test.md -->

As a customer whose card is declined
I want a clear error
So that I know the trial did not start

Acceptance criteria:
- Logged in via flows/login.test.md, I go to /pricing and click "Start free trial" on the Pro plan
- I fill the card form with test card 4000 0000 0000 0002, expiry 12/34, CVC 123 and click "Start trial"
- An error says "Your card was declined."
- The URL still contains /checkout
