---
name: Settings can be changed without going near account deletion
tags: [settings, safety]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: acceptance re-phrasing of tests/delete-account-guard.test.md -->

As a user editing my settings
I want account deletion kept out of my way
So that I never delete my account by accident

AC:
- After logging in (flows/login.test.md) the settings page shows a "Delete account" button
- I can select "Asia/Tokyo" in "Time zone" and click "Save changes"
- A message says "Profile saved"
- The test never clicks "Delete account" and never clicks "Yes, delete my account"
