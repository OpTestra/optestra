---
name: New customer can start a Pro trial
tags: [smoke, payments]
start: /pricing
auth: none
data:
  email: "{{unique.email}}"
timeout: 3m
---

<!-- corpus: mixed re-phrasing of tests/checkout-trial.test.md -->

1. Click "Start free trial" on the Pro plan
2. Sign up with {{data.email}} and password {{secret.SHOP_PASSWORD}}
3. Expect: the page heading is "Check your email"
4. Open the verification email, copy the code, enter it and click Verify
5. Fill the card form: 4242 4242 4242 4242, expiry 12/34, CVC 123
6. Click "Start trial"
7. Expect: the page heading is "Welcome to Pro"
8. Expect: the URL contains /dashboard
9. Now go to billing
10. Expect: the page shows "$0.00 due today"

Never: click "Delete account"
