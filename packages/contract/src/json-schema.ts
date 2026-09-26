import { z } from "zod";
import { EventSchema } from "./events.js";
import { RunSchema } from "./run.js";
import { TestResultSchema } from "./test-result.js";
import { CONTRACT_VERSION } from "./version.js";

type JsonSchema = Record<string, unknown>;

/**
 * Readers ignore unknown fields, so objects allow extra properties. Strict
 * objects (heal changes) keep `additionalProperties: false`.
 */
function toJsonSchema(schema: z.ZodType, title: string): JsonSchema {
  const json = z.toJSONSchema(schema, {
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      const def = zodSchema._zod.def;
      if (def.type === "object" && !("catchall" in def && def.catchall))
        delete jsonSchema.additionalProperties;
    },
  }) as JsonSchema;
  return { ...json, title, description: `Results contract ${CONTRACT_VERSION}. ${title}.` };
}

export const contractJsonSchemas = {
  run: () => toJsonSchema(RunSchema, "Run (run.json)"),
  testResult: () => toJsonSchema(TestResultSchema, "Test result (tests/<testId>/result.json)"),
  event: () => toJsonSchema(EventSchema, "Live event (one line of events.ndjson)"),
} as const;
