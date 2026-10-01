---
name: Settings can be changed without going near account deletion
tags: [settings, safety]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: mixed re-phrasing of tests/delete-account-guard.test.md -->

1. Use: flows/login.test.md
2. Go to the settings page
3. Expect: a "Delete account" button is shown
4. Change the time zone dropdown to Asia/Tokyo
5. Click "Save changes"
6. Expect: a message says "Profile saved"

Never: click "Delete account"
Never: click "Yes, delete my account"
