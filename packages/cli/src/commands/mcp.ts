import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { brand } from "@testament/brand";
import { findProject, projectFile } from "@testament/config/node";

// `mcp` (AGT-1): the MCP server for coding agents, over stdio, on the project
// in this folder. stdout carries only the protocol; messages go to stderr.

export interface McpCommandOptions {
  env?: string;
  headed?: boolean;
  dir?: string;
}

export async function runMcpCommand(
  options: McpCommandOptions,
  io: {
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
    stderr: (text: string) => void;
  },
): Promise<number> {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir))) {
    io.stderr(
      `No ${brand.configFileName} found in ${dir} or above. Start the server in the project folder, or pass -C <project>.\n`,
    );
    return 2;
  }
  const { serveStdio } = await import("@testament/mcp");
  await serveStdio({
    project: dir,
    ...(options.env ? { environment: options.env } : {}),
    env: io.env,
    headless: !options.headed,
  });
  return 0;
}
