---
name: A declined card shows an error and no trial starts
tags: [payments]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: terse re-phrasing of tests/declined-card.test.md -->

1. Use: flows/login.test.md
2. goto /pricing
3. pro > start free trial
4. card 4000 0000 0000 0002, 12/34, cvc 123
5. start trial
6. expect: error "Your card was declined."
7. expect: still on /checkout
