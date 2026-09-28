import { brand } from "@testament/brand";
import {
  type ArtifactRef,
  type Attempt,
  type CheckResult,
  type DecisionRecord,
  formatDuration,
  formatUsd,
  type HealProposal,
  type ModelCall,
  type StepResult,
  needsRerecord,
  stepLabel,
} from "@testament/contract";
import { encodePath, escapeHtml as h } from "../escape.js";
import {
  buildModel,
  CAUSE_LABEL,
  checkLine,
  costText,
  type EvidenceView,
  type FailureGroup,
  plural,
  RECOVERY_LABEL,
  type ReportModel,
  type RunData,
  runStatus,
  type TestView,
  VERDICT_LABEL,
  VERDICTS,
  words,
} from "../model.js";
import { defaultTokens, type ReportTokens, tokensToCss } from "../tokens.js";
import { SCRIPT } from "./script.js";
import { STYLES } from "./styles.js";

export interface HtmlReportOptions {
  /**
   * Prefix for artifact links when the report is not written into the run
   * folder, as a relative "/" path from the report to the run folder (e.g.
   * "../runs/01J…"). Default: "" (the report sits in the run folder).
   */
  artifactBase?: string;
  /** Replaces the default look (colours, type, spacing). */
  tokens?: ReportTokens;
  /** Product and command names in the page. Default: the brand package. */
  productName?: string;
  cliName?: string;
}

