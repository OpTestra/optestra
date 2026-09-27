import { createHmac } from "node:crypto";

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the shop's optional two-factor login,
// so runs can prove TOTP secrets are typed by the harness (SEC-4).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function isBase32(seed: string): boolean {
  return /^[A-Z2-7]+=*$/i.test(seed.replace(/\s/g, "")) && seed.replace(/\s|=/g, "").length >= 16;
}

function decode(seed: string): Buffer {
  let bits = "";
  for (const char of seed.replace(/\s|=/g, "").toUpperCase())
    bits += ALPHABET.indexOf(char).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(seed: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", decode(seed)).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 0xf;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

/** The code is valid now, or one period before or after (clock drift). */
export function verifyTotp(seed: string, code: string, at = Date.now()): boolean {
  return [-1, 0, 1].some((drift) => totpCode(seed, at + drift * 30_000) === code.trim());
}
