---
name: A new project is saved
tags: [smoke, projects]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: gherkin re-phrasing of tests/create-project.test.md -->

Scenario: A new project is saved
  Given I am logged in via flows/login.test.md
  When I click "Create project"
  Then a dialog titled "New project" should be open
  When I fill "Project name" with Q3 roadmap
  And I click "Create"
  Then I should see a message "Project created"
  And the projects list should show "Q3 roadmap"
  When I reload the page
  Then the projects list should still show "Q3 roadmap"