/**
 * Artifacts may only load from the report's own folder tree: no network, no
 * fonts, no remote scripts (EVD-2). `file:` keeps local images working when
 * the report is opened from disk.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self' file: data:",
  "media-src 'self' file:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

interface Ctx {
  model: ReportModel;
  href: (path: string) => string;
  productName: string;
  cliName: string;
}

const badge = (kind: string, label: string) =>
  `<span class="badge v-${h(kind)}">${h(label)}</span>`;

const verdictBadge = (test: TestView) => badge(test.verdict, VERDICT_LABEL[test.verdict]);

const meta = (parts: (string | null | undefined | false)[]) =>
  `<span class="meta">${parts
    .filter((p): p is string => typeof p === "string" && p !== "")
    .map((p) => `<span>${p}</span>`)
    .join("")}</span>`;

const aiText = (calls: number) => plural(calls, "AI call");

function link(ctx: Ctx, path: string, label: string): string {
  return `<a href="${h(ctx.href(path))}">${h(label)}</a>`;
}

function screenshotFigure(ctx: Ctx, path: string, caption: string): string {
  return `<figure><a href="${h(ctx.href(path))}"><img src="${h(ctx.href(path))}" alt="${h(caption)}"></a><figcaption>${h(caption)}</figcaption></figure>`;
}

function runHeader(ctx: Ctx): string {
  const { run } = ctx.model;
  const status = runStatus(ctx.model);
  const title = [run.project, run.environment].filter(Boolean).join(" · ");
  const git = run.git;
  const gitParts = git
    ? [
        git.branch ? `branch <code>${h(git.branch)}</code>` : null,
        git.commit ? `commit <code>${h(git.commit.slice(0, 12))}</code>` : null,
        git.pr ? `PR #${git.pr}` : null,
      ]
    : [];
  return `<header>
<p class="muted">${h(ctx.productName)} run report</p>
<h1>${h(title)} ${status === "empty" ? badge("none", "No tests ran") : badge(status, VERDICT_LABEL[status])}</h1>
${meta([
  `run <code>${h(run.runId)}</code>`,
  h(new Date(run.startedAt).toUTCString()),
  h(run.target),
  `${h(run.trigger)} trigger`,
  `${h(run.mode)} mode`,
  ...gitParts,
])}
</header>`;
}

function summarySection(ctx: Ctx): string {
  const { run, subscriptionCalls } = ctx.model;
  const tiles = VERDICTS.map(
    (v) =>
      `<li class="v-${v}"><strong>${run.totals[v]}</strong>${h(VERDICT_LABEL[v].toLowerCase())}</li>`,
  ).join("");
  const tokens = run.cost.tokens;
  return `<section aria-labelledby="summary-h">
<h2 id="summary-h">Summary</h2>
<ul class="tiles" aria-label="Verdict counts"><li><strong>${run.totals.tests}</strong>tests</li>${tiles}</ul>
<dl class="facts">
<dt>Duration</dt><dd>${h(formatDuration(run.durationMs))}</dd>
<dt>AI calls</dt><dd>${run.cost.aiCalls}${tokens.input + tokens.output > 0 ? ` <span class="muted">(${tokens.input.toLocaleString("en-US")} tokens in, ${tokens.output.toLocaleString("en-US")} out)</span>` : ""}</dd>
<dt>Cost</dt><dd>${h(costText(run.cost.usd, run.cost.unpricedCalls, subscriptionCalls, formatUsd))}</dd>
<dt>Environment</dt><dd>${h(run.environment ?? "default")} · ${h(run.target)}</dd>
<dt>Engine</dt><dd>${h(run.engineVersion)} · results contract ${h(run.contractVersion)}</dd>
</dl>
</section>`;
}

function blockedBanner(ctx: Ctx): string {
  const { blocked } = ctx.model.run;
  if (!blocked) return "";
  return `<div class="banner v-blocked" role="note"><strong>The run was blocked (${h(words(blocked.reason))}).</strong> ${h(blocked.message)}</div>`;
}

function diagnosticsSection(ctx: Ctx): string {
  const list = ctx.model.diagnostics;
  if (list.length === 0) return "";
  const items = list
    .map(
      (d) =>
        `<li>${badge(d.severity === "error" ? "failed" : "warn", d.severity)} <code>${h(d.file)}${d.line ? `:${d.line}` : ""}</code> ${h(d.message)}</li>`,
    )
    .join("");
  return `<section aria-labelledby="diag-h"><h2 id="diag-h">Problems reading this run</h2><ul class="plain">${items}</ul></section>`;
}

function groupCard(ctx: Ctx, group: FailureGroup): string {
  const first = group.tests[0];
  const label = group.reason
    ? `Blocked: ${words(group.reason)}`
    : group.cause
      ? CAUSE_LABEL[group.cause]
      : null;
  const verdicts = [...new Set(group.tests.map((t) => t.verdict))];
  const tests = group.tests
    .map(
      (t) =>
        `<li>${verdictBadge(t)} <a href="#${h(t.anchor)}">${h(t.name)}</a> ${meta([h(t.file), t.failingStep ? h(`step ${stepLabel(t.failingStep.step)}`) : null])}</li>`,
    )
    .join("");
  const shot = first?.screenshot
    ? screenshotFigure(ctx, first.screenshot, `Screenshot of the failure in ${first.name}`)
    : "";
  return `<div class="card" id="${h(group.id)}">
<p class="headline">${h(group.headline)}</p>
<p>${verdicts.map((v) => badge(v, VERDICT_LABEL[v])).join(" ")} ${label ? `${h(label)} · ` : ""}affects ${h(plural(group.tests.length, "test"))}</p>
${first?.failingCheck ? expectedActual(first.failingCheck.check) : ""}
${shot}
<ul class="plain">${tests}</ul>
</div>`;
}

function failuresSection(ctx: Ctx): string {
  const { groups } = ctx.model;
  if (groups.length === 0) return "";
  const count = groups.reduce((n, g) => n + g.tests.length, 0);
  return `<section id="failures" aria-labelledby="failures-h">
<h2 id="failures-h">What went wrong <span class="muted">(${h(plural(groups.length, "issue"))}, ${h(plural(count, "test"))})</span></h2>
${groups.map((g) => groupCard(ctx, g)).join("\n")}
</section>`;
}

function healsSection(ctx: Ctx): string {
  const { heals } = ctx.model;
  if (heals.length === 0) return "";
  const items = heals
    .map(
      ({ test, heal }) =>
        `<li><a href="#${h(test.anchor)}">${h(test.name)}</a>, step ${heal.stepIndex + 1}: ${heal.changes
          .map((c) => `${h(c.target)} <code>${h(c.before)}</code> → <code>${h(c.after)}</code>`)
          .join(
            "; ",
          )} ${meta([heal.level ? h(HEAL_LEVEL_LABEL[heal.level]) : null, `confidence ${Math.round(heal.confidence * 100)}%`, h(words(heal.classification)), h(heal.status === "accepted" && heal.appliedBy ? `applied (${heal.appliedBy})` : heal.status), heal.classification === "behavior_change" ? "<strong>behaviour may have changed</strong>" : null])}</li>`,
    )
    .join("");
  return `<section id="heals" aria-labelledby="heals-h"><h2 id="heals-h">Fixes to review</h2><ul>${items}</ul></section>`;
}

function warningsSection(ctx: Ctx): string {
  const list = ctx.model.softWarnings;
  if (list.length === 0) return "";
  const items = list
    .map(
      ({ test, warning }) =>
        `<li><a href="#${h(test.anchor)}">${h(test.name)}</a>: ${h(warning.check.generated.description)} ${meta([h(checkLine(warning.check))])}</li>`,
    )
    .join("");
  return `<section id="warnings" aria-labelledby="warnings-h"><h2 id="warnings-h">Soft-check warnings</h2><p class="muted">Soft checks only warn. They never fail a test.</p><ul>${items}</ul></section>`;
}

function expectedActual(check: CheckResult): string {
  if (check.expected === null && check.actual === null) return "";
  return `<dl class="expected-actual"><dt>Expected</dt><dd>${h(check.expected ?? "—")}</dd><dt>Actual</dt><dd>${h(check.actual ?? "—")}</dd></dl>`;
}

function evidenceItem(ctx: Ctx, evidence: EvidenceView): string {
  switch (evidence.kind) {
    case "check":
      return `<li>Check (attempt ${evidence.attempt}): ${h(evidence.check.generated.description)}: ${h(checkLine(evidence.check))}</li>`;
    case "step":
      return `<li>Step ${h(stepLabel(evidence.step))} (attempt ${evidence.attempt}): ${h(evidence.step.text)}${evidence.step.error ? `: ${h(evidence.step.error)}` : ""}</li>`;
    case "decision":
      return `<li>Decision <code>${h(evidence.decision.task)}</code> (attempt ${evidence.attempt}): <code>${h(JSON.stringify(evidence.decision.answer))}</code> ${meta([`confidence ${Math.round(evidence.decision.confidence * 100)}%`, h(evidence.decision.source)])}</li>`;
    case "artifact":
      return `<li>${link(ctx, evidence.path, evidence.path)}</li>`;
  }
}

function checkRow(check: CheckResult): string {
  const status = check.passed
    ? badge("passed", "passed")
    : check.soft
      ? badge("warn", "warning")
      : badge("failed", "failed");
  return `<tr><td>${status}${check.soft ? ' <span class="muted">soft</span>' : ""}</td><td>${h(check.generated.description)}<div class="muted">as written: ${h(check.expectation)}</div><details><summary>Check code</summary><pre>${h(check.generated.code)}</pre></details></td><td>${h(check.expected ?? "—")}</td><td>${h(check.actual ?? "—")}</td></tr>`;
}

function stepRow(ctx: Ctx, step: StepResult): string {
  const shots = (["before", "after"] as const)
    .map((when) => {
      const path = step.screenshots[when];
      if (!path) return "";
      const alt = `${when === "before" ? "Before" : "After"} step ${stepLabel(step)}`;
      return `<a href="${h(ctx.href(path))}"><img src="${h(ctx.href(path))}" alt="${h(alt)}" loading="lazy"></a>`;
    })
    .join("");
  const post = step.postState
    ? `<div class="muted">page after: ${h(words(step.postState.status))}${step.postState.expected ? `, expected ${h(step.postState.expected)}` : ""}${step.postState.observed ? `, saw ${h(step.postState.observed)}` : ""}</div>`
    : "";
  const locator = step.locator
    ? `<div class="muted">${h(step.locator.used)} locator <code>${h(step.locator.value)}</code></div>`
    : "";
  return `<tr><td>${h(stepLabel(step))}</td><td>${h(step.text)}${step.error ? `<div><strong>${h(step.error)}</strong></div>` : ""}${locator}${post}</td><td>${h(step.kind)}</td><td>${badge(step.status, step.status)}</td><td>${h(RECOVERY_LABEL[step.recovery])}</td><td>${h(formatDuration(step.durationMs))}</td><td><div class="shots">${shots}</div></td></tr>`;
}

const HEAL_LEVEL_LABEL: Record<NonNullable<HealProposal["level"]>, string> = {
  fallback: "fallback locator, no AI",
  refind: "re-found without AI",
  fixer: "fixed by AI",
};

function healBlock(heal: HealProposal): string {
  const signals = heal.signals
    .map((s) => `<li><code>${h(s.name)}</code> ${Math.round(s.score * 100)}%: ${h(s.detail)}</li>`)
    .join("");
  const changes = heal.changes
    .map(
      (c) =>
        `<dt>${h(c.target)}</dt><dd><code>${h(c.before)}</code> → <code>${h(c.after)}</code></dd>`,
    )
    .join("");
  const title =
    heal.status === "accepted"
      ? `Applied fix for step ${heal.stepIndex + 1}${heal.appliedBy === "auto" ? " (heal policy auto)" : heal.appliedBy === "human" ? " (accepted)" : ""}`
      : heal.status === "rejected"
        ? `Rejected fix for step ${heal.stepIndex + 1}`
        : `Proposed fix for step ${heal.stepIndex + 1}`;
  const warning =
    heal.classification === "behavior_change"
      ? `<p><strong>The app's behaviour may have changed — check before accepting.</strong></p>`
      : "";
  return `<div class="card"><p><strong>${h(title)}</strong> ${badge(heal.status === "pending" ? "warn" : heal.status === "accepted" ? "passed" : "blocked", heal.status)} ${meta([heal.level ? h(HEAL_LEVEL_LABEL[heal.level]) : null, `confidence ${Math.round(heal.confidence * 100)}%`, h(words(heal.classification)), `policy ${h(heal.policy)}`])}</p>
${warning}<dl class="expected-actual">${changes}</dl>
${signals ? `<p>Why it is the same element:</p><ul>${signals}</ul>` : ""}
<details><summary>Recording diff</summary><pre>${h(heal.diff)}</pre></details></div>`;
}

function modelCallRows(calls: readonly ModelCall[]): string {
  return calls
    .map((c) => {
      const cost =
        c.billing === "subscription"
          ? "via your subscription"
          : c.costUsd === null
            ? "unpriced"
            : formatUsd(c.costUsd);
      return `<tr><td>${h(c.role)}</td><td>${h([c.provider, c.model].filter(Boolean).join(" / ") || "none")}</td><td>${c.tokens.input.toLocaleString("en-US")} in / ${c.tokens.output.toLocaleString("en-US")} out${c.tokens.cached > 0 ? ` (${c.tokens.cached.toLocaleString("en-US")} cached)` : ""}</td><td>${h(cost)}</td><td>${h(formatDuration(c.latencyMs))}</td><td>${h(words(c.outcome))}${c.attempts > 1 ? ` after ${c.attempts} tries` : ""}${c.note ? `<div class="meta">“${h(c.note)}”</div>` : ""}</td></tr>`;
    })
    .join("");
}

function decisionItem(d: DecisionRecord): string {
  return `<li><code>${h(d.task)}</code>: <code>${h(JSON.stringify(d.answer))}</code> ${meta([`confidence ${Math.round(d.confidence * 100)}%`, h(d.source), h(formatDuration(d.latencyMs)), d.escalated ? "escalated" : null])}</li>`;
}

function table(label: string, head: string[], rows: string): string {
  return `<div class="scroll" role="region" aria-label="${h(label)}" tabindex="0"><table><thead><tr>${head.map((c) => `<th scope="col">${h(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const isChapters = (a: ArtifactRef) => a.contentType === "text/vtt" || a.path.endsWith(".vtt");

function artifactsBlock(ctx: Ctx, attempt: Attempt): string {
  const items: string[] = [];
  const chapters = attempt.artifacts.find(isChapters);
  for (const artifact of attempt.artifacts) {
    switch (artifact.kind) {
      case "screenshot":
        break;
      case "video":
        items.push(
          `<li>Video: ${link(ctx, artifact.path, artifact.path)}${chapters ? ` · step chapters ${link(ctx, chapters.path, chapters.path)}` : ""}<br><video controls preload="none" width="480" src="${h(ctx.href(artifact.path))}" aria-label="Screen recording of attempt ${attempt.attempt}">${chapters ? `<track kind="chapters" srclang="en" label="Steps" src="${h(ctx.href(chapters.path))}" default>` : ""}</video></li>`,
        );
        break;
      case "trace":
        items.push(
          `<li>Trace: ${link(ctx, artifact.path, artifact.path)}. Open it from the run folder with <kbd>npx playwright show-trace ${h(artifact.path)}</kbd></li>`,
        );
        break;
      case "console":
        items.push(`<li>Console log: ${link(ctx, artifact.path, artifact.path)}</li>`);
        break;
      case "network":
        items.push(`<li>Network log: ${link(ctx, artifact.path, artifact.path)}</li>`);
        break;
      case "logcat":
        items.push(`<li>Logcat: ${link(ctx, artifact.path, artifact.path)}</li>`);
        break;
      default:
        if (!isChapters(artifact))
          items.push(`<li>${h(artifact.kind)}: ${link(ctx, artifact.path, artifact.path)}</li>`);
    }
  }
  return items.length > 0 ? `<h4>Evidence files</h4><ul>${items.join("")}</ul>` : "";
}

function attemptBlock(ctx: Ctx, test: TestView, attempt: Attempt): string {
  const open = attempt === test.focusAttempt || test.result?.attempts.length === 1;
  const parts = [
    table(
      `Steps of attempt ${attempt.attempt} of ${test.name}`,
      ["#", "Step", "Kind", "Status", "Recovery", "Time", "Screenshots"],
      attempt.steps.map((s) => stepRow(ctx, s)).join(""),
    ),
  ];
  if (attempt.checks.length > 0)
    parts.push(
      `<h4>Checks</h4>${table(`Checks of attempt ${attempt.attempt} of ${test.name}`, ["Result", "What was checked", "Expected", "Actual"], attempt.checks.map(checkRow).join(""))}`,
    );
  if (attempt.heals.length > 0)
    parts.push(`<h4>Proposed fixes</h4>${attempt.heals.map(healBlock).join("")}`);
  if (attempt.modelCalls.length > 0)
    parts.push(
      `<h4>AI calls</h4>${table(`AI calls of attempt ${attempt.attempt} of ${test.name}`, ["Role", "Model", "Tokens", "Cost", "Time", "Outcome"], modelCallRows(attempt.modelCalls))}`,
    );
  if (attempt.decisions.length > 0)
    parts.push(
      `<details><summary>Decisions (${attempt.decisions.length})</summary><ul>${attempt.decisions.map(decisionItem).join("")}</ul></details>`,
    );
  parts.push(artifactsBlock(ctx, attempt));
  return `<details class="attempt"${open ? " open" : ""}><summary>Attempt ${attempt.attempt}: ${badge(attempt.status, attempt.status)} ${h(formatDuration(attempt.durationMs))}</summary>${parts.join("\n")}</details>`;
}

function testBody(ctx: Ctx, test: TestView): string {
  const out: string[] = [];
  if (test.headline && test.verdict !== "passed") {
    out.push(`<p class="headline">${h(test.headline)}</p>`);
    if (test.failingCheck) out.push(expectedActual(test.failingCheck.check));
    if (test.screenshot)
      out.push(screenshotFigure(ctx, test.screenshot, `Screenshot of the failure in ${test.name}`));
  }
  if (test.blocked)
    out.push(`<p>${badge("blocked", words(test.blocked.reason))} ${h(test.blocked.message)}</p>`);
  if (test.cause && test.cause !== "blocked") {
    const items = test.evidence.map((e) => evidenceItem(ctx, e)).join("");
    out.push(
      `<p><strong>Cause:</strong> ${h(CAUSE_LABEL[test.cause])}${test.verdict === "flaky" ? " (in the failed attempt)" : ""}</p>${items ? `<ul>${items}</ul>` : ""}`,
    );
  }
  const result = test.result;
  if (!result) {
    out.push(
      `<p class="muted">The result file <code>${h(test.ref.result)}</code> could not be read.</p>`,
    );
    return out.join("\n");
  }
  if (result.checkedSummary.length > 0)
    out.push(
      `<h4>What was checked</h4><ul>${result.checkedSummary.map((line) => `<li>${h(line)}</li>`).join("")}</ul>`,
    );
  if (test.softWarnings.length > 0)
    out.push(
      `<h4>Soft-check warnings</h4><ul>${test.softWarnings.map((w) => `<li>${h(w.check.generated.description)}: ${h(checkLine(w.check))}</li>`).join("")}</ul>`,
    );
  const ai = result.ai;
  const aiParts = [
    `${h(aiText(ai.calls))}, ${h(costText(ai.costUsd, ai.unpricedCalls, test.modelCalls.filter((c) => c.billing === "subscription").length, formatUsd))}`,
  ];
  if (ai.recent)
    aiParts.push(
      `this test used AI ${h(plural(ai.recent.calls, "time"))} in its last ${h(plural(ai.recent.runs, "run"))}`,
    );
  out.push(
    `<dl class="facts"><dt>File</dt><dd><code>${h(test.file)}</code></dd><dt>Runs on</dt><dd>${h(test.matrix ?? "")}</dd>${test.tags.length > 0 ? `<dt>Tags</dt><dd>${test.tags.map((t) => `<code>${h(t)}</code>`).join(" ")}</dd>` : ""}<dt>AI</dt><dd>${aiParts.join("; ")}</dd></dl>`,
  );
  if (result.recentHeals && needsRerecord(result.recentHeals))
    out.push(
      `<p><strong>Re-record this test:</strong> it healed ${h(plural(result.recentHeals.healed, "time"))} in its last ${h(plural(result.recentHeals.runs, "run"))}. <kbd>${h(`${ctx.cliName} run ${test.file} --rerecord`)}</kbd></p>`,
    );
  for (const attempt of result.attempts) out.push(attemptBlock(ctx, test, attempt));
  return out.join("\n");
}

function testArticle(ctx: Ctx, test: TestView): string {
  const search = [test.name, test.file, test.headline ?? "", ...test.tags].join(" ").toLowerCase();
  const open = test.verdict !== "passed";
  return `<article class="test" id="${h(test.anchor)}" data-verdict="${h(test.verdict)}" data-tags="${h(JSON.stringify(test.tags))}" data-search="${h(search)}">
<details${open ? " open" : ""}><summary>${verdictBadge(test)} <h3>${h(test.name)}</h3> ${meta([h(test.file), test.matrix ? h(test.matrix) : null, h(formatDuration(test.ref.durationMs)), h(aiText(test.ref.aiCalls)), h(formatUsd(test.ref.costUsd)), test.ref.attempts > 1 ? h(plural(test.ref.attempts, "attempt")) : null])}</summary>
<div>${testBody(ctx, test)}</div>
</details>
</article>`;
}

function filters(ctx: Ctx): string {
  const verdicts = VERDICTS.filter((v) => ctx.model.run.totals[v] > 0)
    .map((v) => `<option value="${v}">${h(VERDICT_LABEL[v])} (${ctx.model.run.totals[v]})</option>`)
    .join("");
  const tags = ctx.model.tags.map((t) => `<option value="${h(t)}">${h(t)}</option>`).join("");
  return `<form id="filters" class="filters" role="search" aria-label="Filter tests" hidden>
<label for="f-verdict">Verdict<select id="f-verdict"><option value="">All</option>${verdicts}</select></label>
${tags ? `<label for="f-tag">Tag<select id="f-tag"><option value="">All</option>${tags}</select></label>` : ""}
<label for="f-search">Search<input id="f-search" type="search" placeholder="Name, file or message"></label>
<output id="f-count" aria-live="polite"></output>
</form>`;
}

function testsSection(ctx: Ctx): string {
  const { tests } = ctx.model;
  return `<section id="tests" aria-labelledby="tests-h">
<h2 id="tests-h">Tests (${tests.length})</h2>
${filters(ctx)}
${tests.length === 0 ? '<p class="muted">No tests ran.</p>' : tests.map((t) => testArticle(ctx, t)).join("\n")}
</section>`;
}

/** The whole report as one self-contained HTML page (EVD-2). */
export function renderHtmlReport(data: RunData, options: HtmlReportOptions = {}): string {
  const model = buildModel(data);
  const base = options.artifactBase?.replace(/\/+$/, "") ?? "";
  const ctx: Ctx = {
    model,
    // A file: URL base (a run folder on another drive) is already encoded; only the path joins it.
    href: (path) =>
      base.startsWith("file:")
        ? `${base}/${encodePath(path)}`
        : encodePath(base ? `${base}/${path}` : path),
    productName: options.productName ?? brand.productName,
    cliName: options.cliName ?? brand.cliName,
  };
  const status = runStatus(model);
  const { run } = model;
  const title = `${status === "empty" ? "No tests ran" : VERDICT_LABEL[status]}: ${run.project} · ${ctx.productName} report`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${h(CONTENT_SECURITY_POLICY)}">
<meta name="referrer" content="no-referrer">
<title>${h(title)}</title>
<style>${tokensToCss(options.tokens ?? defaultTokens)}${STYLES}</style>
</head>
<body>
<a class="skip" href="#tests">Skip to the tests</a>
${runHeader(ctx)}
<main>
${blockedBanner(ctx)}
${failuresSection(ctx)}
${summarySection(ctx)}
${healsSection(ctx)}
${warningsSection(ctx)}
${diagnosticsSection(ctx)}
${testsSection(ctx)}
</main>
<footer>Made by ${h(ctx.productName)} ${h(run.engineVersion)} from run <code>${h(run.runId)}</code> (results contract ${h(run.contractVersion)}). Open it again with <kbd>${h(ctx.cliName)} report</kbd>.</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
