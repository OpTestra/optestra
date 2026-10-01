---
name: A user can upload an avatar
tags: [settings, files]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: mixed re-phrasing of tests/avatar-upload.test.md -->

1. Use: flows/login.test.md
2. Navigate to settings (the gear icon in the header)
3. Upload files/avatar.png to "Choose an image"
4. Then click the Upload avatar button so it actually uploads
5. Expect: a message says "Avatar updated"
6. Expect: the image "Your avatar" is visible
