// @akili-spec changes/cicd-executor-poc design DD-06, §7 (planner row), §7.3 (T1, T2, T11); requirements FR-06, FR-16 F5
// Pure function: step states + pipeline definition -> actions (dispatch,
// skip, run finally, close execution). No I/O, no Date.now(), no randomness
// (design §3.2's "domain is pure" boundary, same as state-machine/index.ts).
//
// DD-06's own implication is the load-bearing rule here: "fan-in exactly
// once" is guaranteed by the dispatcher's CONDITIONAL WRITE (T1/T3 in
// state-machine's vocabulary), never by this module. This module's only
// fan-in obligation is weaker but just as absolute: never emit a dispatch
// before ALL of a step's `needs` are SUCCEEDED. Calling this function twice
// with the identical snapshot must return equal actions (it reads nothing
// but its arguments) — that is what makes repeated/duplicate planner
// invocations across retries and reconciler ticks safe.
import {
  TERMINAL_STEP_STATES,
  type ExecutionOutcome,
  type StepState,
  type StepType,
} from "../state-machine/index.js";

/**
 * The subset of a declared pipeline step the planner needs to walk the DAG:
 * identity, dispatch type (ssh routes to lock-wait, everything else to
 * direct dispatch — design §7.3 T1 vs T2) and its declared dependencies.
 * Deliberately excludes `with`/`timeoutMinutes`/anything else the schema
 * carries: the planner does not interpret step bodies (NFR-01).
 *
 * `when` is NOT a field of this type on purpose. Requirements.md 4.2 scope
 * table lists `when` as reserved/out-of-scope for the PoC, and
 * schemas/pipeline.schema.json already rejects it (`additionalProperties:
 * false` on every step variant) before a definition ever reaches this
 * module. This type mirrors that: there is no `when` to silently read as
 * "always true". `planNextActions` still defends in depth against a step
 * object that carries a `when` property despite the type (e.g. handed in
 * from a not-yet-validated source) — see the guard at the top of the
 * function, which rejects by throwing rather than ignoring it.
 */
export interface PlannerStepDefinition {
  readonly id: string;
  readonly type: StepType;
  readonly needs?: readonly string[];
}

/** The planner's view of a Pipeline Definition (design §4.2's `steps`/`finally`). */
export interface PlannerDefinition {
  readonly steps: readonly PlannerStepDefinition[];
  readonly finally?: readonly PlannerStepDefinition[];
}

/**
 * The subset of a persisted Step item (design §5.1) the planner reads:
 * current state and dispatch type. Everything else (attempt, dispatchToken,
 * externalRef, …) belongs to the conditional write the dispatcher performs
 * when it turns a planner action into an actual transition (DD-06) — the
 * planner itself never needs it to decide WHAT should happen next.
 */
export interface PlannerStepSnapshot {
  readonly type: StepType;
  readonly state: StepState;
}

/**
 * The only two execution-terminal outcomes this planner ever computes.
 * CANCELLED is a closed ExecutionOutcome member (state-machine/index.ts)
 * reachable only through an operator action the planner never originates,
 * so it is deliberately excluded here rather than silently supported.
 */
export type PlannerExecutionOutcome = Extract<ExecutionOutcome, "SUCCEEDED" | "FAILED" | "TIMED_OUT">;

export type PlannerAction =
  /** T1: PENDING -> DISPATCHING. Non-ssh types only. */
  | { readonly kind: "DISPATCH"; readonly stepId: string }
  /** T2: PENDING -> WAITING_LOCK. ssh only. */
  | { readonly kind: "ENTER_LOCK_WAIT"; readonly stepId: string }
  /** T11: PENDING -> SKIPPED. A direct or transitive dependency ended FAILED/TIMED_OUT/SKIPPED. */
  | { readonly kind: "SKIP"; readonly stepId: string; readonly reason: string }
  /** Every main step is terminal; dispatch the still-PENDING `finally` steps. Emitted once (FR-06 "finally").
   * Carries only step ids, not types: a `finally` step of type `ssh` must still be routed through T2
   * (`ENTER_LOCK_WAIT`), not T1, by whatever consumes this action. */
  | { readonly kind: "RUN_FINALLY"; readonly stepIds: readonly string[] }
  /** Every main step AND every `finally` step is terminal; the execution itself ends. */
  | { readonly kind: "CLOSE_EXECUTION"; readonly outcome: PlannerExecutionOutcome };

