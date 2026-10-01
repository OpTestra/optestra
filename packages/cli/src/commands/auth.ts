import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkProfiles,
  createInbox,
  extractCode,
  extractLinks,
  pickLink,
  type SessionEntry,
  SessionStore,
} from "@optestra/auth";
import type { Diagnostic } from "@optestra/config";
import {
  defaultRedactor,
  dotenvSource,
  findProject,
  loadProject,
  processEnvSource,
} from "@optestra/config/node";
import type { Command } from "commander";
import type { CommandIo } from "./config.js";

export interface AuthCommandOptions {
  env?: string;
  dir?: string;
  json?: boolean;
  /** true = every saved session; a string = that profile's. */
  clear?: boolean | string;
}

export interface InboxCommandOptions {
  env?: string;
  dir?: string;
  json?: boolean;
  to?: string;
  /** Seconds to wait for a message (inbox last). */
  wait?: string;
}

function table(rows: string[][], indent = "  "): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
          .join("  "),
    )
    .join("\n");
}

function load(options: { env?: string; dir?: string }, io: CommandIo) {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  const found = !loaded.diagnostics.some((d) => d.code === "PROJECT_NOT_FOUND");
  return { dir, loaded, found };
}

const problem = (d: Pick<Diagnostic, "severity" | "message" | "fix">) =>
  `  ${d.severity}: ${d.message}${d.fix ? `\n    fix: ${d.fix}` : ""}`;

type SessionStatus = "valid" | "expired" | "none";

interface ProfileRow {
  profile: string;
  flow: string;
  reuse: string;
  ttlMinutes: number;
  inSettings: boolean;
  environments: Record<
    string,
    { status: SessionStatus; workers: number; validUntil?: string | undefined }
  >;
}

function summarize(entries: SessionEntry[]): ProfileRow["environments"][string] {
  const valid = entries.filter((e) => e.status === "valid");
  if (valid.length > 0) {
    const until = valid.map((e) => e.expiresAt ?? "").sort()[0];
    return { status: "valid", workers: valid.length, validUntil: until };
  }
  return entries.length > 0
    ? { status: "expired", workers: entries.length }
    : { status: "none", workers: 0 };
}

/** `auth`: profiles and their saved sessions per environment; `--clear [profile]` deletes them. */
export function runAuthCommand(options: AuthCommandOptions, io: CommandIo): number {
  const { dir, loaded, found } = load(options, io);
  if (!found) {
    io.stdout("No project here. Run this inside a project folder, or pass -C <dir>.\n");
    return 2;
  }
  const store = new SessionStore({ projectDir: dir });

  if (options.clear !== undefined && options.clear !== false) {
    const profile = typeof options.clear === "string" ? options.clear : undefined;
    const removed = store.clear({
      ...(profile && { profile }),
      ...(options.env && { environment: options.env }),
    });
    const what = `${profile ? `profile ${profile}` : "all profiles"}${options.env ? ` in ${options.env}` : ""}`;
    io.stdout(
      options.json
        ? `${JSON.stringify({ cleared: removed, profile: profile ?? null, environment: options.env ?? null })}\n`
        : `Deleted ${removed} saved session${removed === 1 ? "" : "s"} (${what}).\n`,
    );
    return 0;
  }

  const profiles = loaded.config.auth?.profiles ?? {};
  const environments = Object.keys(loaded.config.environments ?? {});
  if (environments.length === 0) environments.push("default");
  const entries = store.list();
  const names = [...new Set([...Object.keys(profiles), ...entries.map((e) => e.profile)])].sort();
  const rows: ProfileRow[] = names.map((name) => {
    const profile = profiles[name];
    return {
      profile: name,
      flow: profile?.flow ?? "",
      reuse: profile?.reuse ?? "",
      ttlMinutes: profile?.ttlMinutes ?? 0,
      inSettings: profile !== undefined,
      environments: Object.fromEntries(
        environments.map((env) => [
          env,
          summarize(entries.filter((e) => e.profile === name && e.environment === env)),
        ]),
      ),
    };
  });
  const testsDir = join(dir, loaded.config.tests?.dir ?? "tests");
  const diagnostics = checkProfiles(
    { profiles },
    (flow) => existsSync(join(testsDir, flow)),
    loaded.file,
  );

  if (options.json) {
    io.stdout(
      `${defaultRedactor.redact(JSON.stringify({ sessionsDir: store.dir, profiles: rows, sessions: entries, diagnostics }, null, 2))}\n`,
    );
    return diagnostics.length > 0 ? 1 : 0;
  }
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push(
      "No auth profiles. Add one under auth.profiles in the project file, e.g.",
      "",
      "  auth:",
      "    profiles:",
      "      admin:",
      "        flow: flows/login-admin.test.md",
      "        check: { url: /dashboard }",
    );
  } else {
    const cell = (s: ProfileRow["environments"][string]) =>
      s.status === "valid"
        ? `valid until ${s.validUntil?.slice(11, 16)} UTC (${s.workers} session${s.workers === 1 ? "" : "s"})`
        : s.status;
    lines.push(
      "Profiles",
      table([
        ["PROFILE", "FLOW", "REUSE", "TTL", ...environments.map((e) => e.toUpperCase())],
        ...rows.map((r) => [
          r.profile,
          r.inSettings ? r.flow : "(not in the project settings)",
          r.reuse,
          r.inSettings ? `${r.ttlMinutes} min` : "",
          ...environments.map((e) => cell(r.environments[e] ?? { status: "none", workers: 0 })),
        ]),
      ]),
    );
    if (entries.length > 0)
      lines.push(
        "",
        "Saved sessions (per profile, environment and worker)",
        table([
          ["PROFILE", "ENVIRONMENT", "WORKER", "STATUS"],
          ...entries.map((e) => [
            e.profile,
            e.environment,
            e.worker,
            e.status === "valid"
              ? `valid until ${e.expiresAt?.slice(0, 16).replace("T", " ")} UTC`
              : e.status,
          ]),
        ]),
      );
    lines.push(
      "",
      `Saved sessions: ${store.dir} (owner-only, git-ignored). Delete them with --clear [profile] [-e env].`,
    );
  }
  if (diagnostics.length > 0) lines.push("", "Problems", ...diagnostics.map(problem));
  io.stdout(`${defaultRedactor.redact(lines.join("\n"))}\n`);
  return diagnostics.length > 0 ? 1 : 0;
}

