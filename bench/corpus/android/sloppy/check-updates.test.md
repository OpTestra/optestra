---
name: Checking for updates fails politely offline
tags: [settings]
setup:
  - request: POST /__test/seed
---

<!-- corpus: sloppy re-phrasing of tests/check-updates.test.md -->

1. Use: flows/sign-in.test.md
2. Tap "settings"
3. Tap "Check for update"
4. Expect: the screen says "Couldn't check for updates."