function isTerminal(state: StepState): boolean {
  return TERMINAL_STEP_STATES.has(state);
}

function assertNoReservedWhen(steps: readonly PlannerStepDefinition[]): void {
  for (const step of steps) {
    if (Object.prototype.hasOwnProperty.call(step, "when")) {
      // `when` is reserved in the PoC (requirements.md 4.2 scope table) and
      // the schema already rejects it before a definition is valid. If one
      // somehow reaches the planner, the correct behavior is to reject the
      // plan outright — never to silently treat it as true/false.
      throw new Error(
        `planner: step '${step.id}' carries a reserved 'when' field; the PoC does not support conditional steps`,
      );
    }
  }
}

/**
 * Computes, for every main step still `PENDING`, whether it must be
 * cascade-skipped (design §7.3 T11; requirements FR-06 "dependency
 * failure"; FR-16 F5): a direct or TRANSITIVE dependency that ended
 * FAILED/TIMED_OUT/SKIPPED. Runs to a fixed point so a multi-level chain
 * (e.g. A fails -> B skip -> C skip, where C only needs B) is fully
 * resolved from a single snapshot, in one planner call — the caller never
 * has to re-invoke the planner level by level.
 */
function computeSkipReasons(
  steps: readonly PlannerStepDefinition[],
  snapshots: ReadonlyMap<string, PlannerStepSnapshot>,
): Map<string, string> {
  const skipReasons = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (skipReasons.has(step.id)) continue;
      const snapshot = snapshots.get(step.id);
      if (!snapshot || snapshot.state !== "PENDING") continue;
      for (const dependencyId of step.needs ?? []) {
        const dependencySnapshot = snapshots.get(dependencyId);
        const dependencyState = dependencySnapshot?.state;
        const dependencyDoomed =
          dependencyState === "FAILED" ||
          dependencyState === "TIMED_OUT" ||
          dependencyState === "SKIPPED" ||
          skipReasons.has(dependencyId);
        if (dependencyDoomed) {
          // Advisory fix: name the ancestor's REAL terminal state when it has
          // one (FAILED/TIMED_OUT/SKIPPED). A transitive ancestor is doomed
          // via `skipReasons.has(dependencyId)` while its own persisted state
          // is still PENDING (its SKIP action is only emitted by this same
          // planner call, not yet applied) — in that case the honest label is
          // "SKIPPED", since that is exactly the T11 transition this call is
          // about to request for it. Never report "ended PENDING": PENDING is
          // not a terminal state and was never the ancestor's doom.
          const effectiveState =
            dependencyState === "FAILED" || dependencyState === "TIMED_OUT" || dependencyState === "SKIPPED"
              ? dependencyState
              : "SKIPPED";
          skipReasons.set(step.id, `dependency '${dependencyId}' ended ${effectiveState}`);
          changed = true;
          break;
        }
      }
    }
  }
  return skipReasons;
}

function allNeedsSucceeded(
  needs: readonly string[] | undefined,
  snapshots: ReadonlyMap<string, PlannerStepSnapshot>,
): boolean {
  if (!needs || needs.length === 0) return true;
  return needs.every((dependencyId) => snapshots.get(dependencyId)?.state === "SUCCEEDED");
}

/** FR-06 "dependency failure": FAILED beats TIMED_OUT beats SUCCEEDED (see
 * this task's Not Done / Assumptions for why — the spec does not state a
 * precedence rule for a mix of FAILED and TIMED_OUT main steps). A SKIPPED
 * step contributes nothing to this computation. For a step SKIPPED via T11,
 * that is safe because it always has a FAILED/TIMED_OUT ancestor that the
 * branches below already catch on their own. BUT design §7.3 T4
 * (`WAITING_LOCK` -> `SKIPPED` via supersede, `ssh` only) is a SECOND and
 * unrelated route to SKIPPED with no FAILED/TIMED_OUT ancestor at all. What
 * the execution outcome should be when a superseded (T4) step is the only
 * non-SUCCEEDED main step is NOT stated anywhere in FR-06 or §7.3 — this is
 * an owner gap to raise, not a rule this function derives from the spec. */
function computeOutcome(mainSteps: readonly PlannerStepDefinition[], snapshots: ReadonlyMap<string, PlannerStepSnapshot>): PlannerExecutionOutcome {
  let sawTimedOut = false;
  for (const step of mainSteps) {
    const state = snapshots.get(step.id)?.state;
    if (state === "FAILED") return "FAILED";
    if (state === "TIMED_OUT") sawTimedOut = true;
  }
  return sawTimedOut ? "TIMED_OUT" : "SUCCEEDED";
}

