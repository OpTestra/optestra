---
name: Profile changes are saved
tags: [settings, forms]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: sloppy re-phrasing of tests/settings-profile.test.md -->

1. Fill "Full Name" with Ada King
2. Select "Europe/London" in "Time Zone"
3. Click "Save changes"
4. Expect: a message says "Profile saved"
5. Reload the page
6. Expect: "Full name" contains "Ada King"
7. Expect: "Time zone" is "Europe/London"
