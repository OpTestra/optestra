import type { PullFile } from "./github.js";

// AGT-4: an agent (or anyone) could make a test pass by editing what it
// expects. When a pull request adds, removes or changes an `Expect:` line in a
// `.test.md` file, the comment says so first, so a human reviews it.

export interface ExpectationChange {
  file: string;
  added: number;
  removed: number;
  /** The diff was not available (binary, too large): assume it changed. */
  unreadable: boolean;
}

const TEST_FILE = /\.test\.md$/i;
/** `5. Expect: …`, `- Expect: …`, `Expect: …` as an added or removed diff line. */
const EXPECT_LINE = /^[+-](?![+-]{2} )\s*(?:\d+[.)]\s*|[-*]\s+)?expect\s*:/i;

export function expectationChanges(files: readonly PullFile[]): ExpectationChange[] {
  const changes: ExpectationChange[] = [];
  for (const file of files) {
    if (!TEST_FILE.test(file.filename)) continue;
    if (file.patch === undefined) {
      if (file.status !== "unchanged")
        changes.push({ file: file.filename, added: 0, removed: 0, unreadable: true });
      continue;
    }
    let added = 0;
    let removed = 0;
    for (const line of file.patch.split("\n")) {
      if (!EXPECT_LINE.test(line)) continue;
      if (line.startsWith("+")) added++;
      else removed++;
    }
    if (added + removed > 0)
      changes.push({ file: file.filename, added, removed, unreadable: false });
  }
  return changes;
}

/** The prominent notice at the top of the comment, or "" when nothing changed. */
export function expectationNotice(changes: readonly ExpectationChange[], max = 20): string {
  if (changes.length === 0) return "";
  const rows = changes.slice(0, max).map((c) => {
    const what = c.unreadable
      ? "diff not shown by GitHub; check it by hand"
      : [c.added ? `${c.added} added` : "", c.removed ? `${c.removed} removed` : ""]
          .filter(Boolean)
          .join(", ");
    return `> - \`${c.file.replaceAll("`", "'")}\` (${what})`;
  });
  if (changes.length > max) rows.push(`> - and ${changes.length - max} more files`);
  return [
    "> [!WARNING]",
    "> **Expectations changed in this PR — review them.** A changed `Expect:` line changes what the tests prove, so passing tests may now check less.",
    ...rows,
  ].join("\n");
}
