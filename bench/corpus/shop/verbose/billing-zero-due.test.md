---
name: A trial costs nothing today
tags: [payments]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
    body: { trial: pro }
---

<!-- corpus: verbose re-phrasing of tests/billing-zero-due.test.md -->

A customer who has just started a Pro trial shouldn't be charged anything up front. With the seeded user already logged in and on a Pro trial, open the billing page from the dashboard. The billing page should say that they're on the "Pro plan", and it should clearly show "$0.00 due today", because nothing is charged until the trial ends.
