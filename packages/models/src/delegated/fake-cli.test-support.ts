import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake `claude` / `codex` for tests: a small Node script that records what it
// was given (argv, stdin, env, cwd, pid) and answers from a behaviour file. No
// real CLI, no network.

export interface FakeBehaviour {
  version?: string;
  signedIn?: boolean;
  /** codex: flags printed by `exec --help`. */
  helpFlags?: string[];
  /** One entry per call (the last repeats). */
  replies: Array<
    | { kind: "ok"; value: unknown; usage?: { input: number; output: number } }
    | { kind: "auth" }
    | { kind: "plan" }
    | { kind: "hang" }
    | { kind: "malformed" }
    | { kind: "crash" }
  >;
}

export interface FakeCall {
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  pid: number;
  filesInCwd: string[];
}

const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const self = __filename;
const behaviour = JSON.parse(fs.readFileSync(self + ".behaviour.json", "utf8"));
const logFile = self + ".log.jsonl";
const argv = process.argv.slice(2);
const kind = self.includes("codex") ? "codex" : "claude";
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const isCall = kind === "claude" ? argv[0] === "-p" : argv[0] === "exec" && argv[1] !== "--help";
  if (isCall) {
    const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).length : 0;
    fs.appendFileSync(logFile, JSON.stringify({ argv, stdin, env: process.env, cwd: process.cwd(), pid: process.pid, filesInCwd: fs.readdirSync(process.cwd()) }) + "\n");
    const reply = behaviour.replies[Math.min(calls, behaviour.replies.length - 1)];
    return answer(reply);
  }
  if (argv[0] === "--version") return done((behaviour.version || "2.1.300") + (kind === "claude" ? " (Claude Code)" : ""), 0);
  if (kind === "claude" && argv[0] === "auth") return done(behaviour.signedIn === false ? '{"loggedIn":false}' : '{"loggedIn":true,"email":"private@example.com"}', behaviour.signedIn === false ? 1 : 0);
  if (kind === "codex" && argv[0] === "login") return done(behaviour.signedIn === false ? "Not logged in" : "Logged in using ChatGPT", behaviour.signedIn === false ? 1 : 0);
  if (kind === "codex" && argv[0] === "exec" && argv[1] === "--help") return done((behaviour.helpFlags || []).join("\n"), 0);
  done("unknown command", 2);
});
function done(text, code) { process.stdout.write(text + "\n"); process.exit(code); }
function answer(reply) {
  if (reply.kind === "hang") { setInterval(() => {}, 1000); return; }
  if (reply.kind === "crash") { process.stderr.write("segfault-ish\n"); process.exit(3); }
  const usage = reply.usage || { input: 120, output: 30 };
  if (kind === "claude") {
    const base = { type: "result", session_id: "s", total_cost_usd: 0.0123, usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [] }) + "\n");
    if (reply.kind === "auth") return done(JSON.stringify({ ...base, subtype: "success", is_error: true, result: "Not logged in · Please run /login" }), 1);
    if (reply.kind === "plan") return done(JSON.stringify({ ...base, subtype: "success", is_error: true, result: "You've reached your usage limit. Resets at 5pm." }), 1);
    if (reply.kind === "malformed") return done(JSON.stringify({ ...base, subtype: "success", is_error: false, result: "Sure! I'll click it." }), 0);
    return done(JSON.stringify({ ...base, subtype: "success", is_error: false, result: "", structured_output: reply.value }), 0);
  }
  const out = argv[argv.indexOf("--output-last-message") + 1];
  if (reply.kind === "auth") return done(JSON.stringify({ type: "error", message: "401 Unauthorized: please run codex login" }), 1);
  if (reply.kind === "plan") return done(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } }), 1);
  fs.writeFileSync(out, reply.kind === "malformed" ? "not json" : JSON.stringify(reply.value));
  done(JSON.stringify({ type: "turn.completed", usage: { input_tokens: usage.input, cached_input_tokens: 0, output_tokens: usage.output } }), 0);
}
`;

export interface FakeCli {
  /** Path to pass as `binary:` (a .cjs script, run with Node). */
  path: string;
  calls(): FakeCall[];
  setBehaviour(behaviour: FakeBehaviour): void;
}

/** Creates a fake CLI. `asExecutable` also writes an extensionless executable named like the real binary (POSIX). */
export function fakeCli(
  kind: "claude" | "codex",
  behaviour: FakeBehaviour,
  options: { asExecutable?: boolean } = {},
): FakeCli & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `fake-${kind}-`));
  const path = options.asExecutable ? join(dir, kind) : join(dir, `${kind}.cjs`);
  writeFileSync(path, `${options.asExecutable ? "#!/usr/bin/env node\n" : ""}${SCRIPT}`);
  if (options.asExecutable) chmodSync(path, 0o755);
  const setBehaviour = (b: FakeBehaviour) =>
    writeFileSync(`${path}.behaviour.json`, JSON.stringify(b));
  setBehaviour(behaviour);
  return {
    dir,
    path,
    setBehaviour,
    calls: () => {
      try {
        return readFileSync(`${path}.log.jsonl`, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeCall);
      } catch {
        return [];
      }
    },
  };
}

export const CODEX_HELP = [
  "--json",
  "--output-schema",
  "--output-last-message",
  "--sandbox",
  "--skip-git-repo-check",
  "--ephemeral",
  "--ignore-user-config",
  "--image",
];
