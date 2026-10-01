---
name: A declined card shows an error and no trial starts
tags: [payments]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: verbose re-phrasing of tests/declined-card.test.md -->

When someone tries to start a trial with a card that gets declined, they should see a clear error and stay on checkout, and no trial should start. Log in with the shared login flow (flows/login.test.md), go to /pricing and click "Start free trial" on the Pro plan. Fill the card form with the declining test card 4000 0000 0000 0002, expiry 12/34, CVC 123, and click "Start trial". An error saying "Your card was declined." should be shown, and the URL should still contain /checkout.