/**
 * Computes the next actions for one execution, given its definition and the
 * current snapshot of every step (main and `finally`). Pure: never mutates
 * its inputs, never reads anything outside them, and returns the same
 * result for the same inputs every time it is called (idempotent by
 * construction — see the module doc's fan-in note).
 */
export function planNextActions(
  definition: PlannerDefinition,
  stepSnapshots: ReadonlyMap<string, PlannerStepSnapshot>,
): readonly PlannerAction[] {
  const finallySteps = definition.finally ?? [];
  assertNoReservedWhen(definition.steps);
  assertNoReservedWhen(finallySteps);

  const actions: PlannerAction[] = [];

  const skipReasons = computeSkipReasons(definition.steps, stepSnapshots);
  for (const step of definition.steps) {
    const reason = skipReasons.get(step.id);
    if (reason) {
      actions.push({ kind: "SKIP", stepId: step.id, reason });
    }
  }

  for (const step of definition.steps) {
    if (skipReasons.has(step.id)) continue;
    const snapshot = stepSnapshots.get(step.id);
    if (!snapshot || snapshot.state !== "PENDING") continue;
    // Load-bearing guard (DD-06's implication): never emit a dispatch before
    // every `needs` dependency is SUCCEEDED — this is what makes the
    // "fan-in only once both images are done" scenario hold.
    if (!allNeedsSucceeded(step.needs, stepSnapshots)) continue;
    if (step.type === "ssh") {
      actions.push({ kind: "ENTER_LOCK_WAIT", stepId: step.id });
    } else {
      actions.push({ kind: "DISPATCH", stepId: step.id });
    }
  }
  // Policy note (left unchanged, owner-level ambiguity): this loop keeps
  // dispatching every OTHER still-PENDING, non-doomed step even after some
  // sibling step has already FAILED/TIMED_OUT elsewhere in the same
  // execution — FR-06 only says dependents of the failed step move to
  // SKIPPED, it does not say independent in-flight/pending steps must stop
  // early. Whether the Executor should instead halt new dispatches as soon
  // as any step fails is not decided by this task; this planner preserves
  // the existing "let independent steps finish" behavior.

  const allMainTerminal = definition.steps.every((step) => isTerminal(stepSnapshots.get(step.id)?.state ?? "PENDING"));

  if (allMainTerminal && finallySteps.length > 0) {
    // Advisory fix: a `finally` step with no snapshot entry yet (e.g. its
    // Step item was never created, DD-04-style gap between definition and
    // persisted state) is treated as PENDING here, same as `allFinallyTerminal`
    // below already does. Without this, such a step would never be selected
    // for RUN_FINALLY (so it would never run) while still not counting as
    // terminal for `allFinallyTerminal` — a deadlock that blocks
    // CLOSE_EXECUTION forever. Treating "missing" as "PENDING" for this
    // purpose is what lets the execution eventually close.
    const pendingFinallyIds = finallySteps
      .filter((step) => (stepSnapshots.get(step.id)?.state ?? "PENDING") === "PENDING")
      .map((step) => step.id);
    if (pendingFinallyIds.length > 0) {
      // Note: RUN_FINALLY does not distinguish step type. A `finally` step
      // of type `ssh` still needs T2 (`PENDING` -> `WAITING_LOCK`), not T1 —
      // the consumer/dispatcher that turns this action into real transitions
      // must route each returned id through the same type-based T1/T2 split
      // this planner already applies to main steps above, never dispatch all
      // of them via T1 unconditionally.
      actions.push({ kind: "RUN_FINALLY", stepIds: pendingFinallyIds });
    }
  }

  const allFinallyTerminal = finallySteps.every((step) => isTerminal(stepSnapshots.get(step.id)?.state ?? "PENDING"));

  if (allMainTerminal && allFinallyTerminal) {
    // FR-06 "finally" BUT clause: the outcome is computed from the main
    // steps ONLY. By the time every finally step is also terminal, every
    // main step's state has been terminal (and therefore immutable,
    // design §7.3) since before finally even started — so a failing
    // `finally` step can never flip an outcome already locked in here.
    actions.push({ kind: "CLOSE_EXECUTION", outcome: computeOutcome(definition.steps, stepSnapshots) });
  }

  return actions;
}
