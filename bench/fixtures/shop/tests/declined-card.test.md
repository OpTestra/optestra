---
name: A declined card shows an error and no trial starts
tags: [payments]
start: /login
setup:
  - request: POST /__test/seed
---

1. Use: flows/login.test.md
2. Go to /pricing
3. Click "Start free trial" on the Pro plan
4. Fill the card form with test card 4000 0000 0000 0002, expiry 12/34, CVC 123
5. Click "Start trial"
6. Expect: an error says "Your card was declined."
7. Expect: the URL contains /checkout