function inboxFor(options: InboxCommandOptions, io: CommandIo) {
  const { dir, loaded, found } = load(options, io);
  const created = createInbox(loaded.config, {
    sources: [processEnvSource(io.env), dotenvSource(dir)],
    environment: loaded.environment?.name,
  });
  return { loaded, found, created };
}

/** `inbox check`: the configured provider is reachable and its key valid. */
export async function runInboxCheck(options: InboxCommandOptions, io: CommandIo): Promise<number> {
  const { loaded, created } = inboxFor(options, io);
  const provider = loaded.config.inbox?.provider ?? "none";
  if (!created.ok) {
    io.stdout(
      options.json
        ? `${JSON.stringify({ provider, ok: false, status: created.reason, message: created.message, fix: created.fix })}\n`
        : `Inbox  ${provider}\n\n${problem({ severity: "error", message: created.message, fix: created.fix ?? "" })}\n`,
    );
    return 2;
  }
  const check = await created.inbox.check();
  io.stdout(
    defaultRedactor.redact(
      options.json
        ? `${JSON.stringify(check)}\n`
        : `Inbox  ${check.provider} (${check.host})\nStatus ${check.status === "ok" ? "ok" : check.status}: ${check.message}${check.fix ? `\nFix    ${check.fix}` : ""}\n`,
    ),
  );
  return check.ok ? 0 : 1;
}

/** `inbox last --to <address>`: the latest message's subject and extracted code/link. Never the body. */
export async function runInboxLast(options: InboxCommandOptions, io: CommandIo): Promise<number> {
  if (!options.to) {
    io.stdout("Pass the address: inbox last --to <address>\n");
    return 2;
  }
  const { loaded, created } = inboxFor(options, io);
  if (!created.ok) {
    io.stdout(
      `${problem({ severity: "error", message: created.message, fix: created.fix ?? "" })}\n`,
    );
    return 2;
  }
  const waitSeconds = Number(options.wait ?? 5);
  const result = await created.inbox.waitForMessage({
    to: options.to,
    since: new Date(0),
    timeoutMs: (Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 5) * 1000,
  });
  if (!result.ok) {
    io.stdout(
      options.json
        ? `${JSON.stringify({ ok: false, reason: result.reason, message: result.message })}\n`
        : `${result.reason === "timeout" ? `No email to ${options.to}.` : result.message}${result.fix ? `\nFix: ${result.fix}` : ""}\n`,
    );
    return 1;
  }
  const { message } = result;
  const allowed = loaded.environment?.settings.allowedDomains ?? [];
  const links = extractLinks(message, allowed);
  const link = pickLink(links);
  const summary = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    receivedAt: message.receivedAt,
    code: extractCode(message) ?? null,
    link: link?.url ?? null,
    refusedLinks: links.refused.map((l) => l.host),
  };
  if (options.json) {
    io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  const lines = [
    `From      ${summary.from}`,
    `To        ${summary.to.join(", ")}`,
    `Subject   ${summary.subject}`,
    `Received  ${summary.receivedAt}`,
    `Code      ${summary.code ?? "(none found)"}`,
    `Link      ${summary.link ?? "(none on an allowed domain)"}`,
  ];
  if (summary.refusedLinks.length > 0) {
    lines.push(
      `Refused   links to ${[...new Set(summary.refusedLinks)].join(", ")} (not in allowedDomains)`,
    );
  }
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

export function registerAuthCommands(program: Command, io: () => CommandIo): void {
  program
    .command("auth")
    .description("list auth profiles and their saved login sessions per environment")
    .option("--clear [profile]", "delete saved sessions (all, or one profile's)")
    .option("-e, --env <name>", "with --clear: only this environment's sessions")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action((options: AuthCommandOptions) => {
      process.exitCode = runAuthCommand(options, io());
    });

  const inbox = program
    .command("inbox")
    .description("the test email inbox (Mailpit, Mailosaur, MailSlurp)");
  inbox
    .command("check")
    .description("check the configured inbox: reachable and API key valid")
    .option("-e, --env <name>", "environment to resolve")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: InboxCommandOptions) => {
      process.exitCode = await runInboxCheck(options, io());
    });
  inbox
    .command("last")
    .description(
      "debug: the latest email to an address: subject and the code/link a test would use",
    )
    .requiredOption("--to <address>", "the recipient address")
    .option("--wait <seconds>", "how long to wait for an email", "5")
    .option("-e, --env <name>", "environment whose allowed domains apply to links")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: InboxCommandOptions) => {
      process.exitCode = await runInboxLast(options, io());
    });
}
