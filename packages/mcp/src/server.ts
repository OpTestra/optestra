import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { agentInstructions } from "./instructions.js";
import { type ResourceSpec, type ServerDefinition, serveStreams } from "./protocol.js";
import { callTool, type ToolContext, toolSpecs } from "./tools.js";

// The server (AGT-1): the tools on one local project, over stdio. It opens no
// port and makes no requests of its own; running tests reaches only the app
// under test, like the CLI (guarantee 5).

export const RESOURCES = {
  format: `${brand.cliName}://docs/test-format`,
  agents: `${brand.cliName}://docs/agents`,
} as const;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return (pkg as { version: string }).version;
}

/** The test file format and lint reference: the spec package's README. */
function formatReference(): string {
  const entry = fileURLToPath(import.meta.resolve("@optestra/spec"));
  return readFileSync(join(dirname(entry), "..", "README.md"), "utf8");
}

const resources: ResourceSpec[] = [
  {
    uri: RESOURCES.format,
    name: "test-format",
    title: "Test file format",
    description:
      "The .test.md format: frontmatter, steps, Expect:/Soft:/Never:/Use:/Exact: lines, variables and secrets, and the lint rules.",
    mimeType: "text/markdown",
  },
  {
    uri: RESOURCES.agents,
    name: "agent-instructions",
    title: "Instructions for coding agents",
    description: `How to use ${brand.productName} from a coding agent, and the rules (never edit an expectation to make a test pass).`,
    mimeType: "text/markdown",
  },
];

export function createServer(ctx: ToolContext): ServerDefinition {
  return {
    name: brand.cliName,
    version: version(),
    instructions: `${brand.productName} runs this project's plain-English end-to-end tests. Run them after changes (run_tests), read failures from the summary (failingCheck, failingStep, file), and never change an Expect: line to make a test pass: the expectations are the specification. Read ${RESOURCES.agents} for the rules and ${RESOURCES.format} for the file format.`,
    tools: toolSpecs(),
    resources,
    callTool: (name, args, signal) => callTool(name, args, ctx, signal),
    async readResource(uri) {
      if (uri === RESOURCES.format) return { text: formatReference(), mimeType: "text/markdown" };
      if (uri === RESOURCES.agents) return { text: agentInstructions(), mimeType: "text/markdown" };
      return undefined;
    },
  };
}

/** Serves the project over stdin/stdout until stdin ends. Logs go to stderr only. */
export function serveStdio(
  ctx: ToolContext,
  streams: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
  return serveStreams(
    createServer(ctx),
    (streams.input ?? process.stdin) as import("node:stream").Readable,
    (streams.output ?? process.stdout) as import("node:stream").Writable,
  );
}
