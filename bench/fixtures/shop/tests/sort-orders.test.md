---
name: Orders can be sorted by total
tags: [tables]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

1. Go to the orders page
2. Expect: the orders table shows 5 orders
3. Click the "Total" column header
4. Expect: the first order in the table is A-1002 ($8.90)
5. Click the "Total" column header again
6. Expect: the first order in the table is A-1004 ($150.00)
7. Click "Show refunded orders"
8. Expect: the orders table shows 6 orders
