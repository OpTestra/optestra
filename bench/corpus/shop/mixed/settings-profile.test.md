---
name: Profile changes are saved
tags: [settings, forms]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: mixed re-phrasing of tests/settings-profile.test.md -->

1. Go to the settings page
2. Change the full name to Ada King
3. Select "Europe/London" in "Time zone"
4. Click "Save changes"
5. Expect: a message says "Profile saved"
6. Reload the page
7. Expect: "Full name" contains "Ada King"
8. Expect: "Time zone" is "Europe/London"
