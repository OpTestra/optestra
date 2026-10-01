---
name: New customer can start a Pro trial
tags: [smoke, payments]
start: /pricing
auth: none
data:
  email: "{{unique.email}}"
timeout: 3m
---

<!-- corpus: sloppy re-phrasing of tests/checkout-trial.test.md -->

1. click "Start Free Trial" on the pro plan
2. sign up with {{data.email}} and password {{secret.SHOP_PASSWORD}}
3. Expect: the page heading is "Check your email"
4. enter the code from the verifcation email
5. Fill the card form with test card 4242 4242 4242 4242, expiry 12/34, CVC 123
6. click "Start Trial"
7. Expect: the page heading is "Welcome to Pro"
8. Expect: the URL contains /dashboard
9. Go to the billing page
10. Expect: the page shows "$0.00 due today"

Never: click "Delete account"
