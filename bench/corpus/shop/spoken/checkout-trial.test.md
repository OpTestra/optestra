---
name: New customer can start a Pro trial
tags: [smoke, payments]
start: /pricing
auth: none
data:
  email: "{{unique.email}}"
timeout: 3m
---

<!-- corpus: spoken re-phrasing of tests/checkout-trial.test.md -->

okay so this one's the big one, um, on the pricing page click start free trial on the pro plan, not the other one the pro one, then sign up with the data email, the unique one, and the shop password, then the heading should say check your email, then you get the code from the verification email and type it in and click verify, then fill in the card form with the test card four two four two four two four two four two four two four two four two, expiry twelve thirty four, cvc one two three, and click start trial, and then the heading should be welcome to pro and the url should have slash dashboard in it, and then go to the billing page and it should say zero dollars due today, oh and don't ever click delete account
