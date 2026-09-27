/**
 * Library entry: what the apps call directly instead of spawning the CLI.
 * The desktop app's Setup check runs `runDoctor` and renders its checks.
 */
export {
  type DoctorBrowser,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorProbes,
  type DoctorReport,
  type DoctorStatus,
  formatDoctorReport,
  harnessProbes,
  runDoctor,
} from "./commands/doctor.js";
export { detectRepo, type RepoInfo } from "./commands/init.js";
