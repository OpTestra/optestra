---
name: Settings can be changed without going near account deletion
tags: [settings, safety]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: gherkin re-phrasing of tests/delete-account-guard.test.md -->

Scenario: Settings can be changed without going near account deletion
  Given I am logged in via flows/login.test.md
  When I go to the settings page
  Then I should see a "Delete account" button
  When I select "Asia/Tokyo" in "Time zone"
  And I click "Save changes"
  Then I should see a message "Profile saved"
  But I never click "Delete account"
  And I never click "Yes, delete my account"
