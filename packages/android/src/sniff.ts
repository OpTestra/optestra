// What a tunnelled connection is for, from its first bytes. The emulator hands the
// guard every TCP connection as `CONNECT <ip>:<port>`: it has no host name. The
// name comes from the client's first message: the TLS ClientHello's server name
// (SNI) or the HTTP Host header. Pure code, no I/O.

export type Sniffed =
  | { kind: "tls"; name: string | null }
  | { kind: "http"; name: string | null }
  | { kind: "unknown" }
  | { kind: "more" };

/** Largest first message the guard waits for. */
export const MAX_SNIFF_BYTES = 16 * 1024;

const METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT) /;

export function sniff(data: Uint8Array): Sniffed {
  if (data.length === 0) return { kind: "more" };
  if (data[0] === 0x16) return sniffTls(data);
  const text = Buffer.from(data.subarray(0, Math.min(data.length, MAX_SNIFF_BYTES))).toString(
    "latin1",
  );
  // A few bytes of what may become a method name: wait for more.
  if (text.length < 8 && /^[A-Z]+$/.test(text)) return { kind: "more" };
  if (METHODS.test(text)) {
    const end = text.indexOf("\r\n\r\n");
    if (end < 0)
      return data.length >= MAX_SNIFF_BYTES ? { kind: "http", name: null } : { kind: "more" };
    const host = /\r\nhost:[ \t]*([^\r\n]+)/i.exec(text.slice(0, end + 2))?.[1]?.trim() ?? null;
    return { kind: "http", name: host ? stripPort(host) : null };
  }
  return { kind: "unknown" };
}

/** `example.com:8080` → `example.com`; `[::1]:80` → `::1`. */
export function stripPort(host: string): string {
  if (host.startsWith("["))
    return host.slice(1, host.indexOf("]") > 0 ? host.indexOf("]") : undefined);
  const colon = host.lastIndexOf(":");
  return colon > 0 && host.indexOf(":") === colon ? host.slice(0, colon) : host;
}

/** Parses a TLS record carrying a ClientHello and returns its server_name, if any. */
function sniffTls(data: Uint8Array): Sniffed {
  if (data.length < 5) return { kind: "more" };
  const recordLength = ((data[3] ?? 0) << 8) | (data[4] ?? 0);
  if (data.length < 5 + recordLength) {
    return data.length >= MAX_SNIFF_BYTES ? { kind: "tls", name: null } : { kind: "more" };
  }
  const hello = data.subarray(5, 5 + recordLength);
  // Handshake header: type (1 = ClientHello), 3-byte length.
  if (hello[0] !== 0x01) return { kind: "tls", name: null };
  let at = 4;
  at += 2 + 32; // version, random
  const u8 = (i: number) => hello[i] ?? 0;
  const u16 = (i: number) => (u8(i) << 8) | u8(i + 1);
  at += 1 + u8(at); // session id
  at += 2 + u16(at); // cipher suites
  at += 1 + u8(at); // compression methods
  if (at + 2 > hello.length) return { kind: "tls", name: null };
  const extensionsEnd = at + 2 + u16(at);
  at += 2;
  while (at + 4 <= Math.min(extensionsEnd, hello.length)) {
    const type = u16(at);
    const length = u16(at + 2);
    const body = at + 4;
    if (type === 0x0000) {
      // server_name: list length, then entries of (type, length, name).
      let entry = body + 2;
      while (entry + 3 <= body + length) {
        const nameType = u8(entry);
        const nameLength = u16(entry + 1);
        if (nameType === 0) {
          const name = Buffer.from(hello.subarray(entry + 3, entry + 3 + nameLength)).toString(
            "ascii",
          );
          return { kind: "tls", name: name.toLowerCase() };
        }
        entry += 3 + nameLength;
      }
      return { kind: "tls", name: null };
    }
    at = body + length;
  }
  return { kind: "tls", name: null };
}
