import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BoundText, ExactOp } from "@optestra/spec";

// `Mock:` steps (ENV-4): from that step on, matching requests get the step's
// response instead of the app's. The harness answers them in its route
// handler, so a mock only ever applies on the allowed domains. The body file is
// relative to the test file and must be inside the project. Web only.

export type MockOp = Extract<ExactOp<BoundText>, { op: "mock" }>;

/** What a session needs for mocks (the web harness has it; Android doesn't). */
export interface MockSession {
  mock?: (rule: {
    method: string;
    url: string;
    status: number;
    body?: Uint8Array | string;
    contentType?: string;
    stepIndex?: number;
    file?: string;
  }) => { ok: true } | { ok: false; message: string };
}

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export function isMockOp(op: ExactOp<BoundText> | undefined): op is MockOp {
  return op?.op === "mock";
}

/** Applies a `Mock:` step to the session. Errors are the test's (config), never a pass. */
export function applyMock(
  session: MockSession,
  op: MockOp,
  where: { projectDir: string; testPath: string; stepIndex: number },
): { ok: true } | { ok: false; message: string } {
  if (!session.mock)
    return { ok: false, message: "Mock: steps are not supported on this target yet (web only)." };
  let body: Buffer | undefined;
  let file: string | undefined;
  if (op.body) {
    const root = resolve(where.projectDir);
    const absolute = resolve(root, dirname(where.testPath), op.body);
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel))
      return { ok: false, message: `Mock: the body file ${op.body} is outside the project.` };
    if (!existsSync(absolute))
      return {
        ok: false,
        message: `Mock: the body file ${rel.split(sep).join("/")} does not exist (it is relative to ${where.testPath}).`,
      };
    body = readFileSync(join(absolute));
    file = rel.split(sep).join("/");
  }
  return session.mock({
    method: op.method,
    url: op.url.display,
    status: op.status,
    ...(body ? { body } : { body: "" }),
    contentType: op.body
      ? (TYPES[extname(op.body).toLowerCase()] ?? "application/octet-stream")
      : "application/json",
    stepIndex: where.stepIndex,
    ...(file ? { file } : {}),
  });
}
