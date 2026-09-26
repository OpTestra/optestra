import { type TemplateVariable, templateParts } from "@testament/recording";
import type { BoundSegment, ExpandedStep, ExpandedTest } from "@testament/spec";

// A step's variables: what the agent may type as templates, and the values used
// to execute them. Secrets have no value here; they reach the harness by name.

export interface StepVariables {
  /** What this step may type as templates. */
  list: TemplateVariable[];
  /**
   * For turning PAGE text into templates: this step's variables first, then every
   * other value bound anywhere in the test (a later step's page still shows the
   * email an earlier step typed). Never used for what the agent types.
   */
  pageList: TemplateVariable[];
  /** ref → value, for non-secret refs that have one. */
  values: Record<string, string>;
  /** Secret names the step may type. */
  secrets: string[];
  /** References with no value (e.g. env vars not set). */
  unresolved: string[];
}

export function stepVariables(test: ExpandedTest, step: ExpandedStep): StepVariables {
  const values: Record<string, string> = {};
  const secrets = new Set<string>();
  const unresolved = new Set<string>();
  for (const segment of step.bound) {
    if (segment.kind === "value") values[segment.ref] = segment.text;
    else if (segment.kind === "secret") secrets.add(segment.name);
    else if (segment.kind === "unresolved") unresolved.add(segment.ref);
  }
  // The test's own data is available to every step of the test itself.
  if (step.flowPath.length === 0) {
    for (const [name, bound] of Object.entries(test.data)) {
      if (!bound.segments.some((s) => s.kind === "secret" || s.kind === "unresolved")) {
        values[`data.${name}`] ??= bound.display;
      }
    }
  }
  const list: TemplateVariable[] = [
    ...Object.entries(values).map(([ref, value]) => ({ ref, value })),
    ...[...secrets].map((name) => ({ ref: `secret.${name}` })),
    ...[...unresolved].map((ref) => ({ ref })),
  ];
  const seen = new Set(list.map((v) => v.value).filter(Boolean));
  const pageList = [...list];
  const add = (ref: string, value: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    pageList.push({ ref, value });
  };
  for (const other of test.steps) {
    for (const segment of other.bound) if (segment.kind === "value") add(segment.ref, segment.text);
  }
  for (const [name, bound] of Object.entries(test.data)) {
    if (!bound.segments.some((s) => s.kind === "secret" || s.kind === "unresolved"))
      add(`data.${name}`, bound.display);
  }
  return { list, pageList, values, secrets: [...secrets], unresolved: [...unresolved] };
}

/** Lines for the prompt: values of plain variables, secrets by name only. */
export function describeVariables(variables: StepVariables): string {
  const lines = [
    ...Object.entries(variables.values).map(
      ([ref, value]) => `- {{${ref}}} = ${JSON.stringify(value)}`,
    ),
    ...variables.secrets.map(
      (name) => `- {{secret.${name}}} = (secret; type it exactly as {{secret.${name}}})`,
    ),
    ...variables.unresolved.map((ref) => `- {{${ref}}} = (no value in this environment)`),
  ];
  return lines.length ? lines.join("\n") : "(none)";
}

/** A bound text as a template: values by reference, secrets as `{{secret.NAME}}`. */
export function segmentsTemplate(segments: readonly BoundSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.kind === "text") return segment.text.replace(/\{\{/g, "\\{{");
      if (segment.kind === "secret") return `{{secret.${segment.name}}}`;
      return `{{${segment.ref}}}`;
    })
    .join("");
}

export type HarnessValue =
  | { ok: true; value: string | { secret: string } }
  | { ok: false; error: string };

/** What the harness should type for a template. A secret must be the whole value. */
export function harnessValue(template: string, variables: StepVariables): HarnessValue {
  const parts = templateParts(template, variables.values);
  const secret = parts.find((part) => "secret" in part);
  if (secret && "secret" in secret) {
    if (parts.length !== 1) {
      return {
        ok: false,
        error: "A secret must be typed on its own, as the whole value: {{secret.NAME}}.",
      };
    }
    if (!variables.secrets.includes(secret.secret)) {
      return {
        ok: false,
        error: `This step doesn't use {{secret.${secret.secret}}}; only the step's own secrets can be typed.`,
      };
    }
    return { ok: true, value: { secret: secret.secret } };
  }
  const missing = parts.find((part) => "unresolved" in part);
  if (missing && "unresolved" in missing) {
    return { ok: false, error: `{{${missing.unresolved}}} has no value here.` };
  }
  return { ok: true, value: parts.map((part) => ("text" in part ? part.text : "")).join("") };
}
