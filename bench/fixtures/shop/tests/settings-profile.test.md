---
name: Profile changes are saved
tags: [settings, forms]
start: /login
setup:
  - request: POST /__test/seed
---

1. Use: flows/login.test.md
2. Go to the settings page
3. Fill "Full name" with Ada King
4. Select "Europe/London" in "Time zone"
5. Click "Save changes"
6. Expect: a message says "Profile saved"
7. Reload the page
8. Expect: "Full name" contains "Ada King"
9. Expect: "Time zone" is "Europe/London"
