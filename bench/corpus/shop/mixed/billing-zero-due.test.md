---
name: A trial costs nothing today
tags: [payments]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
    body: { trial: pro }
---

<!-- corpus: mixed re-phrasing of tests/billing-zero-due.test.md -->

1. From the dashboard, open the billing page
2. Expect: the page shows "Pro plan"
3. Expect: the page shows "$0.00 due today" (a trial must not charge anything)
