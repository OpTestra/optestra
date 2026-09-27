---
name: Checking for updates fails politely offline
tags: [settings]
setup:
  - request: POST /__test/seed
---

1. Use: flows/sign-in.test.md
2. Tap "Settings"
3. Scroll down to "Check for updates"
4. Tap "Check for updates"
5. Expect: the screen says "Couldn't check for updates."
