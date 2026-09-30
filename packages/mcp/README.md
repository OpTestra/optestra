# @testament/mcp

The MCP server for coding agents (AGT-1): `testament mcp` serves the project in
the current folder over stdio. Setup for Claude Code, Cursor and Codex, the
tool table and the agent instructions are in
[integrations/README.md](../../integrations/README.md).

| Import | Use |
|---|---|
| `@testament/mcp` | `serveStdio(ctx)`, `createServer(ctx)`, `callTool`, `toolSpecs()`, `TOOL_NAMES`, `RESOURCES`; the protocol layer `createHandler`, `serveStreams`, `PROTOCOL_VERSIONS` |
| `@testament/mcp/instructions` | `agentInstructions()`, `agentRules()`, `agentsSnippet()`, `appendAgentsSnippet(text)` (light: no engine) |

```ts
import { serveStdio } from "@testament/mcp";
await serveStdio({ project: "/path/to/project", env: process.env });
```

## Protocol

JSON-RPC 2.0, one message per line on stdin/stdout (the MCP stdio transport);
nothing else is written to stdout. Protocol versions 2025-06-18 (default),
2025-03-26 and 2024-11-05. Methods: `initialize`, `ping`, `tools/list`,
`tools/call`, `resources/list`, `resources/templates/list`, `resources/read`;
notifications `notifications/initialized` and `notifications/cancelled`
(aborts a running draft). Capabilities: tools and resources.

Hand-written instead of the official SDK: the server needs only this small
surface, it adds no dependency and no HTTP transport code to a package that
must stay local-only (no port, no requests of its own), and the protocol tests
(`src/server.test.ts`) pin every message.

## Tools

Every tool publishes an input schema (unknown arguments are refused) and an
output schema; results carry `structuredContent` and the same JSON as text.
Errors are tool results with `isError: true` and a message that says what to
do.

| Tool | Input | Output |
|---|---|---|
| `list_tests` | `tag?` | `project`, `testsDir`, `tests[]` (`id path name tags steps recorded problems`), `flows[]` |
| `get_test` | `path` | `path name text steps[] recorded findings[]` |
| `draft_test` | `sentence`, `start?`, `environment?` | `saved: false`, `status reason message name path text lintClean findings[] notes[] ai` |
| `save_test` | `path`, `text` | `saved: true`, `path`, `findings[]` |
| `run_tests` | `tests?[] tags?[] grep? environment? mode?` (`normal` or `replay-only`) | `runDir`, `summary` (the results summary, `@testament/report`), `evidence[]` |
| `get_results` | `runId?` | as `run_tests` |
| `explain` | `runId?`, `test?`, `ai?` | `explainRun` (DIA-6): per test the diagnosis, next steps and cited evidence; `ai: true` makes one model call |
| `list_heals` | `runId?` | `listHeals` (HEAL-0) |
| `accept_heal` | `ids[]` (or `["all"]`), `runId?` | `accepted[] skipped[] recordings[] specs[] warnings[]` |

Guarantees:
- **Nothing edits an existing test.** `save_test` writes new files only
  (`wx`), inside the tests folder, never in the recordings folder, and only
  when `checkTest` finds no error or warning. There is no tool that changes an
  `Expect:` line; `accept_heal` goes through `applyHeals`, which changes only a
  healed step's commands and refuses to touch checks.
- **`draft_test` never saves.** It returns the draft and the free path it
  would go to.
- **Local.** stdio only; the tools read and write the project folder and run
  the browser against the project's environments, like the CLI.

## Resources

`testament://docs/test-format` (the spec package's README: the file format and
lint rules) and `testament://docs/agents` (the instructions for agents).
