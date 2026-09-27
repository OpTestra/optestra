---
name: Profile changes are saved
tags: [settings, forms]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

1. Go to the settings page
2. Fill "Full name" with Ada King
3. Select "Europe/London" in "Time zone"
4. Click "Save changes"
5. Expect: a message says "Profile saved"
6. Reload the page
7. Expect: "Full name" contains "Ada King"
8. Expect: "Time zone" is "Europe/London"
