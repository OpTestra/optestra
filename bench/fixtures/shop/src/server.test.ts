import { createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningShop, startShop } from "./server.js";
import { parseSmtpTarget } from "./smtp.js";
import { DEFAULT_USER, verificationCode } from "./store.js";
import { type Variant, VARIANTS } from "./variants.js";

const running: RunningShop[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((shop) => shop.stop()));
});

async function shop(variant: Variant = "correct", mailpitSmtp?: string) {
  const started = await startShop({ variant, mailpitSmtp });
  running.push(started);
  let cookie = "";
  const call = async (method: string, path: string, body?: string | object) => {
    const isJson = typeof body === "object";
    const response = await fetch(`${started.url}${path}`, {
      method,
      redirect: "manual",
      headers: {
        cookie,
        ...(body === undefined
          ? {}
          : { "content-type": isJson ? "application/json" : "application/x-www-form-urlencoded" }),
      },
      body: isJson ? JSON.stringify(body) : (body ?? null),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0] ?? "";
    return {
      status: response.status,
      location: response.headers.get("location"),
      text: await response.text(),
    };
  };
  const login = () =>
    call("POST", "/login", `email=${DEFAULT_USER.email}&password=${DEFAULT_USER.password}`);
  return { url: started.url, call, login };
}

describe("fixture shop server", () => {
  it("binds to loopback only", async () => {
    const { url } = await shop();
    expect(new URL(url).hostname).toBe("127.0.0.1");
  });

  it("serves identical pages after a restart (no randomness)", async () => {
    const script = async () => {
      const { call } = await shop("cosmetic");
      const pages: string[] = [];
      for (const path of ["/", "/pricing", "/signup?plan=pro", "/login"]) {
        pages.push((await call("GET", path)).text);
      }
      await call("POST", "/signup", "email=new%40example.com&password=long-enough&plan=pro");
      const code = verificationCode("new@example.com");
      pages.push(
        (await call("POST", "/verify", `email=new%40example.com&plan=pro&code=${code}`)).location ??
          "",
      );
      for (const path of ["/checkout?plan=pro", "/dashboard", "/billing", "/settings", "/orders"]) {
        pages.push((await call("GET", path)).text);
      }
      pages.push((await call("GET", "/api/projects")).text);
      pages.push((await call("GET", "/__test/outbox")).text);
      return pages;
    };
    const first = await script();
    await Promise.all(running.splice(0).map((s) => s.stop()));
    expect(await script()).toEqual(first);
  });

  it("sends only same-origin content (CSP) and no external URLs in pages", async () => {
    const { url } = await shop();
    const response = await fetch(`${url}/pricing`);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await response.text()).not.toMatch(/(src|href)="https?:/);
  });

  it("signs up with an emailed code and logs in", async () => {
    const { call, login } = await shop();
    const signup = await call("POST", "/signup", "email=Bo%40Example.com&password=long-enough");
    expect(signup.location).toBe("/verify?email=Bo%40Example.com");
    const outbox = JSON.parse((await call("GET", "/__test/outbox?to=bo@example.com")).text);
    expect(outbox.emails[0].text).toContain(verificationCode("bo@example.com"));
    const wrong = await call("POST", "/verify", "email=bo%40example.com&code=000000");
    expect(wrong.status).toBe(400);
    await call("POST", "/__test/seed", {});
    expect((await login()).location).toBe("/dashboard");
  });

  it("shows validation errors before anything else", async () => {
    const { call } = await shop("broken-signup");
    const result = await call("POST", "/signup", "email=nope&password=short");
    expect(result.status).toBe(400);
    expect(result.text).toContain("Enter a valid email address, like name@example.com.");
    expect(result.text).toContain("Password must be at least 8 characters.");
    expect(result.text).toContain('aria-invalid="true"');
  });

  it("broken-signup: a valid sign-up returns a 500 page", async () => {
    const { call } = await shop("broken-signup");
    const result = await call("POST", "/signup", "email=a%40example.com&password=long-enough");
    expect(result.status).toBe(500);
    expect(result.text).toContain("Something went wrong");
  });

  it("broken-total: billing charges the plan price during a trial", async () => {
    for (const [variant, due] of [
      ["correct", "$0.00 due today"],
      ["broken-total", "$29.00 due today"],
    ] as const) {
      const { call, login } = await shop(variant);
      await call("POST", "/__test/seed", { trial: "pro" });
      await login();
      expect((await call("GET", "/billing")).text).toContain(due);
    }
  });

  it("broken-login-redirect: login lands on an error page with no session", async () => {
    const { call, login } = await shop("broken-login-redirect");
    await call("POST", "/__test/seed", {});
    expect((await login()).location).toBe("/error?reason=login");
    expect((await call("GET", "/dashboard")).location).toBe("/login?next=%2Fdashboard");
  });

  it("broken-silent-click: the create button has no JS hook", async () => {
    const hook = 'data-js="open-create"';
    for (const [variant, wired] of [
      ["correct", true],
      ["broken-silent-click", false],
    ] as const) {
      const { call, login } = await shop(variant);
      await call("POST", "/__test/seed", {});
      await login();
      expect((await call("GET", "/dashboard")).text.includes(hook)).toBe(wired);
    }
  });

  it("broken-not-saved: the API answers 201 but keeps nothing", async () => {
    const { call, login } = await shop("broken-not-saved");
    await call("POST", "/__test/seed", {});
    await login();
    const created = await call("POST", "/api/projects", { name: "Q3 roadmap" });
    expect(created.status).toBe(201);
    expect(JSON.parse((await call("GET", "/api/projects")).text).projects).toEqual([]);
  });

  it("env-flaky: every 2nd projects request fails, once per environment reset", async () => {
    const { call, login } = await shop("env-flaky");
    await call("POST", "/__test/seed", {});
    await login();
    const statuses = async (n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await call("GET", "/api/projects")).status);
      return out;
    };
    expect(await statuses(4)).toEqual([200, 503, 200, 200]);
    await call("POST", "/__test/reset");
    await call("POST", "/__test/seed", {});
    await login();
    expect(await statuses(2)).toEqual([200, 200]);
    await call("POST", "/__test/reset?environment=1");
    await call("POST", "/__test/seed", {});
    await login();
    expect(await statuses(2)).toEqual([200, 503]);
  });

  it("only env-flaky ever answers 503", async () => {
    for (const variant of VARIANTS.filter((v) => v !== "env-flaky")) {
      const { call, login } = await shop(variant);
      await call("POST", "/__test/seed", {});
      await login();
      for (let i = 0; i < 4; i++) {
        expect((await call("GET", "/api/projects")).status, variant).not.toBe(503);
      }
    }
  });

  it("declines the declined test card and accepts 4242", async () => {
    const { call, login } = await shop();
    await call("POST", "/__test/seed", {});
    await login();
    const token = async (number: string) =>
      JSON.parse((await call("POST", "/pay/tokens", { number, expiry: "12/34", cvc: "123" })).text)
        .token as string;
    const declined = await call("POST", "/api/subscribe", {
      plan: "pro",
      token: await token("4000 0000 0000 0002"),
    });
    expect(declined.status).toBe(402);
    expect(declined.text).toContain("Your card was declined.");
    const ok = await call("POST", "/api/subscribe", {
      plan: "pro",
      token: await token("4242 4242 4242 4242"),
    });
    expect(JSON.parse(ok.text).redirect).toBe("/dashboard?welcome=pro");
    const bad = await call("POST", "/pay/tokens", { number: "1234", expiry: "12/34", cvc: "1" });
    expect(bad.status).toBe(400);
  });

  it("seeds users with projects and a trial, and resets", async () => {
    const { call } = await shop();
    await call("POST", "/__test/seed", { email: "x@example.com", trial: "team", projects: ["A"] });
    const state = JSON.parse((await call("GET", "/__test/state")).text);
    expect(state.users).toEqual([
      { email: "x@example.com", verified: true, plan: "team", projects: ["A"] },
    ]);
    await call("POST", "/__test/reset");
    expect(JSON.parse((await call("GET", "/__test/state")).text).users).toEqual([]);
    expect((await call("POST", "/__test/seed", { trial: "gold" })).status).toBe(400);
  });

  it("deletes an account only through the confirm form", async () => {
    const { call, login } = await shop();
    await call("POST", "/__test/seed", {});
    await login();
    expect((await call("GET", "/settings")).text).toContain('role="alertdialog"');
    const deleted = await call("POST", "/settings/delete");
    expect(deleted.location).toBe("/?deleted=1");
    expect(JSON.parse((await call("GET", "/__test/state")).text).users).toEqual([]);
  });
});

