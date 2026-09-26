---
name: A user can upload an avatar
tags: [settings, files]
start: /login
setup:
  - request: POST /__test/seed
---

1. Use: flows/login.test.md
2. Go to the settings page
3. Upload files/avatar.png to "Choose an image"
4. Click "Upload avatar"
5. Expect: a message says "Avatar updated"
6. Expect: the image "Your avatar" is visible
