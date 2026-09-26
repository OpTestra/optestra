import { connect } from "node:net";

// Minimal SMTP client for a local Mailpit inbox (SEC-5). It only ever talks to
// loopback: anything else is refused before a socket is opened.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface SmtpTarget {
  host: string;
  port: number;
}

/** Parses `MAILPIT_SMTP` ("127.0.0.1:1025"). Throws on a non-loopback host. */
export function parseSmtpTarget(value: string): SmtpTarget {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) throw new Error(`MAILPIT_SMTP must be host:port, got "${value}"`);
  if (!LOOPBACK.has(match[1])) {
    throw new Error(`MAILPIT_SMTP must point at loopback (127.0.0.1), got "${match[1]}"`);
  }
  return { host: match[1], port: Number(match[2]) };
}

export function sendSmtp(
  target: SmtpTarget,
  mail: { from: string; to: string; subject: string; text: string },
): Promise<void> {
  if (!LOOPBACK.has(target.host)) return Promise.reject(new Error("SMTP host must be loopback"));
  const body = mail.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  const script = [
    "EHLO acme-shop.localhost",
    `MAIL FROM:<${mail.from}>`,
    `RCPT TO:<${mail.to}>`,
    "DATA",
    `From: Acme Shop <${mail.from}>\r\nTo: <${mail.to}>\r\nSubject: ${mail.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.`,
    "QUIT",
  ];
  return new Promise((resolve, reject) => {
    const socket = connect(target.port, target.host);
    let buffer = "";
    let step = 0;
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy(new Error("SMTP timeout")));
    socket.on("error", reject);
    socket.on("close", () =>
      step >= script.length ? resolve() : reject(new Error("SMTP closed")),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // A reply is complete when its last line has a space after the code ("250 OK").
      const lines = buffer.split("\r\n");
      const last = lines[lines.length - 2];
      if (!last || !/^\d{3} /.test(last)) return;
      buffer = "";
      if (!/^[23]/.test(last)) {
        socket.destroy(new Error(`SMTP error: ${last}`));
        return;
      }
      const next = script[step++];
      if (next === undefined) socket.end();
      else socket.write(`${next}\r\n`);
    });
  });
}
