// The GitHub Action's Node code (CI-0). action.yml runs `node dist/cli.js <phase>`;
// these exports are for tests and the future GitHub App (CLOUD), which posts the
// same comment and check.
export {
  buildComment,
  COMMENT_LIMIT,
  type CommentInput,
  commentMarker,
  fillArtifactLinks,
  linkedArtifacts,
} from "./comment.js";
export { type CheckOutcome, checkOutcome, type Summary } from "./conclusion.js";
export {
  type ExpectationChange,
  expectationChanges,
  expectationNotice,
} from "./expectations.js";
export {
  type CheckRunInput,
  type CommentResult,
  type Conclusion,
  createCheckRun,
  type PullFile,
  pullRequestFiles,
  pullRequestForCommit,
  type Repo,
  upsertComment,
} from "./github.js";
export { type Env, type Io, locateRun, MAX_SCREENSHOTS, main, ulidTime } from "./main.js";
export { createGitHub, type Fetch, type GitHub, GitHubError } from "./transport.js";
