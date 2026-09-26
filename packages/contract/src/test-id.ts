const SAFE = /^[a-z0-9][a-z0-9._-]*$/;

/** FNV-1a, 32 bit, as 8 hex characters. */
function hash8(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Stable test id from the project-relative test path: the path without its
 * extension, "/" joined as "__", e.g. `tests/checkout/guest.md` →
 * `tests__checkout__guest`. Paths that need changing to be folder-safe
 * (capitals, spaces, other characters) get an 8-character hash suffix so two
 * paths never share an id, including on case-insensitive disks.
 */
export function testIdFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  const last = parts.pop() ?? "";
  const dot = last.lastIndexOf(".");
  parts.push(dot > 0 ? last.slice(0, dot) : last);
  const clean = parts.every((part) => SAFE.test(part));
  const id = parts
    .map((part) => part.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"))
    .join("__")
    .replace(/^[._-]+/, "");
  return clean && id !== "" ? id : `${id || "test"}-${hash8(normalized)}`;
}
