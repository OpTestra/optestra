---
name: A trial costs nothing today
tags: [payments]
start: /login
setup:
  - request: POST /__test/seed
    body: { trial: pro }
---

1. Use: flows/login.test.md
2. Go to the billing page
3. Expect: the page shows "Pro plan"
4. Expect: the page shows "$0.00 due today"
