---
name: A user can upload an avatar
tags: [settings, files]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: acceptance re-phrasing of tests/avatar-upload.test.md -->

As a signed-in user
I want to upload a profile picture
So that my teammates recognise me

Acceptance criteria:
- I log in with the standard login flow (flows/login.test.md)
- On the settings page I can upload files/avatar.png using "Choose an image"
- After I click "Upload avatar" a message says "Avatar updated"
- The image "Your avatar" is visible
