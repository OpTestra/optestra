---
name: Signing out asks first
tags: [auth]
setup:
  - request: POST /__test/seed
---

<!-- corpus: terse re-phrasing of tests/sign-out.test.md -->

1. Use: flows/sign-in.test.md
2. sign out
3. expect: dialog "Sign out of Acme Shop?"
4. confirm sign out in the dialog
5. expect: heading "Sign in to Acme Shop"
