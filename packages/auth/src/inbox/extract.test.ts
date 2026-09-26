import { describe, expect, it } from "vitest";
import { extractCode, extractLinks, htmlToText, pickLink, urlAllowed } from "./extract.js";

// A corpus of realistic verification / login emails, including tricky ones with
// dates, prices, years, times, phone and order numbers near the code.

interface Case {
  name: string;
  subject?: string;
  text?: string;
  html?: string;
  code: string | undefined;
}

const CODES: Case[] = [
  {
    name: "Acme Shop sign-up (the fixture)",
    subject: "Your Acme Shop verification code",
    text: "Your verification code is 482913.\n\nEnter it on the sign-up page to finish creating your account.",
    code: "482913",
  },
  {
    name: "code in the subject",
    subject: "731904 is your Instaclone code",
    text: "Hi Ada, someone tried to sign in. If this was you, use the code in the subject.",
    code: "731904",
  },
  {
    name: "code on its own line",
    subject: "Confirm your email",
    text: "Welcome to Linear!\n\nHere is your login code:\n\n  580 213\n\nIt expires in 10 minutes.",
    code: "580213",
  },
  {
    name: "dashed code",
    text: "Your one-time passcode is 123-456. Do not share it.",
    code: "123456",
  },
  {
    name: "order number and price before the code",
    subject: "Order A-1003 confirmed",
    text: "Thanks for order #88213! Total: $29.00, charged on 2026-09-26.\nTo track it, verify your email with code 604211.",
    code: "604211",
  },
  {
    name: "date, time and year everywhere",
    text: "On Friday, 26 September 2026 at 14:05 we got a sign-in request.\nYour security code: 9981\nThis code is valid until 14:15 (UTC).\n© 2026 Example Inc.",
    code: "9981",
  },
  {
    name: "eight-digit code with invoice number",
    text: "Invoice no. 20260926 is attached.\nTo view it, enter the verification code 44871236.",
    code: "44871236",
  },
  {
    name: "alphanumeric code",
    subject: "Your Notion sign-in code",
    text: "Copy and paste this temporary login code: X7K2PQ\n\nIf you didn't try to log in, you can ignore this email.",
    code: "X7K2PQ",
  },
  {
    name: "all-caps word code after 'code is'",
    text: "Your confirmation code is HVTRWQ.",
    code: "HVTRWQ",
  },
  {
    name: "HTML only, code in a styled cell",
    html: `<html><head><style>.c{font-size:32px}</style></head><body>
<table><tr><td>Hello Ada,</td></tr>
<tr><td>Use this code to verify your account:</td></tr>
<tr><td class="c"><strong>275 118</strong></td></tr>
<tr><td>Questions? Call us at +1 (555) 123-4567.</td></tr>
<tr><td>&copy; 2026 Acme &amp; Co. &middot; 1200 Market St, Suite 400</td></tr></table></body></html>`,
    code: "275118",
  },
  {
    name: "phone number and zip code only (no code)",
    text: "Thanks for contacting support. Call 555 123 4567 or write to 1200 Market St, San Francisco, CA 94103.",
    code: undefined,
  },
  {
    name: "receipt with amounts and a year (no code)",
    subject: "Your receipt from Acme",
    text: "Receipt #4471-2291\nPro plan, 12 months: $348.00\nTax: 12.50 USD\nPaid on 09/26/2026.\nThanks for being a customer since 2019!",
    code: undefined,
  },
  {
    name: "newsletter with percentages and a year (no code)",
    text: "Save 20% this week only. Our 2026 collection is here. Offer ends in 3 days.",
    code: undefined,
  },
  {
    name: "code word far from a number (no code)",
    text: "Verify your email address to get started.\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nAcme Inc, 1200 Market St.",
    code: undefined,
  },
  {
    name: "PIN with 'minutes' number nearby",
    text: "Your PIN is 7215. It expires in 15 minutes.",
    code: "7215",
  },
  {
    name: "two-factor code after an account number",
    text: "Account 55120873: a sign-in needs your two-factor code.\nCode: 390017",
    code: "390017",
  },
  {
    name: "code with a month name nearby",
    text: "Sep 26, 2026\nYour Slack confirmation code: 8KX-49P is not how it works. Real code: 492088",
    code: "492088",
  },
  {
    name: "German-style date and a code",
    text: "Anmeldung am 26.09.2026 um 14:05.\nYour verification code: 661204",
    code: "661204",
  },
  {
    name: "OTP in brackets",
    text: "OTP: [ 840522 ]  (valid for 5 minutes)",
    code: "840522",
  },
  {
    name: "magic link email with no code",
    subject: "Sign in to Acme",
    text: "Click the link below to sign in. It expires in 15 minutes.\nhttps://app.acme.test/auth/magic?token=abc123",
    code: undefined,
  },
];

