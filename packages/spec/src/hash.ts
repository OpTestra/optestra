const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a, 64 bit, over UTF-8. Same result on every OS and in the browser. */
export function fnv64(text: string): bigint {
  let hash = OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return hash;
}

/** `fnv64` as 16 hex characters. */
export function hash16(text: string): string {
  return fnv64(text).toString(16).padStart(16, "0");
}
