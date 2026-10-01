---
name: A trial costs nothing today
tags: [payments]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
    body: { trial: pro }
---

<!-- corpus: terse re-phrasing of tests/billing-zero-due.test.md -->

1. open billing
2. expect: pro plan shown
3. expect: page shows "$0.00 due today"
