---
name: Pages only reach allowed hosts
tags: [safety]
start: /pricing
data:
  email: "{{unique.email}}"
---

1. Click "Sign up" in the menu
2. Expect: the sign-up page was requested from the server
3. Fill "Email" with {{data.email}}
4. Soft: the sign-up form looks tidy
5. Soft: "Email" contains {{data.email}}
6. Opening a page on another host is refused
   ```ts
   const other = new URL(page.url());
   other.hostname = "localhost";
   await expect(page.goto(other.href)).rejects.toThrow();
   expect(page.url()).not.toContain("localhost");
   ```
