---
name: Orders can be sorted by total
tags: [tables]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: gherkin re-phrasing of tests/sort-orders.test.md -->

Scenario: Orders can be sorted by total
  Given I am logged in as the seeded user
  When I go to the orders page
  Then the orders table should show 5 orders
  When I click the "Total" column header
  Then the first order in the table should be A-1002 ($8.90)
  When I click the "Total" column header again
  Then the first order in the table should be A-1004 ($150.00)
  When I click "Show refunded orders"
  Then the orders table should show 6 orders
