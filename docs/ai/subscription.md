# Use your AI subscription

No API key? If you pay for Claude or ChatGPT, %Name% can use that plan. It does this through the vendor's **own official command-line tool**, which you install and sign in to yourself.

| Vendor | Plans | Tool | Sign in (in the vendor's tool) | Supported |
|---|---|---|---|---|
| Anthropic | Claude Pro, Max, Team, Enterprise | Claude Code 2.1.259 or newer | `claude auth login` | yes |
| OpenAI | ChatGPT Plus, Pro, Business, Enterprise | Codex (with the lock-down flags below) | `codex login` | yes |
| Google | Gemini, AI Pro, Ultra | | | **no**: Google doesn't allow Gemini CLI's Google sign-in to be used from other tools. Use a Gemini API key (`GEMINI_API_KEY`), which has a free tier |
| GitHub | Copilot | Copilot CLI | | **no**: we found no terms that clearly let a third-party tool drive it on your plan |

The `claude-code` and `codex` providers are in the default pools, after the API-key entries. With no API key and a signed-in Claude Code, planner and fixer simply work.

```sh
%cli% login              # which tools are ready, and the exact sign-in command
%cli% models --check     # installed (and version), recent enough, signed in
npx %cli% init --ai claude-code
```

`login` never signs in for you. `models --check` asks the tool's own status command and never reads its files.

## What %Name% does, and never does

- **Never touches your sign-in.** It never reads, copies, stores, logs or forwards the tool's tokens or config files. Sign-in happens only in the vendor's tool. It runs the unmodified binary, as you.
- **The tool is a model, not an agent.** Every one of the tool's own tools is off: no shell, no file reading or writing, no web fetch or search, no MCP servers, no plugins, hooks or skills, no project instruction files (`CLAUDE.md`, `AGENTS.md`) and no session history. It runs in a new, empty temporary folder, deleted afterwards. Its environment holds only `HOME`, `PATH`, `USER`, `LANG`, the Windows profile variables, the tool's own config-location variable if you set one, and the lock-down switches: none of your API keys or secrets. The browser is still only ever touched through %Name%'s closed action set.
- **Local only.** `models.allowDelegated` (default `true`) is `false` on our cloud workers: other people's runs never go through a subscription.
- **Honest about cost and limits.** Calls are recorded with billing "subscription" and cost $0 against the run budget; tokens and the tool's own cost estimate are kept for information. Advertised plan limits assume ordinary individual use, so each tool gets at most `models.delegatedCallsPerRun` calls per run (default 300). When the vendor says the plan limit is hit, the call fails over to the next pool entry, or stops with "Plan limit reached". The CLI and reports say "via your subscription".

## The exact commands

Claude Code (headless print mode, the prompt as stream-json on stdin):

```
claude -p --restricted --tools "" --disallowedTools "mcp__*" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
       --disable-slash-commands --no-session-persistence --permission-mode dontAsk --permission-prompts none
       --system-prompt <ours> --input-format stream-json --output-format stream-json --verbose
       --json-schema <reply schema> [--model <model>]
env: CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1
     CLAUDE_CODE_DISABLE_WORKFLOWS=1 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 CLAUDE_CODE_DISABLE_ATTACHMENTS=1
     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_SKIP_PROMPT_HISTORY=1 DISABLE_AUTOUPDATER=1
```

`--bare` is **not** used: bare mode ignores subscription sign-in. `--restricted`, which Anthropic built for evaluation harnesses, together with `--tools ""` gives the same lock-down while keeping your own sign-in.

Codex (the prompt on stdin):

```
codex exec --json --output-schema <file> --output-last-message <file> --sandbox read-only -c approval_policy="never"
      --skip-git-repo-check --ephemeral --ignore-user-config --cd <empty temp folder>
      -c features.shell_tool=false -c features.unified_exec=false -c features.multi_agent=false -c features.apps=false
      -c features.hooks=false -c features.memories=false -c web_search="disabled" -c tools.view_image=false
      -c project_doc_max_bytes=0 -c history.persistence="none" [--model …] [--image <file>…] -
```

Before first use, %Name% checks the version (`claude --version`) or the flags (`codex exec --help`). A tool without every lock-down flag is refused with the fix (`cli_unavailable`). On Windows the native `claude.exe` or `codex.exe` is needed, because `.cmd` shims would need a shell. Both argument lists are pinned by the engine's tests.

Since the tools' own tool calling is off, %Name%'s tools become a JSON Schema for the reply, and the reply is turned back into tool calls: the agent sees no difference. An invalid reply is retried once.

## The vendors' terms (checked 2026-09-26)

- **Anthropic** ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), "Authentication and credential use"): third parties may not offer Claude.ai login or route requests through Free, Pro or Max credentials on behalf of users, nor collect or store Claude.ai tokens; this does not prevent you from signing in to the unmodified Claude Code binary with your own Claude subscription. That is exactly and only what happens here.
- **OpenAI** ([Codex authentication](https://developers.openai.com/codex/auth)): ChatGPT sign-in is supported for Codex, and API keys remain the recommended default for automation. %Name% uses ChatGPT sign-in only on your own machine, for your own runs.
- **Google:** using Gemini CLI's Google sign-in from other tools is not allowed, so API keys only.
