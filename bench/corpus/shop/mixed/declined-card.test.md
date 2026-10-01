---
name: A declined card shows an error and no trial starts
tags: [payments]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: mixed re-phrasing of tests/declined-card.test.md -->

1. Use: flows/login.test.md
2. Go to /pricing
3. On the Pro plan card, click Start free trial
4. Fill the card form with the declining test card 4000 0000 0000 0002, expiry 12/34, CVC 123
5. Click "Start trial"
6. Expect: an error says "Your card was declined."
7. Expect: the URL contains /checkout
