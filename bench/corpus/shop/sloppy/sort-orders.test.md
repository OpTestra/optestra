---
name: Orders can be sorted by total
tags: [tables]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: sloppy re-phrasing of tests/sort-orders.test.md -->

1. Go to the Orders page
2. Expect: the orders table shows 5 orders
3. Click the "total" column
4. Expect: the first order in the table is A-1002 ($8.90)
5. Click the "total" column again
6. Expect: the first order in the table is A-1004 ($150.00)
7. Click "show refunded"
8. Expect: the orders table shows 6 orders
