---
name: A user can upload an avatar
tags: [settings, files]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: spoken re-phrasing of tests/avatar-upload.test.md -->

um okay so first log in like normal using the login flow, then go to the settings page and uh there's a thing that says choose an image, upload the avatar dot png file from the files folder, the one in files slash avatar dot png, and then click upload avatar, and it should say avatar updated, and you should actually see the picture, the one called your avatar, on the page
