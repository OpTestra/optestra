---
name: New customer can start a Pro trial
tags: [smoke, payments]
start: /pricing
auth: none
data:
  email: "{{unique.email}}"
timeout: 3m
---

<!-- corpus: acceptance re-phrasing of tests/checkout-trial.test.md -->

As a new visitor
I want to start a Pro trial straight from the pricing page
So that I can try Pro before paying

Acceptance criteria:
1. Clicking "Start free trial" on the Pro plan takes me to sign-up
2. I can sign up with {{data.email}} and the password {{secret.SHOP_PASSWORD}}
3. After signing up the page heading is "Check your email"
4. Entering the code from the verification email and clicking "Verify" takes me to the card form
5. With test card 4242 4242 4242 4242, expiry 12/34, CVC 123, clicking "Start trial" works
6. The page heading is "Welcome to Pro" and the URL contains /dashboard
7. The billing page shows "$0.00 due today"
8. Nothing in this flow ever clicks "Delete account"
