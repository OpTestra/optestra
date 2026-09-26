---
name: Orders can be sorted by total
tags: [tables]
start: /login
setup:
  - request: POST /__test/seed
---

1. Use: flows/login.test.md
2. Go to the orders page
3. Expect: the orders table shows 5 orders
4. Click the "Total" column header
5. Expect: the first order in the table is A-1002 ($8.90)
6. Click the "Total" column header again
7. Expect: the first order in the table is A-1004 ($150.00)
8. Click "Show refunded orders"
9. Expect: the orders table shows 6 orders
