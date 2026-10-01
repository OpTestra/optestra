import { SECRET_NAME } from "@optestra/config";
import { opTemplates } from "./exact.js";
import type { GeneratorRegistry } from "./generators.js";
import { INBOX_MEMBERS, NAMESPACES, type Template, type TestSpec } from "./model.js";
import { templateRefs } from "./template.js";
import type { Reporter } from "./text.js";

export interface RefScope {
  kind: "test" | "flow";
  data: ReadonlySet<string>;
  /** AUT-9: the test has a dataset, whose columns are data too (checked when it's loaded). */
  dataset?: boolean;
  params: ReadonlySet<string>;
  generators: GeneratorRegistry;
  /** Declared secret names; undefined when no config was given (then no SECRET_UNDECLARED). */
  secrets: ReadonlySet<string> | undefined;
}

type Where = "step" | "data" | "params" | "start" | "use";

const WHERE_LABEL: Record<Where, string> = {
  step: "a step",
  data: "a data value",
  params: "a param default",
  start: "start",
  use: "a Use: param",
};

/** Checks every reference in a template against the scope. */
export function checkTemplate(template: Template, scope: RefScope, where: Where, report: Reporter) {
  for (const ref of templateRefs(template)) {
    const range = ref.at?.range;
    const full = `${ref.ns}.${ref.name}`;
    if (!(NAMESPACES as readonly string[]).includes(ref.ns)) {
      report.error(
        "VAR_NAMESPACE_UNKNOWN",
        range,
        `"${ref.raw}" uses the unknown namespace "${ref.ns}".`,
        `Use one of: ${NAMESPACES.map((ns) => `{{${ns}.…}}`).join(", ")}.`,
      );
      continue;
    }
    switch (ref.ns) {
      case "unique":
      case "faker":
        if (!scope.generators.has(ref.ns, ref.name)) {
          report.error(
            "VAR_MEMBER_UNKNOWN",
            range,
            `{{${full}}} is not a generator.`,
            `Use one of: ${scope.generators
              .members(ref.ns)
              .map((m) => `{{${ref.ns}.${m}}}`)
              .join(", ")}.`,
          );
        }
        break;
      case "inbox":
        if (!(INBOX_MEMBERS as readonly string[]).includes(ref.name)) {
          report.error(
            "VAR_MEMBER_UNKNOWN",
            range,
            `{{${full}}} is not an inbox value.`,
            `Use one of: ${INBOX_MEMBERS.map((m) => `{{inbox.${m}}}`).join(", ")}.`,
          );
        }
        break;
      case "data":
        if (!scope.data.has(ref.name) && !scope.dataset) {
          report.error(
            "VAR_UNDEFINED",
            range,
            `{{${full}}} is used but "${ref.name}" is not in data.`,
            `Add it to the frontmatter:\ndata:\n  ${ref.name}: …${scope.data.size > 0 ? `\n(defined: ${[...scope.data].join(", ")})` : ""}`,
          );
        }
        break;
      case "params":
        if (scope.kind !== "flow") {
          report.error(
            "PARAMS_OUTSIDE_FLOW",
            range,
            `{{${full}}} can only be used in a flow (kind: flow).`,
            `Use {{data.${ref.name}}} and add ${ref.name} to data:, or make this file a flow.`,
          );
        } else if (where === "data" || where === "params") {
          report.error(
            "VAR_UNDEFINED",
            range,
            `${WHERE_LABEL[where]} cannot use {{${full}}}.`,
            `Use {{params.${ref.name}}} in the steps instead.`,
          );
        } else if (!scope.params.has(ref.name)) {
          report.error(
            "VAR_UNDEFINED",
            range,
            `{{${full}}} is used but "${ref.name}" is not in params.`,
            `Add it to the frontmatter:\nparams:\n  ${ref.name}:        # empty = required`,
          );
        }
        break;
      case "secret":
        if (!SECRET_NAME.test(ref.name)) {
          report.error(
            "SECRET_NAME_INVALID",
            range,
            `"${ref.name}" is not a valid secret name; secret names are UPPER_SNAKE_CASE.`,
            `Write it as {{secret.${ref.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}}}.`,
          );
        } else if (scope.secrets && !scope.secrets.has(ref.name)) {
          report.error(
            "SECRET_UNDECLARED",
            range,
            `Secret ${ref.name} is used but not declared in the project settings.`,
            `Add it under secrets: in the project file (with the domains it may be typed into), or fix the name.`,
          );
        }
        break;
      default:
        break; // env: checked against the environment's vars when expanding.
    }
  }
}

/** The data keys each data value references, for ordering and cycle checks. */
export function dataDeps(data: Readonly<Record<string, Template>>): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const [key, value] of Object.entries(data)) {
    deps.set(
      key,
      templateRefs(value)
        .filter((ref) => ref.ns === "data" && Object.hasOwn(data, ref.name))
        .map((ref) => ref.name),
    );
  }
  return deps;
}

/** Cycles among data values, each as the list of keys in order (first key repeated at the end). */
export function dataCycles(data: Readonly<Record<string, Template>>): string[][] {
  const deps = dataDeps(data);
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  const stack: string[] = [];
  const visit = (key: string) => {
    if (state.get(key) === "done") return;
    if (state.get(key) === "visiting") {
      cycles.push([...stack.slice(stack.indexOf(key)), key]);
      return;
    }
    state.set(key, "visiting");
    stack.push(key);
    for (const dep of deps.get(key) ?? []) visit(dep);
    stack.pop();
    state.set(key, "done");
  };
  for (const key of deps.keys()) visit(key);
  return cycles;
}

export function reportCycles(
  data: Readonly<Record<string, Template>>,
  report: Reporter,
  seen: Set<string>,
  pathPrefix = "data",
) {
  for (const cycle of dataCycles(data)) {
    const id = [...cycle.slice(0, -1)].sort().join(",");
    if (seen.has(id)) continue;
    seen.add(id);
    const first = cycle[0] ?? "";
    report.error(
      "DATA_CYCLE",
      data[first]?.at?.range,
      `Data values refer to each other in a loop: ${cycle.map((k) => `data.${k}`).join(" → ")}.`,
      `Give one of ${cycle
        .slice(0, -1)
        .map((k) => k)
        .join(", ")} a value that does not use the others.`,
      `${pathPrefix}.${first}`,
    );
  }
}

/** All reference checks for a parsed spec. */
export function checkSpecRefs(spec: TestSpec, scope: RefScope, report: Reporter) {
  const fm = spec.frontmatter;
  if (fm.start) checkTemplate(fm.start, scope, "start", report);
  for (const value of Object.values(fm.data)) checkTemplate(value, scope, "data", report);
  for (const value of Object.values(fm.params))
    if (value) checkTemplate(value, scope, "params", report);
  const seen = new Set<string>();
  reportCycles(fm.data, report, seen);
  for (const [name, env] of Object.entries(fm.environments)) {
    if (env.start) checkTemplate(env.start, scope, "start", report);
    for (const value of Object.values(env.data ?? {})) checkTemplate(value, scope, "data", report);
    if (env.data)
      reportCycles({ ...fm.data, ...env.data }, report, seen, `environments.${name}.data`);
  }
  for (const item of spec.body) {
    if (item.type !== "step") continue;
    if (item.kind === "flow") {
      for (const value of Object.values(item.params)) checkTemplate(value, scope, "use", report);
    } else if (item.kind === "exact") {
      if (item.exact.form === "op") {
        for (const value of opTemplates(item.exact.op)) checkTemplate(value, scope, "step", report);
      }
    } else checkTemplate(item.text, scope, "step", report);
  }
}
