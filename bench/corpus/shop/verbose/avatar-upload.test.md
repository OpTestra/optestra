---
name: A user can upload an avatar
tags: [settings, files]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: verbose re-phrasing of tests/avatar-upload.test.md -->

We need to make sure people can actually change their profile picture. Starting from the login page, sign in with the usual seeded account (flows/login.test.md does this), then head over to the settings page. In the avatar section there's a file picker called "Choose an image": pick files/avatar.png there and then press the "Upload avatar" button. Once the upload finishes the page should tell the user "Avatar updated", and the new picture, labelled "Your avatar", should actually be visible on the page.
