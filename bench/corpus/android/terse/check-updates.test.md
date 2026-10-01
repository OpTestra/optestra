---
name: Checking for updates fails politely offline
tags: [settings]
setup:
  - request: POST /__test/seed
---

<!-- corpus: terse re-phrasing of tests/check-updates.test.md -->

1. Use: flows/sign-in.test.md
2. settings
3. scroll to check for updates
4. tap it
5. expect: "Couldn't check for updates."
