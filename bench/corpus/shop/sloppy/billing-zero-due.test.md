---
name: A trial costs nothing today
tags: [payments]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
    body: { trial: pro }
---

<!-- corpus: sloppy re-phrasing of tests/billing-zero-due.test.md -->

1. Go to the Billing page
2. Expect: the page shows "Pro plan"
3. expect: the page shows "$0.00 due today"
