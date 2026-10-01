---
name: A trial costs nothing today
tags: [payments]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
    body: { trial: pro }
---

<!-- corpus: spoken re-phrasing of tests/billing-zero-due.test.md -->

so basically the user's already logged in and they're on the pro trial right, so just go to the billing page and it should say pro plan and it should say zero dollars due today, like dollar sign zero point zero zero due today, because trials don't charge anything
