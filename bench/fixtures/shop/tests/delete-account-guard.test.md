---
name: Settings can be changed without going near account deletion
tags: [settings, safety]
start: /login
setup:
  - request: POST /__test/seed
---

1. Use: flows/login.test.md
2. Go to the settings page
3. Expect: a "Delete account" button is shown
4. Select "Asia/Tokyo" in "Time zone"
5. Click "Save changes"
6. Expect: a message says "Profile saved"

Never: click "Delete account"
Never: click "Yes, delete my account"
