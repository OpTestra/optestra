import { join } from "node:path";
import { RUNS_DIR } from "../layout.js";

export { MergeError, type MergeRunsOptions, type MergeRunsResult, mergeRuns } from "./merge.js";
export { type ReadDiagnostic, type ReadRunOptions, type ReadRunResult, readRun } from "./reader.js";
export {
  type ArtifactInput,
  createRunWriter,
  type EmitInput,
  type RunWriter,
  type RunWriterOptions,
  type Scrub,
} from "./writer.js";

/** `<dataDir>/runs/<runId>`. The data dir comes from the brand package (e.g. `.<name>` in the project). */
export function runDir(dataDir: string, runId: string): string {
  return join(dataDir, RUNS_DIR, runId);
}
