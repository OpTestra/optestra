---
name: Profile changes are saved
tags: [settings, forms]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: acceptance re-phrasing of tests/settings-profile.test.md -->

As a signed-in user
I want my profile changes saved
So that they're still there next time

AC:
- On the settings page I set "Full name" to Ada King and "Time zone" to "Europe/London"
- Clicking "Save changes" shows "Profile saved"
- After reloading, "Full name" contains "Ada King"
- After reloading, "Time zone" is "Europe/London"
