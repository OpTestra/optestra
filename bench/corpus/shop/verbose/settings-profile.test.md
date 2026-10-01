---
name: Profile changes are saved
tags: [settings, forms]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: verbose re-phrasing of tests/settings-profile.test.md -->

Profile edits need to survive a reload. The seeded user is already signed in. Go to the settings page, change "Full name" to Ada King and pick "Europe/London" as the "Time zone", then click "Save changes". The page should confirm with a "Profile saved" message. After reloading the page, the "Full name" field should still contain "Ada King" and the "Time zone" should still be "Europe/London".
