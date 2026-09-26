import type { DelegatedKind } from "../config.js";

// MOD-6 / SAF-2: the delegated CLI is a model, not an agent. These are the exact,
// pinned argument lists and environments. Every tool of the CLI is off: no shell,
// no file access, no web, no MCP, no plugins/hooks/skills, no instruction files,
// no session history. A test pins them; the README lists them. Flags were taken
// from each vendor's official docs (checked 2026-09-26).

/** Oldest Claude Code with every flag below (`--permission-prompts` needs 2.1.259). */
export const CLAUDE_MIN_VERSION = "2.1.259";

/** Codex has no single documented version for these; we require the flags themselves. */
export const CODEX_REQUIRED_FLAGS = [
  "--json",
  "--output-schema",
  "--output-last-message",
  "--sandbox",
  "--skip-git-repo-check",
  "--ephemeral",
  "--ignore-user-config",
  "--image",
] as const;

export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

export interface ClaudeArgs {
  model: string;
  system: string;
  schema: string;
}

/** `claude` in headless print mode, restricted, with no tools at all. Prompt on stdin (stream-json). */
export function claudeArgs({ model, system, schema }: ClaudeArgs): string[] {
  return [
    "-p",
    // No command/code tools, only managed settings: Anthropic's mode for harnesses.
    "--restricted",
    // No built-in tools at all, and no MCP tools either.
    "--tools",
    "",
    "--disallowedTools",
    "mcp__*",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--disable-slash-commands",
    "--no-session-persistence",
    // Anything that would need a permission is denied, nobody is asked.
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    // Our prompt replaces Claude Code's agent prompt entirely.
    "--system-prompt",
    system,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    schema,
    ...(model && model !== "default" ? ["--model", model] : []),
  ];
}

export interface CodexArgs {
  model: string;
  schemaFile: string;
  lastMessageFile: string;
  workdir: string;
  images: string[];
}

/** `codex exec`, read-only, every tool feature off, no user config, ephemeral. Prompt on stdin. */
export function codexArgs({
  model,
  schemaFile,
  lastMessageFile,
  workdir,
  images,
}: CodexArgs): string[] {
  return [
    "exec",
    "--json",
    "--output-schema",
    schemaFile,
    "--output-last-message",
    lastMessageFile,
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--cd",
    workdir,
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.unified_exec=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.hooks=false",
    "-c",
    "features.memories=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "tools.view_image=false",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'history.persistence="none"',
    ...(model && model !== "default" ? ["--model", model] : []),
    ...images.flatMap((image) => ["--image", image]),
    "-",
  ];
}

/** Variables the CLI needs to find its own sign-in and run; nothing else is passed through. */
const PASS_THROUGH = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "LC_ALL",
  // Windows: where the vendor tool keeps its own sign-in.
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "HOMEDRIVE",
  "HOMEPATH",
];

/** Config-location overrides the user set for the vendor tool (paths, not secrets). */
const VENDOR_HOME: Record<DelegatedKind, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

const LOCKDOWN_ENV: Record<DelegatedKind, Record<string, string>> = {
  "claude-code": {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    DISABLE_AUTOUPDATER: "1",
  },
  codex: {},
};

/**
 * The child's whole environment: a few OS variables, the vendor's own config
 * location if the user moved it, and the lock-down switches. No API keys, no
 * secrets, nothing else from our process.
 */
export function delegatedEnv(
  kind: DelegatedKind,
  parent: Readonly<Record<string, string | undefined>>,
  tempDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...PASS_THROUGH, VENDOR_HOME[kind]]) {
    const value = parent[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  env.TMPDIR = tempDir;
  env.TEMP = tempDir;
  env.TMP = tempDir;
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  return { ...env, ...LOCKDOWN_ENV[kind] };
}

/** The vendor's own sign-in status command (never our reading of its files). */
export const STATUS_ARGS: Record<DelegatedKind, string[]> = {
  "claude-code": ["auth", "status"],
  codex: ["login", "status"],
};

/** What the user runs to sign in, in the vendor's own tool. We never run it for them. */
export const SIGN_IN_COMMAND: Record<DelegatedKind, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
};

export const INSTALL_HINT: Record<DelegatedKind, string> = {
  "claude-code":
    "Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash (see https://code.claude.com/docs/en/setup)",
  codex:
    "Install Codex: npm install -g @openai/codex (see https://developers.openai.com/codex/cli)",
};

export const BINARY_NAME: Record<DelegatedKind, string> = {
  "claude-code": "claude",
  codex: "codex",
};

export const VENDOR_LABEL: Record<DelegatedKind, string> = {
  "claude-code": "Claude subscription (Claude Code)",
  codex: "ChatGPT subscription (Codex)",
};
