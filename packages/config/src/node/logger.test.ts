import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { Redactor } from "./redactor.js";

describe("logger", () => {
  const redactor = new Redactor();
  redactor.register("s3cr3t value", "[secret:PW]");
  const lines: string[] = [];
  const log = createLogger({ redactor, level: "info", sink: (line) => lines.push(line) });

  it("scrubs secrets from messages and fields in every form", () => {
    log.info("typing s3cr3t value into the form", {
      url: `https://x.test/?pw=${encodeURIComponent("s3cr3t value")}`,
      header: Buffer.from("s3cr3t value").toString("base64"),
    });
    log.error("failed", { error: new Error("bad s3cr3t value") });
    expect(lines.join("\n")).not.toMatch(/s3cr3t|czNjcjN0/);
    expect(lines[0]).toContain("[secret:PW]");
    expect(lines[1]).toBe('error failed {"error":{"name":"Error","message":"bad [secret:PW]"}}');
  });

  it("drops lines below the level", () => {
    const before = lines.length;
    log.debug("hidden");
    expect(lines.length).toBe(before);
  });
});
