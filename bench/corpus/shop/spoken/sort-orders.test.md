---
name: Orders can be sorted by total
tags: [tables]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: spoken re-phrasing of tests/sort-orders.test.md -->

um so you're logged in, go to the orders page, the table should have five orders, then click the total column header and the first order should be a dash one zero zero two, eight dollars ninety, then click total again and now the first one should be a dash one zero zero four, a hundred and fifty dollars, and then click show refunded orders and there should be six orders
