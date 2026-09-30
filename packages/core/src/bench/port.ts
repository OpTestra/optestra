import { createServer } from "node:net";

// Is a loopback port free? Bench asks before starting the Android fixture's
// backend on its fixed port. It only listens on 127.0.0.1, never connects.

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
