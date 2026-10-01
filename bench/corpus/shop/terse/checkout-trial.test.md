---
name: New customer can start a Pro trial
tags: [smoke, payments]
start: /pricing
auth: none
data:
  email: "{{unique.email}}"
timeout: 3m
---

<!-- corpus: terse re-phrasing of tests/checkout-trial.test.md -->

1. pro plan > start free trial
2. signup w/ {{data.email}} / {{secret.SHOP_PASSWORD}}
3. expect: heading check your email
4. enter the email code, verify
5. card 4242 4242 4242 4242 exp 12/34 cvc 123
6. start trial
7. expect: heading "Welcome to Pro"
8. expect: url contains /dashboard
9. billing page
10. expect: "$0.00 due today"

Never: click "Delete account"
