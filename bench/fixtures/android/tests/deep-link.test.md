---
name: A project link opens the project
tags: [links]
setup:
  - request: POST /__test/seed
    body: { projects: [Mobile launch] }
---

1. Use: flows/sign-in.test.md
2. Open the link acmeshop://projects/Mobile%20launch
3. Expect: the screen heading is "Mobile launch"
