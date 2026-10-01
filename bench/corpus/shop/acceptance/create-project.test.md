---
name: A new project is saved
tags: [smoke, projects]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: acceptance re-phrasing of tests/create-project.test.md -->

As a team member
I want to create a project
So that my work is organised

AC:
- Log in using flows/login.test.md
- Clicking "Create project" opens a dialog titled "New project"
- Filling "Project name" with Q3 roadmap and clicking "Create" shows a message "Project created"
- The projects list shows "Q3 roadmap"
- After a page reload the projects list still shows "Q3 roadmap"
