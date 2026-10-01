---
name: Settings can be changed without going near account deletion
tags: [settings, safety]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: sloppy re-phrasing of tests/delete-account-guard.test.md -->

1. Use: flows/login.test.md
2. go to the Settings page
3. Expect: a "Delete account" button is shown
4. Select "Asia/Tokyo" in "Timezone"
5. Click "Save"
6. Expect: a message says "Profile saved"

Never: click "Delete account"
Never: click "Yes, delete my account"
