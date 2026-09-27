// Registers every section the project file may use (models, decisions, auth,
// inbox, tests, lint) through the owning packages' light entry points, so loading
// a project never needs the AI SDK or Playwright.
import "@testament/spec";
import "@testament/models/section";
import "@testament/decide";
import "@testament/auth";
