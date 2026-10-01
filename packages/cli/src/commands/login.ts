import {
  DELEGATED_KINDS,
  type DelegatedKind,
  findBinary,
  INSTALL_HINT,
  probeBinary,
  SIGN_IN_COMMAND,
  signInStatus,
  VENDOR_LABEL,
} from "@optestra/models";
import { brand } from "@optestra/brand";
import type { CommandIo } from "./config.js";

// `login` (MOD-6): shows which AI subscription tools are available and the exact
// vendor command to sign in. It never signs in, never proxies a sign-in and never
// touches the tools' credentials: sign-in happens only in the vendor's own tool.

const TERMS: Record<DelegatedKind, string> = {
  "claude-code": "https://code.claude.com/docs/en/legal-and-compliance",
  codex: "https://developers.openai.com/codex/auth",
};

export async function runLoginCommand(io: CommandIo): Promise<number> {
  const lines = [
    "Use your own AI subscription instead of an API key. Sign in with the vendor's own tool;",
    `${brand.productName} only runs that tool (locked down: no shell, no files, no web) and never sees your sign-in.`,
    "",
  ];
  let ready = 0;
  for (const kind of DELEGATED_KINDS) {
    const found = findBinary(kind, undefined, io.env);
    const label = VENDOR_LABEL[kind];
    if (!found.ok) {
      lines.push(
        `  ${label}: not installed.`,
        `      ${INSTALL_HINT[kind]}`,
        `      Then sign in: ${SIGN_IN_COMMAND[kind]}`,
      );
      continue;
    }
    const probe = await probeBinary(kind, found.binary, io.env);
    if (!probe.meetsMinimum) {
      lines.push(`  ${label}: ${probe.problem ?? "can't be used"}`);
      continue;
    }
    const status = await signInStatus(kind, found.binary, io.env);
    if (status.signedIn) {
      ready++;
      lines.push(
        `  ${label}: installed${probe.version ? ` (${probe.version})` : ""} and signed in. Ready.`,
      );
    } else {
      lines.push(
        `  ${label}: installed${probe.version ? ` (${probe.version})` : ""}, not signed in.`,
        `      Sign in: ${SIGN_IN_COMMAND[kind]}`,
      );
    }
    lines.push(`      Terms: ${TERMS[kind]}`);
  }
  lines.push(
    "",
    "Google Gemini subscriptions can't be used this way (Google doesn't allow it); use a Gemini API key (GEMINI_API_KEY).",
  );
  io.stdout(`${lines.join("\n")}\n`);
  return ready > 0 ? 0 : 1;
}
