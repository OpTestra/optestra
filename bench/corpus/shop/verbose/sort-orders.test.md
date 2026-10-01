---
name: Orders can be sorted by total
tags: [tables]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: verbose re-phrasing of tests/sort-orders.test.md -->

The orders table should sort by total in both directions. As the logged-in seeded user, open the orders page; the orders table should show 5 orders. Click the "Total" column header once: the first order in the table should be A-1002 ($8.90). Click the "Total" header again to flip the order: now the first order should be A-1004 ($150.00). Then click "Show refunded orders" and the table should show 6 orders.
