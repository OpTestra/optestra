---
name: Signing out asks first
tags: [auth]
setup:
  - request: POST /__test/seed
---

1. Use: flows/sign-in.test.md
2. Tap "Sign out"
3. Expect: a dialog asks "Sign out of Acme Shop?"
4. Tap "Sign out" in the dialog
5. Expect: the screen heading is "Sign in to Acme Shop"
