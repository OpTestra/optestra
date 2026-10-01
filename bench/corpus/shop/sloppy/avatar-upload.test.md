---
name: A user can upload an avatar
tags: [settings, files]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: sloppy re-phrasing of tests/avatar-upload.test.md -->

1. Use: flows/login.test.md
2. go to setings
3. Upload files/avatar.png to "Choose image"
4. Expect: a message says "Avatar updated"
5. Expect: the image "Your avatar" is visble
