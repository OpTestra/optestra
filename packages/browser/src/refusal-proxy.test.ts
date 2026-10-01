import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startRefusalProxy } from "./refusal-proxy.js";

describe("refusal proxy", () => {
  it("refuses a CONNECT tunnel, and a client resetting it doesn't crash the process", async () => {
    const refused: string[] = [];
    const proxy = await startRefusalProxy((target) => refused.push(target));
    const { port } = new URL(proxy.server);
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    process.on("uncaughtException", onError);
    try {
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) => {
          const socket = connect(Number(port), "127.0.0.1", () => {
            socket.write(
              "CONNECT update.example.com:443 HTTP/1.1\r\nHost: update.example.com:443\r\n\r\n",
            );
            // Reset at once, as a browser closing a background connection does.
            socket.resetAndDestroy();
          });
          socket.on("error", () => {});
          socket.on("close", () => resolve());
        });
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onError);
      await proxy.close();
    }
    expect(refused.every((t) => t === "update.example.com:443")).toBe(true);
  });
});
