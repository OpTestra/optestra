import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { configJsonSchema } from "./json-schema.js";
import { SAMPLE_CONFIG_PATH } from "./sample.test-support.js";

describe("configJsonSchema", () => {
  const validator = z.fromJSONSchema(configJsonSchema() as Parameters<typeof z.fromJSONSchema>[0]);
  const sample = parse(readFileSync(SAMPLE_CONFIG_PATH, "utf8"));

  it("validates the sample project", () => {
    expect(validator.safeParse(sample).error?.issues).toBeUndefined();
  });

  it("rejects invalid values and unknown keys", () => {
    expect(validator.safeParse({ ...sample, run: { healPolicy: "sometimes" } }).success).toBe(
      false,
    );
    expect(validator.safeParse({ ...sample, typo: 1 }).success).toBe(false);
  });

  it("only requires settings without defaults", () => {
    expect(configJsonSchema().required).toEqual(["version", "project"]);
  });
});
