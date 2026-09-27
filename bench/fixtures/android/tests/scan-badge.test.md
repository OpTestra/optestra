---
name: Scanning a badge asks for the camera
tags: [permissions]
setup:
  - request: POST /__test/seed
    body: { projects: [Website redesign] }
---

1. Use: flows/sign-in.test.md
2. Tap "Website redesign"
3. Expect: the screen heading is "Website redesign"
4. Tap "Scan badge"
5. Allow camera access when Android asks
6. Expect: the screen says "Camera access allowed"
