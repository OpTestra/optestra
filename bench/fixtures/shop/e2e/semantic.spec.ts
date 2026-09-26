// The semantic reference suite: one test per tests/*.test.md, using roles,
// labels and text only. All tests live in this one file so they run in order
// against their variant's server (they reset shared state). Run it against
// every variant: the results must match manifest.yaml exactly.
import "./semantic/checkout-trial.js";
import "./semantic/signup-email-code.js";
import "./semantic/signup-validation.js";
import "./semantic/login.js";
import "./semantic/create-project.js";
import "./semantic/billing-zero-due.js";
import "./semantic/declined-card.js";
import "./semantic/settings-profile.js";
import "./semantic/avatar-upload.js";
import "./semantic/delete-account-guard.js";
import "./semantic/sort-orders.js";
