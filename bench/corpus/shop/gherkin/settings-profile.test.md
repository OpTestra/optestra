---
name: Profile changes are saved
tags: [settings, forms]
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

<!-- corpus: gherkin re-phrasing of tests/settings-profile.test.md -->

Scenario: Profile changes are saved
  Given I am logged in as the seeded user
  When I go to the settings page
  And I fill "Full name" with Ada King
  And I select "Europe/London" in "Time zone"
  And I click "Save changes"
  Then I should see a message "Profile saved"
  When I reload the page
  Then "Full name" should contain "Ada King"
  And "Time zone" should be "Europe/London"
