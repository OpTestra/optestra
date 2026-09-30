import { brand } from "@testament/brand";

// The instructions for coding agents (AGT-2): an AGENTS.md / CLAUDE.md snippet.
// `init` appends it (asked first); the MCP server serves it as a resource; the
// Claude Code skill in integrations/claude-code/ carries the same text (a test
// keeps them in line). The one rule that matters most: never change an
// expectation to make a test pass.

/** Marks the snippet in a file, so it is appended once. */
export const AGENTS_MARKER = `<!-- ${brand.cliName}:agents -->`;
export const AGENTS_END_MARKER = `<!-- /${brand.cliName}:agents -->`;

/** The rules an agent must follow, one per line (also checked by the tests). */
export function agentRules(): string[] {
  return [
    "Never edit an `Expect:` or `Soft:` line to make a failing test pass. The expectations are the specification: a failing check means the app is wrong, or the requirement changed, and only a human decides which.",
    "Don't delete, skip, retag or weaken a test or an expectation to get a green run, and don't loosen the quoted text of an expectation.",
    "Fix the app, not the test. If you think a test is wrong, say so and explain why; leave the expectation to a human.",
    `Don't edit the recordings in \`tests/${brand.dataDirName}/\` by hand; \`${brand.cliName} run --rerecord <file>\` records a test again.`,
    "Never write a password, token or key into a test; use `{{secret.NAME}}`.",
    "Changes to `Expect:` lines are flagged for a human in the PR comment.",
  ];
}

/** The body of the snippet (Markdown), without the markers. */
export function agentInstructions(): string {
  const cli = brand.cliName;
  return `## End-to-end tests (${brand.productName})

This project's end-to-end tests are plain-English \`.test.md\` files in \`tests/\`, run by ${brand.productName}. Each numbered line is a step; \`Expect:\` lines are the checks.

How to use it:
- List the tests: \`${cli} list\` (MCP: \`list_tests\`). Read one: \`${cli} show tests/<file>.test.md\` (MCP: \`get_test\`).
- Run the tests after every change that can affect the app: \`${cli} run\` (all), \`${cli} run tests/<file>.test.md\` (one), \`${cli} run --tag smoke\`. \`--replay-only\` uses no AI at all (MCP: \`run_tests\`).
- Read the result: exit code 0 passed, 1 failed or flaky, 2 blocked (the test couldn't run: a missing secret, the app not running). \`${cli} results <runDir> --json\` gives, per test, the \`verdict\`, the \`cause\`, the \`headline\`, the \`failingCheck\` (the expectation as written, expected and actual), the \`failingStep\`, the \`file\` and a screenshot (MCP: \`get_results\`).
- Ask why a test failed: \`${cli} explain\` (the latest run; or \`${cli} explain <runDir> <test>\`) gives a short diagnosis citing the evidence (the failing check, the step, console errors, failed requests, the screenshot); rules only, \`--ai\` for one AI call (MCP: \`explain\`).
- Add a test: \`${cli} new "a returning user can log in"\` drafts one by exploring the app and prints it; review it, then save it with \`--accept\` (MCP: \`draft_test\`, then \`save_test\`). Or write the file yourself: the format is in the \`${cli}://docs/test-format\` MCP resource. \`${cli} lint\` checks it.
- Heals: when the UI changed but the behaviour didn't, a run can heal a step (a new locator) and marks the test healed. Review with \`${cli} heal\`, accept with \`${cli} heal --accept <id>\` (MCP: \`list_heals\`, \`accept_heal\`). A heal never changes a check.

Rules:
${agentRules()
  .map((rule) => `- ${rule}`)
  .join("\n")}
`;
}

/** The snippet as appended to AGENTS.md / CLAUDE.md, between its markers. */
export function agentsSnippet(): string {
  return `${AGENTS_MARKER}\n${agentInstructions()}${AGENTS_END_MARKER}\n`;
}

/**
 * The file's text with the snippet appended, or null when it is already there.
 * Only appends: the existing text is kept byte for byte.
 */
export function appendAgentsSnippet(existing: string | undefined): string | null {
  if (existing?.includes(AGENTS_MARKER)) return null;
  if (!existing) return agentsSnippet();
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${agentsSnippet()}`;
}
