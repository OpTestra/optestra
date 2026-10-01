---
name: A user can upload an avatar
tags: [settings, files]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: gherkin re-phrasing of tests/avatar-upload.test.md -->

Scenario: A user can upload an avatar
  Given I am logged in via flows/login.test.md
  When I go to the settings page
  And I upload files/avatar.png to "Choose an image"
  And I click "Upload avatar"
  Then I should see a message "Avatar updated"
  And the image "Your avatar" should be visible
