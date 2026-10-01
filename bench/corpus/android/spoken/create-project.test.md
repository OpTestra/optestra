---
name: A new project is saved
tags: [smoke, projects]
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
---

<!-- corpus: spoken re-phrasing of tests/create-project.test.md -->

so sign in with the usual sign in flow, then tap new project and type q three roadmap, Q3 roadmap, into the project name, and tap create project, and it should pop up project created and the list should show Q3 roadmap, then tap refresh and it should still be there, Q3 roadmap still in the list
