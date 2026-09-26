import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSecret, revealSecret } from "../reveal.js";
import { cleanup, sampleProject, tempDir } from "../sample.test-support.js";
import { loadProject } from "./project.js";
import { Redactor } from "./redactor.js";
import { registerSecretType } from "./secret-types.js";
import { createSecretValue, type SecretValue } from "./secret-value.js";
import { dotenvSource, memorySource, processEnvSource, resolveSecrets } from "./secrets.js";

afterEach(cleanup);

describe("SecretValue", () => {
  const redactor = new Redactor();
  const secret = createSecretValue("TEST_PASSWORD", "hunter2-xyz", {
    domains: ["a.test"],
    redactor,
  });

  it("never shows its value", () => {
    const outputs = [
      JSON.stringify({ secret }),
      inspect(secret),
      inspect({ nested: { secret } }, { showHidden: true, depth: 10 }),
      `${secret}`,
      String(secret),
      `x${secret}`,
      JSON.stringify({ ...secret }),
      JSON.stringify(Object.entries(secret)),
    ];
    for (const output of outputs) expect(output).not.toContain("hunter2");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret:TEST_PASSWORD]"}');
    expect(`${secret}`).toBe("[secret:TEST_PASSWORD]");
  });

  it("is readable only through the reveal accessor", () => {
    expect(revealSecret(secret)).toBe("hunter2-xyz");
    expect(secret.domains).toEqual(["a.test"]);
  });
});

describe("Redactor", () => {
  const redactor = new Redactor();
  const value = "p@ss word/+=é";
  redactor.register(value, "[secret:PW]");

  it("scrubs raw, URL-encoded, form-encoded, JSON-escaped and base64 forms", () => {
    const base64 = Buffer.from(value, "utf8").toString("base64");
    const text = [
      value,
      encodeURIComponent(value),
      encodeURIComponent(value).replace(/%20/g, "+"),
      JSON.stringify({ value }),
      base64,
      Buffer.from(value, "utf8").toString("base64url"),
    ].join(" | ");
    const redacted = redactor.redact(text);
    expect(redacted).not.toContain(value);
    expect(redacted).not.toContain(encodeURIComponent(value));
    expect(redacted).not.toContain(base64.replace(/=+$/, ""));
    expect(redacted.match(/\[secret:PW\]/g)?.length).toBe(6);
  });

  it("leaves other text alone", () => {
    expect(redactor.redact("nothing to see")).toBe("nothing to see");
  });
});

describe("secret sources", () => {
  it(".env.<environment> wins over .env, and the process environment wins over both", () => {
    const dir = tempDir({ ".env": "A=base\nB=base-b\n", ".env.staging": "A=staging\n" });
    const files = dotenvSource(dir, { redactor: new Redactor() });
    expect(revealSecret(files.get("A", "staging") as never)).toBe("staging");
    expect(revealSecret(files.get("B", "staging") as never)).toBe("base-b");
    expect(revealSecret(files.get("A", undefined) as never)).toBe("base");
    expect(files.get("C", "staging")).toBeUndefined();
    const sources = [processEnvSource({ A: "from-env" }), files];
    const config = { secrets: { A: { domains: ["x.test"] } } } as never;
    const resolved = resolveSecrets(config, sources, { environment: "staging" });
    expect(revealSecret(resolved.secrets.A as never)).toBe("from-env");
    expect(resolved.secrets.A?.domains).toEqual(["x.test"]);
  });

  it("memory source supports per-environment values", () => {
    const source = memorySource({ A: "all" }, { staging: { A: "stg" } });
    expect(revealSecret(source.get("A", "staging") as never)).toBe("stg");
    expect(revealSecret(source.get("A", "local") as never)).toBe("all");
  });

  it("reports SECRET_MISSING with the exact fix", () => {
    const dir = sampleProject();
    const loaded = loadProject(dir, { environment: "staging", env: {} });
    const result = resolveSecrets(loaded.config, [processEnvSource({}), dotenvSource(dir)], {
      environment: "staging",
      file: loaded.file,
    });
    expect(result.missing).toEqual([]);

    const empty = tempDir({ ".env": "API_TOKEN=abc123\n" });
    const missing = resolveSecrets(loaded.config, [processEnvSource({}), dotenvSource(empty)], {
      environment: "staging",
    });
    expect(missing.missing).toEqual(["TEST_PASSWORD"]);
    expect(missing.diagnostics[0]).toMatchObject({
      code: "SECRET_MISSING",
      severity: "error",
      path: "secrets.TEST_PASSWORD",
      fix: "Add TEST_PASSWORD=<value> to .env.staging, or set the TEST_PASSWORD environment variable",
    });
  });
});

describe("dynamic secrets (secret types)", () => {
  let counter = 0;
  registerSecretType({
    type: "totp",
    check: (stored) =>
      stored.startsWith("seed:")
        ? { ok: true, sensitive: [stored.slice(5)] }
        : { ok: false, problem: "not a seed", fix: "Use seed:<value>." },
    producer: () => async (stored) => `${stored.slice(5)}-code-${++counter}`,
  });

  it("types the produced value, registers it with the redactor, keeps the seed hidden", async () => {
    const redactor = new Redactor();
    const config = { secrets: { OTP: { domains: ["x.test"], type: "totp" } } } as never;
    const resolved = resolveSecrets(config, [
      memorySource({ OTP: "seed:abc987" }, {}, { redactor }),
    ]);
    const otp = resolved.secrets.OTP as SecretValue;
    expect(otp.type).toBe("totp");
    expect(otp.dynamic).toBe(true);
    expect(otp.domains).toEqual(["x.test"]);
    // The seed inside the stored value is registered too.
    expect(redactor.redact("seed abc987")).toBe("seed [secret:OTP]");
    const code = await prepareSecret(otp);
    expect(code).toMatch(/^abc987-code-\d+$/);
    expect(redactor.redact(`typed ${code}`)).toBe("typed [secret:OTP]");
    // revealSecret still gives the stored seed, never a code.
    expect(revealSecret(otp)).toBe("seed:abc987");
    expect(JSON.stringify({ otp })).toBe('{"otp":"[secret:OTP]"}');
  });

  it("plain secrets prepare to their value", async () => {
    const secret = createSecretValue("PW", "hunter3", { redactor: new Redactor() });
    expect(secret.dynamic).toBe(false);
    expect(secret.type).toBe("text");
    expect(await prepareSecret(secret)).toBe("hunter3");
  });

  it("reports SECRET_INVALID without the value, and for types nobody registered", () => {
    const config = {
      secrets: {
        OTP: { domains: ["x.test"], type: "totp" },
        ODD: { domains: ["x.test"], type: "hotp" },
      },
    } as never;
    const resolved = resolveSecrets(config, [
      memorySource({ OTP: "not-a-seed-4411", ODD: "v" }, {}, { redactor: new Redactor() }),
    ]);
    expect(resolved.secrets).toEqual({});
    expect(resolved.invalid).toEqual(["OTP", "ODD"]);
    expect(resolved.diagnostics.map((d) => d.code)).toEqual(["SECRET_INVALID", "SECRET_INVALID"]);
    expect(resolved.diagnostics[0]?.fix).toBe("Use seed:<value>.");
    expect(JSON.stringify(resolved.diagnostics)).not.toContain("not-a-seed-4411");
    expect(() =>
      registerSecretType({
        type: "totp",
        check: () => ({ ok: true }),
        producer: () => async () => "",
      }),
    ).toThrow(/already registered/);
  });
});
