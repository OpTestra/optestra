---
name: Orders can be sorted by total
tags: [tables]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: acceptance re-phrasing of tests/sort-orders.test.md -->

As a shop owner
I want to sort orders by total
So that I can find big and small orders fast

Acceptance criteria:
- The orders page shows 5 orders in the orders table
- Clicking the "Total" column header puts A-1002 ($8.90) first
- Clicking the "Total" column header again puts A-1004 ($150.00) first
- Clicking "Show refunded orders" makes the table show 6 orders
