---
name: New customer can start a Pro trial
tags: [smoke, payments]
start: /pricing
auth: none
data:
  email: "{{unique.email}}"
timeout: 3m
---

<!-- corpus: verbose re-phrasing of tests/checkout-trial.test.md -->

This covers the whole path for a brand-new customer starting a Pro trial from the pricing page. On the Pro plan card, click "Start free trial". That takes you to sign-up: register with {{data.email}} and the password {{secret.SHOP_PASSWORD}}. After submitting, the page heading should be "Check your email". Grab the verification code from the email that was sent and enter it, then click "Verify". You'll land on the card form: use the test card 4242 4242 4242 4242 with expiry 12/34 and CVC 123, and click "Start trial". The heading should then read "Welcome to Pro" and the URL should contain /dashboard. Finally go to the billing page, which must show "$0.00 due today". At no point should anything click "Delete account".
