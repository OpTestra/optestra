---
name: A user can upload an avatar
tags: [settings, files]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: terse re-phrasing of tests/avatar-upload.test.md -->

1. Use: flows/login.test.md
2. go to settings
3. upload files/avatar.png as the avatar
4. hit upload avatar
5. expect: avatar updated message
6. expect: image "Your avatar" visible
