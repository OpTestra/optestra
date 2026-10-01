import { memorySource, Redactor, resolveSecrets } from "@optestra/config/node";
import { prepareSecret, revealSecret } from "@optestra/config/reveal";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./index.js";
import {
  base32Decode,
  base32Encode,
  freshTotp,
  hotp,
  msRemaining,
  parseTotpSeed,
  type TotpSeed,
  totp,
  verifyTotp,
} from "./totp.js";

const ascii = (text: string) => new TextEncoder().encode(text);
const seedOf = (key: string, algorithm: TotpSeed["algorithm"], digits = 8): TotpSeed => ({
  key: ascii(key),
  algorithm,
  digits,
  period: 30,
  base32: base32Encode(ascii(key)),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RFC 6238 test vectors (Appendix B)", () => {
  const seeds = {
    SHA1: seedOf("12345678901234567890", "SHA1"),
    SHA256: seedOf("12345678901234567890123456789012", "SHA256"),
    SHA512: seedOf("1234567890123456789012345678901234567890123456789012345678901234", "SHA512"),
  };
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [time, sha1, sha256, sha512] of vectors) {
    it(`T=${time}`, () => {
      expect(totp(seeds.SHA1, time * 1000)).toBe(sha1);
      expect(totp(seeds.SHA256, time * 1000)).toBe(sha256);
      expect(totp(seeds.SHA512, time * 1000)).toBe(sha512);
    });
  }

  it("HOTP matches RFC 4226 Appendix D", () => {
    const key = ascii("12345678901234567890");
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(["755224", "287082", "359152", "520489"]);
  });
});

describe("seeds", () => {
  it("decodes base32 case-insensitively, ignoring spaces, dashes and padding", () => {
    expect(base32Decode("jbsw y3dp-ehpk 3pxp==")).toEqual(base32Decode("JBSWY3DPEHPK3PXP"));
    expect(new TextDecoder().decode(base32Decode("JBSWY3DP"))).toBe("Hello");
    expect(base32Decode("not base32!")).toBeUndefined();
    expect(base32Decode("")).toBeUndefined();
    const bytes = ascii("round trip bytes");
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("parses a plain base32 seed with the defaults", () => {
    const parsed = parseTotpSeed("  JBSWY3DPEHPK3PXP ");
    expect(parsed.ok && parsed.seed).toMatchObject({ algorithm: "SHA1", digits: 6, period: 30 });
  });

  it("honours digits, period and algorithm in an otpauth:// URI", () => {
    const parsed = parseTotpSeed(
      "otpauth://totp/Acme:ada@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Acme&algorithm=SHA256&digits=8&period=60",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.seed).toMatchObject({ algorithm: "SHA256", digits: 8, period: 60 });
    expect(new TextDecoder().decode(parsed.seed.key)).toBe("12345678901234567890");
    // Period 60: T=59 s and T=0 s are the same step.
    expect(totp(parsed.seed, 59_000)).toBe(totp(parsed.seed, 0));
    expect(totp(parsed.seed, 59_000)).toHaveLength(8);
  });

  it("rejects bad seeds without echoing them", () => {
    const bad = [
      "hunter2!",
      "otpauth://hotp/x?secret=JBSWY3DP&counter=1",
      "otpauth://totp/x?issuer=Acme",
      "otpauth://totp/x?secret=JBSWY3DP&algorithm=MD5",
      "otpauth://totp/x?secret=JBSWY3DP&digits=4",
      "otpauth://totp/x?secret=JBSWY3DP&period=0",
    ];
    for (const value of bad) {
      const parsed = parseTotpSeed(value);
      expect(parsed.ok, value).toBe(false);
      if (!parsed.ok) expect(parsed.problem).not.toContain("JBSWY3DP");
    }
  });

  it("verifies codes within one period of drift", () => {
    const parsed = parseTotpSeed("JBSWY3DPEHPK3PXP");
    if (!parsed.ok) throw new Error("seed");
    const now = 1_700_000_000_000;
    expect(verifyTotp(parsed.seed, totp(parsed.seed, now - 30_000), now)).toBe(true);
    expect(verifyTotp(parsed.seed, totp(parsed.seed, now - 90_000), now)).toBe(false);
  });
});

describe("fresh codes", () => {
  const parsed = parseTotpSeed("JBSWY3DPEHPK3PXP");
  if (!parsed.ok) throw new Error("seed");
  const { seed } = parsed;

  it("types the current code when enough of the period is left", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_699_999_990_000); // 10 s into a 30 s period
    expect(msRemaining(seed)).toBe(20_000);
    await expect(freshTotp(seed)).resolves.toBe(totp(seed, 1_699_999_990_000));
  });

  it("waits for the next code when fewer than minRemainingSeconds are left", async () => {
    vi.useFakeTimers();
    const start = 1_700_000_007_000; // 3 s left
    vi.setSystemTime(start);
    let code: string | undefined;
    const pending = freshTotp(seed, { minRemainingSeconds: 5 }).then((c) => {
      code = c;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(code).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_100);
    await pending;
    expect(code).toBe(totp(seed, start + 3_050));
    expect(code).not.toBe(totp(seed, start));
  });
});

describe("the totp secret type", () => {
  const config = {
    secrets: { ADMIN_TOTP: { domains: ["app.example.com"], type: "totp" } },
    auth: { profiles: {}, totp: { minRemainingSeconds: 5 } },
  } as never;

  it("types the current code; the seed and every code are redacted", async () => {
    const redactor = new Redactor();
    const uri = "otpauth://totp/Acme?secret=JBSWY3DPEHPK3PXP&issuer=Acme";
    const { secrets, diagnostics } = resolveSecrets(config, [
      memorySource({ ADMIN_TOTP: uri }, {}, { redactor }),
    ]);
    expect(diagnostics).toEqual([]);
    const secret = secrets.ADMIN_TOTP;
    if (!secret) throw new Error("secret");
    expect(secret.type).toBe("totp");
    expect(secret.domains).toEqual(["app.example.com"]);
    const code = await prepareSecret(secret);
    const parsed = parseTotpSeed(uri);
    if (!parsed.ok) throw new Error("seed");
    expect(verifyTotp(parsed.seed, code)).toBe(true);
    // revealSecret gives the stored seed, never a code (only prepareSecret types codes).
    expect(revealSecret(secret)).toBe(uri);
    const log = redactor.redact(
      `seed=JBSWY3DPEHPK3PXP uri=${uri} code=${code} lower=jbswy3dpehpk3pxp`,
    );
    expect(log).not.toContain("JBSWY3DPEHPK3PXP");
    expect(log).not.toContain(code);
    expect(log).toContain("code=[secret:ADMIN_TOTP]");
  });

  it("reports a bad seed as SECRET_INVALID with the fix, never the value", () => {
    const { secrets, invalid, diagnostics } = resolveSecrets(config, [
      memorySource({ ADMIN_TOTP: "my-password-123" }, {}, { redactor: new Redactor() }),
    ]);
    expect(secrets).toEqual({});
    expect(invalid).toEqual(["ADMIN_TOTP"]);
    expect(diagnostics[0]).toMatchObject({ code: "SECRET_INVALID", path: "secrets.ADMIN_TOTP" });
    expect(diagnostics[0]?.fix).toContain("otpauth://");
    expect(JSON.stringify(diagnostics)).not.toContain("my-password-123");
  });
});
