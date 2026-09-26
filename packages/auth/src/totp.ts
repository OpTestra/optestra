import { createHmac } from "node:crypto";

// TOTP (RFC 6238) on top of HOTP (RFC 4226), with node:crypto only (SEC-4).
// Seeds come from a secret's value: a base32 seed or an otpauth:// URI.

export const TOTP_ALGORITHMS = ["SHA1", "SHA256", "SHA512"] as const;
export type TotpAlgorithm = (typeof TOTP_ALGORITHMS)[number];

export interface TotpSeed {
  /** The shared key (decoded). */
  key: Uint8Array;
  algorithm: TotpAlgorithm;
  /** Code length: 6 to 8 (default 6). */
  digits: number;
  /** Seconds per code (default 30). */
  period: number;
  /** The base32 text of the key as written (to register with the redactor). */
  base32: string;
}

export type ParsedSeed = { ok: true; seed: TotpSeed } | { ok: false; problem: string };

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes RFC 4648 base32 (case-insensitive; spaces, dashes and padding ignored). */
export function base32Decode(text: string): Uint8Array | undefined {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean === "" || !/^[A-Z2-7]+$/.test(clean)) return undefined;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Parses a TOTP secret's value: a base32 seed (`JBSWY3DPEHPK3PXP`) or an
 * `otpauth://totp/...?secret=...&digits=...&period=...&algorithm=...` URI.
 * Problems never include the value.
 */
export function parseTotpSeed(value: string): ParsedSeed {
  const text = value.trim();
  if (!/^otpauth:/i.test(text)) {
    const key = base32Decode(text);
    if (!key) return { ok: false, problem: "the value is not a base32 seed or an otpauth:// URI" };
    return { ok: true, seed: { key, algorithm: "SHA1", digits: 6, period: 30, base32: text } };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, problem: "the otpauth:// URI can't be parsed" };
  }
  if (url.host.toLowerCase() !== "totp") {
    return { ok: false, problem: `the otpauth:// URI is for "${url.host}", not totp` };
  }
  const secret = url.searchParams.get("secret") ?? "";
  const key = base32Decode(secret);
  if (!key) return { ok: false, problem: "the otpauth:// URI has no valid base32 secret=" };
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (!(TOTP_ALGORITHMS as readonly string[]).includes(algorithm)) {
    return { ok: false, problem: `algorithm=${algorithm} is not SHA1, SHA256 or SHA512` };
  }
  const digits = Number(url.searchParams.get("digits") ?? 6);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    return { ok: false, problem: "digits= must be 6, 7 or 8" };
  }
  const period = Number(url.searchParams.get("period") ?? 30);
  if (!Number.isInteger(period) || period < 1 || period > 300) {
    return { ok: false, problem: "period= must be a whole number of seconds from 1 to 300" };
  }
  return {
    ok: true,
    seed: { key, algorithm: algorithm as TotpAlgorithm, digits, period, base32: secret },
  };
}

/** HOTP (RFC 4226) for one counter value. */
export function hotp(
  key: Uint8Array,
  counter: number,
  digits = 6,
  algorithm: TotpAlgorithm = "SHA1",
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The TOTP code at `atMs` (default now). */
export function totp(seed: TotpSeed, atMs: number = Date.now()): string {
  return hotp(seed.key, Math.floor(atMs / 1000 / seed.period), seed.digits, seed.algorithm);
}

/** Milliseconds until the code at `atMs` expires. */
export function msRemaining(seed: TotpSeed, atMs: number = Date.now()): number {
  const periodMs = seed.period * 1000;
  return periodMs - (atMs % periodMs);
}

/** True when `code` is the code at `atMs`, or within `window` periods of it (clock drift). */
export function verifyTotp(seed: TotpSeed, code: string, atMs = Date.now(), window = 1): boolean {
  const counter = Math.floor(atMs / 1000 / seed.period);
  for (let d = -window; d <= window; d++) {
    if (hotp(seed.key, counter + d, seed.digits, seed.algorithm) === code) return true;
  }
  return false;
}

export interface FreshCodeOptions {
  /** Wait for the next code when the current one expires sooner than this (default 5). */
  minRemainingSeconds?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The code to type now. If fewer than `minRemainingSeconds` remain in the
 * current period, waits for the next period first, so the code is still valid
 * when the form is submitted.
 */
export async function freshTotp(seed: TotpSeed, options: FreshCodeOptions = {}): Promise<string> {
  const now = options.now ?? Date.now;
  const minMs = Math.min(options.minRemainingSeconds ?? 5, seed.period - 1) * 1000;
  const remaining = msRemaining(seed, now());
  if (remaining < minMs) await (options.sleep ?? defaultSleep)(remaining + 50);
  return totp(seed, now());
}
