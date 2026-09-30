import { registerSection } from "@testament/config";
import { z } from "zod";

// Setup and teardown hooks (AUT-10). `run` scripts start only when their
// command is listed here; `sql` statements go through a database client
// command with the connection string from a declared secret.

export interface HooksSettings {
  run: {
    /** Commands `run:` hooks may start: a program name (node, pnpm) or a project path glob (scripts/*). */
    allow: string[];
    /** Seconds before a hook is stopped. */
    timeoutSeconds: number;
  };
  sql: {
    /** The secret with the database connection string (e.g. TEST_DATABASE_URL). */
    connection?: string | undefined;
    /** The client that runs statements: psql (Postgres) or mysql. */
    client: "psql" | "mysql";
    timeoutSeconds: number;
  };
}

export const hooksSchema = z
  .strictObject({
    run: z
      .strictObject({
        allow: z
          .array(
            z
              .string()
              .min(1)
              .refine((c) => !c.split(/[\\/]/).includes(".."), "must stay inside the project"),
          )
          .describe(
            "Commands run: hooks may start: a program on the PATH (node, pnpm) or a project path glob (scripts/*).",
          ),
        timeoutSeconds: z
          .number()
          .positive()
          .max(600)
          .describe("Seconds before a run: hook is stopped."),
      })
      .describe("run: hooks."),
    sql: z
      .strictObject({
        connection: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/, "must be a secret name like TEST_DATABASE_URL")
          .optional()
          .describe("The declared secret holding the database connection string."),
        client: z
          .enum(["psql", "mysql"])
          .describe("The database client that runs statements: psql (Postgres) or mysql."),
        timeoutSeconds: z
          .number()
          .positive()
          .max(600)
          .describe("Seconds before a statement is stopped."),
      })
      .describe("sql: hooks."),
  })
  .describe("Setup and teardown hooks: what run: may start, and where sql: statements go.");

declare module "@testament/config" {
  interface ConfigSections {
    hooks: HooksSettings;
  }
}

/** Defaults live in the config package's defaults.yaml. */
registerSection({ key: "hooks", schema: hooksSchema });