describe("Mailpit SMTP path", () => {
  it("refuses a non-loopback SMTP host", () => {
    expect(() => parseSmtpTarget("mail.example.com:25")).toThrow(/loopback/);
    expect(parseSmtpTarget("127.0.0.1:1025")).toEqual({ host: "127.0.0.1", port: 1025 });
  });

  it("delivers the verification email to a local SMTP server", async () => {
    const received: string[] = [];
    const smtp = createTcpServer((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 fake\r\n");
      let data = false;
      socket.on("data", (chunk: string) => {
        received.push(chunk);
        if (data) {
          if (chunk.includes("\r\n.\r\n")) {
            data = false;
            socket.write("250 queued\r\n");
          }
          return;
        }
        if (chunk.startsWith("DATA")) {
          data = true;
          socket.write("354 go\r\n");
        } else if (chunk.startsWith("QUIT")) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      });
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    const address = smtp.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const { call } = await shop("correct", `127.0.0.1:${port}`);
      await call("POST", "/signup", "email=mail%40example.com&password=long-enough");
      await expect
        .poll(() => received.join(""))
        .toContain(`Your verification code is ${verificationCode("mail@example.com")}`);
      expect(received.join("")).toContain("RCPT TO:<mail@example.com>");
    } finally {
      smtp.close();
    }
  });
});