describe("extractCode", () => {
  for (const c of CODES) {
    it(c.name, () => {
      const { name: _name, code, ...message } = c;
      expect(extractCode(message)).toBe(code);
    });
  }
});

describe("htmlToText", () => {
  it("drops tags, styles and entities, one block per line", () => {
    expect(htmlToText("<style>p{}</style><p>A&nbsp;&amp;&nbsp;B</p><p>C<br>D</p>")).toBe(
      "A & B\nC\nD",
    );
  });
});

describe("extractLinks", () => {
  const html = `
<p><a href="https://app.acme.test/unsubscribe?u=1">Unsubscribe</a></p>
<p><a href="https://app.acme.test/help">Help center</a></p>
<p><a href="https://app.acme.test/verify?token=ok-7781&amp;email=ada%40example.com">Verify email</a></p>
<p><a href="https://evil.example/verify?token=ok-7781">Verify on evil</a></p>
<p><a href="mailto:help@acme.test">Mail us</a></p>
<img src="https://track.acme.test/pixel.gif">`;

  it("puts the verify link first, decodes entities and refuses other hosts", () => {
    const links = extractLinks({ html }, ["app.acme.test"]);
    expect(links.links.map((l) => l.url)).toEqual([
      "https://app.acme.test/verify?token=ok-7781&email=ada%40example.com",
      "https://app.acme.test/unsubscribe?u=1",
      "https://app.acme.test/help",
    ]);
    expect(links.links[0]?.kind).toBe("action");
    expect(links.refused.map((l) => l.host)).toEqual(["evil.example"]);
    expect(pickLink(links)?.url).toContain("/verify?token=ok-7781");
  });

  it("refuses a magic link to a host outside allowedDomains", () => {
    const text = "Sign in: https://login.other.test/magic?token=zz99 (expires soon).";
    const links = extractLinks({ text }, ["app.acme.test", "*.acme.test"]);
    expect(links.links).toEqual([]);
    expect(links.refused[0]?.url).toBe("https://login.other.test/magic?token=zz99");
    expect(pickLink(links)).toBeUndefined();
  });

  it("finds bare links in text, trimming punctuation", () => {
    const links = extractLinks(
      { text: "Confirm here: http://127.0.0.1:4100/verify?code=1. Thanks!" },
      ["127.0.0.1"],
    );
    expect(pickLink(links)?.url).toBe("http://127.0.0.1:4100/verify?code=1");
  });

  it("never picks an avoid-link as the link to follow", () => {
    const links = extractLinks(
      { html: '<a href="https://app.acme.test/unsubscribe">Unsubscribe</a>' },
      ["app.acme.test"],
    );
    expect(links.links).toHaveLength(1);
    expect(pickLink(links)).toBeUndefined();
  });
});

describe("urlAllowed (same rules as the browser allowlist)", () => {
  it("matches hosts, wildcards and ports; only http(s)", () => {
    expect(urlAllowed("https://acme.test/x", ["acme.test"])).toBe(true);
    expect(urlAllowed("https://www.acme.test/x", ["acme.test"])).toBe(false);
    expect(urlAllowed("https://www.acme.test/x", ["*.acme.test"])).toBe(true);
    expect(urlAllowed("https://acme.test/x", ["*.acme.test"])).toBe(false);
    expect(urlAllowed("http://127.0.0.1:4100/x", ["127.0.0.1"])).toBe(true);
    expect(urlAllowed("http://127.0.0.1:4100/x", ["127.0.0.1:4200"])).toBe(false);
    expect(urlAllowed("javascript:alert(1)", ["acme.test"])).toBe(false);
    expect(urlAllowed("https://acme.test.evil.example/", ["acme.test"])).toBe(false);
  });
});
