import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The second layer of the network guard (SAF-1). Every session's browser context
// uses this as its proxy, with exactly the allowed hosts as the bypass list, so
// the browser sends anything that isn't allowed here: redirects to other hosts,
// worker traffic, prefetches, anything the route layer never saw. It refuses
// everything and records the target. It binds to 127.0.0.1 and never opens a
// connection of its own.

export const PROXY_HOST = "127.0.0.1";

export interface RefusalProxy {
  /** `http://127.0.0.1:<port>` */
  readonly server: string;
  close(): Promise<void>;
}

const FORBIDDEN =
  "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 38\r\nConnection: close\r\n\r\nBlocked: host not in allowed domains.\n";

/** Starts a proxy that refuses every request and reports each target to `onRefused`. */
export async function startRefusalProxy(
  onRefused: (target: string) => void,
): Promise<RefusalProxy> {
  const server = createServer((request, response) => {
    // Plain http through a proxy: the request line holds the absolute URL.
    onRefused(request.url ?? "");
    response.writeHead(403, { "content-type": "text/plain", connection: "close" });
    response.end("Blocked: host not in allowed domains.\n");
  });
  // https and wss: CONNECT host:port. Refuse the tunnel.
  server.on("connect", (request, socket) => {
    onRefused(request.url ?? "");
    socket.end(FORBIDDEN);
  });
  server.on("upgrade", (request, socket) => {
    onRefused(request.url ?? "");
    socket.end(FORBIDDEN);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, PROXY_HOST, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    server: `http://${PROXY_HOST}:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
