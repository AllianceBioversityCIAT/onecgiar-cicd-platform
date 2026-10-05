// @akili-spec changes/cicd-executor-poc requirements FR-01; design §7 (definition-service row)
// Semantic validation rules for Pipeline Definitions that JSON Schema cannot
// express: DAG shape (nonexistent `needs`, cycles) and the "reserved type,
// not enabled" friendly message. Schema-level rules (closed step-type
// vocabulary, environment enum, interpolation whitelist, explicit codebuild
// project) already live in schemas/pipeline.schema.json (T-02) and are NOT
// reimplemented here — this module only covers what Ajv cannot check.

export interface ValidationIssue {
  readonly rule: string;
  readonly field: string;
  readonly message: string;
}

/**
 * Closed list of step types that exist in the vocabulary but are rejected in
 * the PoC (requirements FR-01). The schema already rejects these (the `type`
 * enum only admits lambda/codebuild/ssh/notify), but that rejection reads as
 * a generic "not one of the enum values" message. This pre-check runs on the
 * RAW parsed YAML, before schema validation, so a reserved type gets the
 * specific message the requirement names: "reserved type, not enabled"
 * (FR-01 scenario 'reserved type').
 */
export const RESERVED_STEP_TYPES = [
  "lambda-deploy",
  "s3-sync",
  "cloudfront-invalidate",
  "cloudformation",
  "http-check",
] as const;

interface RawStep {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly needs?: unknown;
}

function collectRawSteps(doc: Record<string, unknown>): RawStep[] {
  const steps = Array.isArray(doc.steps) ? (doc.steps as RawStep[]) : [];
  const finallySteps = Array.isArray(doc.finally) ? (doc.finally as RawStep[]) : [];
  return [...steps, ...finallySteps];
}

export function checkReservedStepTypes(doc: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const reserved: readonly string[] = RESERVED_STEP_TYPES;
  for (const step of collectRawSteps(doc)) {
    if (typeof step.type === "string" && reserved.includes(step.type)) {
      const id = typeof step.id === "string" ? step.id : "?";
      issues.push({
        rule: "reserved-step-type",
        field: `steps[id=${id}].type`,
        message: `reserved type, not enabled: "${step.type}"`,
      });
    }
  }
  return issues;
}

function stepIds(steps: readonly RawStep[]): Set<string> {
  const ids = new Set<string>();
  for (const step of steps) {
    if (typeof step.id === "string") ids.add(step.id);
  }
  return ids;
}

/** FR-01 'invalid definition': "a nonexistent dependency". */
export function checkNeedsExistence(doc: Record<string, unknown>): ValidationIssue[] {
  const steps = collectRawSteps(doc);
  const ids = stepIds(steps);
  const issues: ValidationIssue[] = [];
  for (const step of steps) {
    if (typeof step.id !== "string" || !Array.isArray(step.needs)) continue;
    for (const need of step.needs) {
      if (typeof need === "string" && !ids.has(need)) {
        issues.push({
          rule: "needs-nonexistent",
          field: `steps[id=${step.id}].needs`,
          message: `"needs" references an unknown step id: "${need}"`,
        });
      }
    }
  }
  return issues;
}

/** FR-01 'invalid definition': "a cycle in needs". Reports the first cycle found. */
export function checkNeedsCycle(doc: Record<string, unknown>): ValidationIssue[] {
  const steps = collectRawSteps(doc);
  const ids = stepIds(steps);
  const needsById = new Map<string, string[]>();
  for (const step of steps) {
    if (typeof step.id !== "string") continue;
    const needs = Array.isArray(step.needs)
      ? step.needs.filter((n): n is string => typeof n === "string" && ids.has(n))
      : [];
    needsById.set(step.id, needs);
  }

  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  function visit(id: string): string[] | undefined {
    state.set(id, "visiting");
    path.push(id);
    for (const dep of needsById.get(id) ?? []) {
      const depState = state.get(dep);
      if (depState === "visiting") {
        const start = path.indexOf(dep);
        return [...path.slice(start), dep];
      }
      if (depState !== "done") {
        const found = visit(dep);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  }

  for (const id of ids) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) {
        return [
          {
            rule: "needs-cycle",
            field: "steps[].needs",
            message: `cycle detected in "needs": ${cycle.join(" -> ")}`,
          },
        ];
      }
    }
  }
  return [];
}
