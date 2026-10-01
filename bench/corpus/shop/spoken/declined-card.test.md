---
name: A declined card shows an error and no trial starts
tags: [payments]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: spoken re-phrasing of tests/declined-card.test.md -->

so log in with the login flow and then go to slash pricing and click start free trial on the pro plan, then in the card form put the declined test card which is four thousand, no wait, it's four zero zero zero, zero zero zero zero, zero zero zero zero, zero zero zero two, expiry twelve thirty four, cvc one two three, and click start trial, and it should show an error saying your card was declined, and you should still be on the checkout page, the url should still have slash checkout
