---
name: A new project is saved
tags: [smoke, projects]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: verbose re-phrasing of tests/create-project.test.md -->

Creating a project is the core action of the app, so we want to be sure it is really saved and not just shown. Log in as the seeded user (use the shared login flow, flows/login.test.md). On the dashboard click "Create project"; a dialog titled "New project" should open. Type Q3 roadmap into the "Project name" field and click "Create". A message saying "Project created" should appear and the projects list should show "Q3 roadmap". Then reload the page: after the reload the projects list must still show "Q3 roadmap", otherwise the project was never persisted.
