---
name: Settings can be changed without going near account deletion
tags: [settings, safety]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: terse re-phrasing of tests/delete-account-guard.test.md -->

1. Use: flows/login.test.md
2. settings
3. expect: delete account button there
4. time zone -> Asia/Tokyo
5. save changes
6. expect: "Profile saved"

Never: click "Delete account"
Never: click "Yes, delete my account"
