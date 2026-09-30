import { nodeFileReader } from "@testament/spec/node";
import {
  freePath,
  type ProjectDraftOptions,
  prepare,
  sessionFor,
  withBrowser,
} from "../draft/project.js";
import { type ExploreResult, exploreApp } from "./explore.js";

// Exploring a project's app (EXPL-1): its settings, secrets by name, models and a
// fresh browser. Returns findings and proposals; writes nothing.

export async function exploreProject(
  url: string | undefined,
  goal: string,
  options: ProjectDraftOptions & { linkChecks?: number },
): Promise<ExploreResult & { environment: string }> {
  const prepared = await prepare({ ...options, baseUrl: url ?? options.baseUrl }, true);
  const models = prepared.models as NonNullable<typeof prepared.models>;
  return withBrowser(options, async (browser) => {
    const session = await sessionFor(prepared, browser);
    try {
      const result = await exploreApp(goal, {
        session,
        models,
        budget: prepared.budget,
        start: options.start,
        testsDir: prepared.testsDir,
        pathFor: (name) => freePath(prepared.dir, prepared.testsDir, name),
        secrets: prepared.described,
        hints: prepared.hints,
        config: prepared.config,
        readFile: nodeFileReader(prepared.dir),
        emailDomain: prepared.emailDomain,
        limits: options.limits,
        signal: options.signal,
        onEvent: options.onEvent,
        ...(options.linkChecks !== undefined ? { linkChecks: options.linkChecks } : {}),
      });
      return { ...result, environment: prepared.environment };
    } finally {
      await session.close();
    }
  });
}
