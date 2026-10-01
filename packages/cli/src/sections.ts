// Registers every section the project file may use (models, decisions, auth,
// inbox, tests, lint, android) through the owning packages' light entry points, so loading
// a project never needs the AI SDK or Playwright.
import "@optestra/spec";
import "@optestra/models/section";
import "@optestra/decide";
import "@optestra/auth";
import "@optestra/android/section";
