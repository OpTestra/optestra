import { describe, expect, it } from "vitest";
import { mergeLayers } from "./merge.js";

describe("mergeLayers", () => {
  const { value, provenance } = mergeLayers([
    {
      source: "default",
      value: { run: { retries: 1, mode: "normal" }, list: ["a", "b"], vars: {} },
    },
    {
      source: "project",
      value: { run: { retries: 2 }, list: ["c"] },
      describe: () => ({ file: "p.yaml", line: 3 }),
    },
    {
      source: "environment",
      value: { run: { mode: "rerecord" } },
      describe: () => ({ environment: "staging" }),
    },
    {
      source: "envVar",
      value: { run: { retries: 5 } },
      describe: () => ({ envVar: "X_RUN_RETRIES" }),
    },
    { source: "runOption", value: { list: ["z"], run: { mode: null } } },
  ]);

  it("applies layers lowest to highest, deep-merging objects", () => {
    expect(value).toEqual({ run: { retries: 5, mode: "rerecord" }, list: ["z"], vars: {} });
  });

  it("replaces arrays instead of concatenating", () => {
    expect(value.list).toEqual(["z"]);
  });

  it("records where every leaf came from", () => {
    expect(provenance.get("run.retries")).toEqual({ source: "envVar", envVar: "X_RUN_RETRIES" });
    expect(provenance.get("run.mode")).toEqual({ source: "environment", environment: "staging" });
    expect(provenance.get("list")).toEqual({ source: "runOption" });
    expect(provenance.get("vars")).toEqual({ source: "default" });
  });
});
