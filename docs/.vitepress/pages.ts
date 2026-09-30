// The site's structure: the sidebar and llms.txt both come from this list, and a
// test checks that every page is in it. Titles and descriptions may use the
// brand placeholders (see brand.ts).

export interface Page {
  text: string;
  link: string;
  /** One line for llms.txt. */
  description: string;
}

export interface Section {
  text: string;
  items: Page[];
}

export const SECTIONS: Section[] = [
  {
    text: "Getting started",
    items: [
      {
        text: "What %Name% is",
        link: "/overview",
        description: "What the engine does, what is open and what is paid, and the promises.",
      },
      {
        text: "Desktop app",
        link: "/quickstart/desktop",
        description: "Install the desktop app, try the demo shop and run a first test.",
      },
      {
        text: "Web app",
        link: "/quickstart/web",
        description: "The web app: the same screens in the browser, on our servers (not open yet).",
      },
      {
        text: "CLI in five minutes",
        link: "/quickstart/cli",
        description: "init, author, run and generate: a first recorded test from the command line.",
      },
    ],
  },
  {
    text: "Writing tests",
    items: [
      {
        text: "Test files",
        link: "/writing/test-files",
        description: "The .test.md format: frontmatter fields, one test per file.",
      },
      {
        text: "Steps",
        link: "/writing/steps",
        description: "Action, Expect, Soft, Never, Use and Exact steps, and code steps.",
      },
      {
        text: "Variables and test data",
        link: "/writing/variables",
        description: "data, env, secret, params, unique, faker and inbox values.",
      },
      {
        text: "Flows",
        link: "/writing/flows",
        description: "Reusable steps included with Use:, with params.",
      },
      {
        text: "Describe a test",
        link: "/writing/describe",
        description: "new: draft a test from one sentence; init --suggest for starter tests.",
      },
      {
        text: "Record by clicking",
        link: "/writing/record",
        description:
          "record: click through the app, mark expectations, get a test that replays with no AI.",
      },
      {
        text: "Lint rules",
        link: "/writing/lint",
        description: "Every lint rule with a bad and a good example (generated).",
      },
    ],
  },
  {
    text: "Projects",
    items: [
      {
        text: "Environments and devices",
        link: "/environments",
        description:
          "Environments, base URLs, allowed domains, secrets, production mode, browsers and devices.",
      },
    ],
  },
  {
    text: "Running tests",
    items: [
      {
        text: "How a run works",
        link: "/runs/how-a-run-works",
        description: "Authoring once with AI, replaying with no AI, retries and the CLI output.",
      },
      {
        text: "Checks and verdicts",
        link: "/runs/checks-and-verdicts",
        description: "How Expect lines become real checks, the sanity test, and the five verdicts.",
      },
      {
        text: "Healing",
        link: "/runs/healing",
        description: "The healing ladder, fix policies, and reviewing and accepting fixes.",
      },
      {
        text: "Explain a failure",
        link: "/runs/explain",
        description: "explain: a diagnosis from the run's evidence, rules only or one AI call.",
      },
      {
        text: "Recordings",
        link: "/runs/recordings",
        description: "What a recording holds, where it lives, step keys and re-authoring.",
      },
    ],
  },
  {
    text: "Logins and email",
    items: [
      {
        text: "Auth profiles and inboxes",
        link: "/auth",
        description: "Saved logins, TOTP secrets and test inboxes (Mailpit, Mailosaur, MailSlurp).",
      },
    ],
  },
  {
    text: "AI models",
    items: [
      {
        text: "Providers and roles",
        link: "/ai/models",
        description: "Planner and fixer, provider kinds, pinned defaults and failover.",
      },
      {
        text: "Use your AI subscription",
        link: "/ai/subscription",
        description: "Claude Code and Codex instead of an API key, locked down; why not Google.",
      },
      {
        text: "Costs and budgets",
        link: "/ai/costs",
        description: "Prices, budget caps, usage caps and what a run costs.",
      },
      {
        text: "Decision models",
        link: "/ai/decisions",
        description: "Rules first, then Jev, Kev or Laya (via Ollaya) for small typed decisions.",
      },
    ],
  },
  {
    text: "CI",
    items: [
      {
        text: "GitHub Action",
        link: "/ci/github-action",
        description: "The PR comment, the status check, modes, inputs and outputs.",
      },
      {
        text: "Preview deploys",
        link: "/ci/previews",
        description: "Vercel and Netlify previews, and protected previews.",
      },
      {
        text: "Sharding",
        link: "/ci/sharding",
        description: "Split a suite across machines and merge the results.",
      },
      {
        text: "Pull requests from forks",
        link: "/ci/forks",
        description: "Why fork PRs get no secrets and why pull_request_target is unsafe.",
      },
      {
        text: "Other CI systems",
        link: "/ci/other-ci",
        description: "GitLab CI, CircleCI, Bitbucket Pipelines and Docker.",
      },
    ],
  },
  {
    text: "More targets and tools",
    items: [
      {
        text: "Coding agents",
        link: "/coding-agents",
        description: "Machine-readable results for agents; the MCP server and AGENTS.md.",
      },
      {
        text: "Explore",
        link: "/explore",
        description:
          "explore: roam toward a goal; errors, broken links and dead ends as proposals.",
      },
      {
        text: "Android",
        link: "/android",
        description: "The Android harness: emulators, the network guard, actions and setup.",
      },
      {
        text: "Reports",
        link: "/reports",
        description: "The HTML report, JUnit XML, the JSON summary and the Markdown summary.",
      },
      {
        text: "Playwright export",
        link: "/export",
        description: "Generated Playwright specs next to your tests, and a standalone export.",
      },
    ],
  },
  {
    text: "Trust",
    items: [
      {
        text: "What data goes where",
        link: "/security/data",
        description: "Exactly what is sent to AI providers, decision models, inboxes and GitHub.",
      },
      {
        text: "Safety model",
        link: "/security/safety-model",
        description:
          "Allowed domains, the closed action set, typed secrets and untrusted page content.",
      },
      {
        text: "Known limits",
        link: "/security/limits",
        description: "Every known limit of the safety model and the engine, in one list.",
      },
      {
        text: "If %Name% disappears",
        link: "/if-it-disappears",
        description: "Nothing breaks: your tests are Playwright code you own.",
      },
    ],
  },
  {
    text: "Help and reference",
    items: [
      {
        text: "Troubleshooting",
        link: "/troubleshooting",
        description: "doctor's checks and what to do about each problem.",
      },
      {
        text: "CLI reference",
        link: "/reference/cli",
        description: "Every command and flag (generated from the CLI).",
      },
      {
        text: "Project file reference",
        link: "/reference/config",
        description: "Every key of the project file with its default (generated from the schema).",
      },
      {
        text: "JSON results reference",
        link: "/reference/results-json",
        description: "The results-summary JSON for agents and tools (generated from the schema).",
      },
    ],
  },
];
