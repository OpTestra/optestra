---
name: Orders can be sorted by total
tags: [tables]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: terse re-phrasing of tests/sort-orders.test.md -->

1. orders page
2. expect: 5 orders
3. sort by total
4. expect: first row A-1002 ($8.90)
5. sort by total again
6. expect: first row A-1004 ($150.00)
7. tick show refunded orders
8. expect: 6 orders
