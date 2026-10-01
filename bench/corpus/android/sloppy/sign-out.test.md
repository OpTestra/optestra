---
name: Signing out asks first
tags: [auth]
setup:
  - request: POST /__test/seed
---

<!-- corpus: sloppy re-phrasing of tests/sign-out.test.md -->

1. Use: flows/sign-in.test.md
2. Tap "Log out"
3. Expect: a dialog asks "Sign out of Acme Shop?"
4. Expect: the screen heading is "Sign in to Acme Shop"
