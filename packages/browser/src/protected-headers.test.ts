import { describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
import { basicAuthValue, HeaderScope } from "./protected-headers.js";

const scope = new HeaderScope(
  [
    { name: "X-Vercel-Protection-Bypass", value: "tok", domains: ["*.vercel.app"] },
    {
      name: "Authorization",
      value: basicAuthValue("u", "p"),
      domains: ["pr-1.vercel.app"],
      keepExisting: true,
    },
  ],
  new Allowlist(["*.vercel.app", "api.example.com"]),
);

describe("protected-preview header scope", () => {
  it("adds headers only for allowed hosts in the header's domains", () => {
    expect(scope.apply("https://pr-1.vercel.app/", { accept: "*/*" })).toEqual({
      accept: "*/*",
      "x-vercel-protection-bypass": "tok",
      authorization: "Basic dTpw",
    });
    expect(scope.apply("https://pr-2.vercel.app/x", {})).toEqual({
      "x-vercel-protection-bypass": "tok",
    });
    // Allowed, but not in any header's domains.
    expect(scope.apply("https://api.example.com/", {})).toBeUndefined();
    // In a header's domains pattern but not allowed... *.vercel.app is allowed; a lookalike is not.
    expect(scope.apply("https://vercel.app.evil.com/", {})).toBeUndefined();
    expect(scope.apply("not a url", {})).toBeUndefined();
  });

  it("keeps a request's own Authorization and replaces other headers of the same name", () => {
    expect(
      scope.apply("https://pr-1.vercel.app/", {
        Authorization: "Bearer app",
        "X-VERCEL-PROTECTION-BYPASS": "stale",
      }),
    ).toEqual({ Authorization: "Bearer app", "x-vercel-protection-bypass": "tok" });
  });
});
