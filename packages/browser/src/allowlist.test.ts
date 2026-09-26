import { describe, expect, it } from "vitest";
import { Allowlist, parseAllowEntry } from "./allowlist.js";

describe("allowlist", () => {
  const list = new Allowlist(["example.com", "*.shop.test", "api.example.org:8443", "127.0.0.1"]);

  it("matches exact hosts on any port", () => {
    expect(list.allowsUrl("https://example.com/a")).toBe(true);
    expect(list.allowsUrl("http://EXAMPLE.com:8080/a")).toBe(true);
    expect(list.allowsUrl("http://127.0.0.1:4100/checkout")).toBe(true);
    expect(list.allowsUrl("https://www.example.com/")).toBe(false);
    expect(list.allowsUrl("https://example.com.evil.test/")).toBe(false);
    expect(list.allowsUrl("https://notexample.com/")).toBe(false);
  });

  it("matches wildcards on subdomains only", () => {
    expect(list.allowsUrl("https://a.shop.test/")).toBe(true);
    expect(list.allowsUrl("https://a.b.shop.test/")).toBe(true);
    expect(list.allowsUrl("https://shop.test/")).toBe(false);
    expect(list.allowsUrl("https://evilshop.test/")).toBe(false);
  });

  it("checks the port only when the entry names one", () => {
    expect(list.allowsUrl("https://api.example.org:8443/")).toBe(true);
    expect(list.allowsUrl("https://api.example.org/")).toBe(false);
    expect(list.allowsUrl("http://api.example.org:8080/")).toBe(false);
  });

  it("treats localhost and 127.0.0.1 as different hosts", () => {
    expect(list.allowsUrl("http://localhost:4100/")).toBe(false);
  });

  it("refuses every non-http scheme", () => {
    for (const url of [
      "data:text/html,hi",
      "blob:http://example.com/uuid",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "chrome://settings",
      "about:blank",
      "ftp://example.com/",
      "ws://example.com/",
      "not a url",
    ]) {
      expect(list.allowsUrl(url), url).toBe(false);
    }
  });

  it("builds a proxy bypass list of exactly the allowed hosts, loopback not implied", () => {
    expect(list.proxyBypass()).toBe(
      "<-loopback>,example.com,*.shop.test,api.example.org:8443,127.0.0.1",
    );
    expect(new Allowlist([]).proxyBypass()).toBe("<-loopback>");
  });

  it("reports invalid entries and never matches them", () => {
    const bad = new Allowlist(["exa mple.com", "http://x.com", "*", "ok.com:99999"]);
    expect(bad.invalid).toEqual(["exa mple.com", "http://x.com", "*", "ok.com:99999"]);
    expect(bad.entries).toEqual([]);
    expect(parseAllowEntry("*.Example.COM:80")).toEqual({
      host: "example.com",
      wildcard: true,
      port: 80,
    });
  });
});
