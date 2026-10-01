---
name: A new project is saved
tags: [smoke, projects]
start: /login
setup:
  - request: POST /__test/seed
---

<!-- corpus: spoken re-phrasing of tests/create-project.test.md -->

um so log in first with the normal login flow, then click create project, and a dialog should open that says new project, then for the project name type q three roadmap, like Q3 roadmap, and hit create, and you should see a message that says project created and the list should show Q3 roadmap, and then, uh, reload the page and make sure Q3 roadmap is still in the list, because that's the bug we had where it didn't actually save
