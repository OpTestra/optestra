# Integrations for coding agents

Testament gives coding agents (Claude Code, Cursor, Codex, any MCP client) the
same tests a person runs: they can list, run and read them, draft new ones,
and accept heals. They can't change what a test checks.

| File | What it is |
|---|---|
| `agents/AGENTS.md` | The snippet for your repository's `AGENTS.md` or `CLAUDE.md`: how to use the CLI and the MCP server, and the rules (never edit an `Expect:` line to make a test pass). `testament init` offers to append it (asked first; `--agents` to do it without asking). |
| `claude-code/skills/testament/SKILL.md` | The same instructions as a Claude Code skill, with the workflow after a code change. Copy the folder to `.claude/skills/testament/` in your repository (or `~/.claude/skills/`). |

## The MCP server

`testament mcp` serves the project in the current folder over stdio. It opens
no port and makes no network requests of its own; running tests reaches only
your app, like `testament run`.

Claude Code, from the project folder:

```bash
claude mcp add testament -- npx testament mcp
```

Cursor (`.cursor/mcp.json`), Codex (`~/.codex/config.toml`) and other clients
run the same command:

```json
{ "mcpServers": { "testament": { "command": "npx", "args": ["testament", "mcp"] } } }
```

```toml
[mcp_servers.testament]
command = "npx"
args = ["testament", "mcp"]
```

Options: `-C <project>` (another folder), `--env <name>` (the default
environment), `--headed` (show the browsers).

### Tools

| Tool | Does | Changes files |
|---|---|---|
| `list_tests` | The tests: file, name, tags, steps, recorded or not, lint problems. | no |
| `get_test` | One test's text, steps and lint findings. | no |
| `draft_test` | Explores the running app and drafts a test for one sentence. Returns the draft and where it would go. | no |
| `save_test` | Saves a **new** test file. Refuses to overwrite a file, and refuses text with lint errors or warnings. | a new file only |
| `run_tests` | Runs tests (all, files, tags, a name filter; `mode: replay-only` for no AI). Returns the results summary. | the run folder |
| `get_results` | A run's results summary (default: the latest) and each test's evidence files. | no |
| `list_heals` | A run's heals: the recording's before and after, why, confidence. | no |
| `accept_heal` | Applies heals to the recordings. Only the healed steps' commands change; checks never do. | recordings |

There is no tool that edits an existing test or an `Expect:` line.

The results summary (`run_tests`, `get_results`) has, per test: `verdict`,
`cause`, `headline`, `failingCheck` (the expectation as written, what was
expected and what was seen), `failingStep`, `file`, `screenshot`, heals and
AI use. Its JSON Schema is the tool's output schema.

### Resources

- `testament://docs/test-format`: the `.test.md` format and the lint rules.
- `testament://docs/agents`: the instructions above.
