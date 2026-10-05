// @akili-spec changes/cicd-executor-poc design DD-06, §7.3 (T1, T2, T11); requirements FR-06, FR-16 F5
//
// Proves the planner against the PRMS Reporting DEV graph from design §3.3
// / pipeline-definitions/prms/reporting-dev.yaml (sanitized references,
// semantic step ids kept verbatim): server-quality ∥ client-quality, each
// gating its own *-image build, both images fanning in on a single ssh
// `deploy`, with a `notify` `finally` step. This graph has real parallelism
// (two independent lambda steps) AND a real join (two-dependency fan-in),
// which a linear chain fixture cannot exercise — a planner bug that
// dispatches `deploy` after only one image succeeds would stay invisible on
// a linear graph (this task's disqualifier note).

import { describe, expect, it } from "vitest";
import {
  planNextActions,
  type PlannerAction,
  type PlannerDefinition,
  type PlannerStepSnapshot,
} from "../../src/domain/planner/index.js";
import type { StepState } from "../../src/domain/state-machine/index.js";

const PRMS_DEFINITION: PlannerDefinition = {
  steps: [
    { id: "server-quality", type: "lambda" },
    { id: "client-quality", type: "lambda" },
    { id: "server-image", type: "codebuild", needs: ["server-quality"] },
    { id: "client-image", type: "codebuild", needs: ["client-quality"] },
    { id: "deploy", type: "ssh", needs: ["server-image", "client-image"] },
  ],
  finally: [{ id: "notify", type: "notify" }],
};

/** Builds a full snapshot map (every step defaults to PENDING) with the given overrides. */
function snapshotsOf(
  overrides: Readonly<Record<string, StepState>>,
  definition: PlannerDefinition = PRMS_DEFINITION,
): ReadonlyMap<string, PlannerStepSnapshot> {
  const map = new Map<string, PlannerStepSnapshot>();
  for (const step of [...definition.steps, ...(definition.finally ?? [])]) {
    map.set(step.id, { type: step.type, state: overrides[step.id] ?? "PENDING" });
  }
  return map;
}

function actionsOfKind<K extends PlannerAction["kind"]>(
  actions: readonly PlannerAction[],
  kind: K,
): readonly Extract<PlannerAction, { kind: K }>[] {
  return actions.filter((action): action is Extract<PlannerAction, { kind: K }> => action.kind === kind);
}

describe("planner (FR-06 step scheduling)", () => {
  it("dispatches independent steps in parallel without waiting for each other (FR-06 'parallelism')", () => {
    const snapshots = snapshotsOf({});

    const actions = planNextActions(PRMS_DEFINITION, snapshots);

    const dispatched = actionsOfKind(actions, "DISPATCH").map((a) => a.stepId);
    expect(dispatched).toEqual(["server-quality", "client-quality"]);
    // Neither image nor deploy is eligible yet: their needs are still PENDING.
    expect(actionsOfKind(actions, "ENTER_LOCK_WAIT")).toEqual([]);
  });

  it("does NOT dispatch deploy (fan-in) when only one image has succeeded (FR-06 'fan-in exactly once')", () => {
    const snapshots = snapshotsOf({
      "server-quality": "SUCCEEDED",
      "client-quality": "SUCCEEDED",
      "server-image": "SUCCEEDED",
      "client-image": "RUNNING", // client-image NOT done yet
    });

    const actions = planNextActions(PRMS_DEFINITION, snapshots);

    expect(actionsOfKind(actions, "ENTER_LOCK_WAIT")).toEqual([]);
    expect(actions.find((a) => "stepId" in a && a.stepId === "deploy")).toBeUndefined();
  });

  it("dispatches deploy via ENTER_LOCK_WAIT (ssh -> T2) exactly once both images have succeeded", () => {
    const snapshots = snapshotsOf({
      "server-quality": "SUCCEEDED",
      "client-quality": "SUCCEEDED",
      "server-image": "SUCCEEDED",
      "client-image": "SUCCEEDED",
    });

    const actions = planNextActions(PRMS_DEFINITION, snapshots);

    expect(actionsOfKind(actions, "ENTER_LOCK_WAIT")).toEqual([{ kind: "ENTER_LOCK_WAIT", stepId: "deploy" }]);
    expect(actionsOfKind(actions, "DISPATCH")).toEqual([]);
  });

  it("cascade-skips transitive dependents of a FAILED step (FR-06 'dependency failure', FR-16 F5)", () => {
    const snapshots = snapshotsOf({
      "server-quality": "FAILED",
      "client-quality": "SUCCEEDED",
      "client-image": "SUCCEEDED",
      // server-image and deploy are still PENDING in the persisted snapshot:
      // the planner must resolve the FULL chain (server-image, then the
      // transitively-dependent deploy) from this single snapshot.
    });

    const actions = planNextActions(PRMS_DEFINITION, snapshots);

    const skipped = actionsOfKind(actions, "SKIP");
    expect(skipped.map((a) => a.stepId).sort()).toEqual(["deploy", "server-image"]);
    const serverImageSkip = skipped.find((a) => a.stepId === "server-image");
    expect(serverImageSkip?.reason).toContain("server-quality");
    const deploySkip = skipped.find((a) => a.stepId === "deploy");
    expect(deploySkip?.reason).toContain("server-image");
    // Nothing gets dispatched once it is doomed.
    expect(actionsOfKind(actions, "ENTER_LOCK_WAIT")).toEqual([]);
    // `client-image` is SUCCEEDED (not merely PENDING-and-doomed) in this
    // snapshot, so every main step IS already terminal (server-quality:
    // FAILED, client-quality: SUCCEEDED, client-image: SUCCEEDED,
    // server-image/deploy: about to be SKIPPED by the actions above, but
    // still PENDING in THIS snapshot) -- guards against a mutation that
    // treats "any FAILED main step" as sufficient for allMainTerminal
    // without waiting for server-image/deploy's own persisted state.
    expect(actionsOfKind(actions, "RUN_FINALLY")).toEqual([]);
  });

  it("does NOT run finally or close the execution while an independent step is still in flight after a failure (FR-06 'dependency failure' AND clause)", () => {
    const snapshots = snapshotsOf({
      "server-quality": "FAILED",
      "client-quality": "SUCCEEDED",
      "client-image": "RUNNING", // still in progress: must be allowed to finish first
      // server-image and deploy remain PENDING (cascade-doomed by server-quality,
      // but not yet applied as SKIPPED in this snapshot).
    });

    const actions = planNextActions(PRMS_DEFINITION, snapshots);

    // FR-06 "dependency failure" AND clause: "the execution ends in FAILED
    // ... AFTER completing the steps already in progress and the `finally`
    // steps". client-image is still RUNNING, so neither finally nor close
    // may fire yet.
    expect(actionsOfKind(actions, "RUN_FINALLY")).toEqual([]);
    expect(actionsOfKind(actions, "CLOSE_EXECUTION")).toEqual([]);
  });

  it("cascade-skips dependents of a TIMED_OUT step and closes the execution TIMED_OUT once everything is terminal (FR-06 'dependency failure', GIVEN 'FAILED or TIMED_OUT')", () => {
    const snapshots = snapshotsOf({
      "server-quality": "SUCCEEDED",
      "client-quality": "SUCCEEDED",
      "server-image": "TIMED_OUT",
      "client-image": "SUCCEEDED",
      // deploy remains PENDING in this snapshot: the planner must skip it
      // transitively from server-image's TIMED_OUT state.
    });

    const actions = planNextActions(PRMS_DEFINITION, snapshots);

    const deploySkip = actionsOfKind(actions, "SKIP").find((a) => a.stepId === "deploy");
    expect(deploySkip).toBeDefined();
    expect(deploySkip?.reason).toContain("server-image");

    const allTerminal = snapshotsOf({
      "server-quality": "SUCCEEDED",
      "client-quality": "SUCCEEDED",
      "server-image": "TIMED_OUT",
      "client-image": "SUCCEEDED",
      deploy: "SKIPPED",
      notify: "SUCCEEDED",
    });
    expect(actionsOfKind(planNextActions(PRMS_DEFINITION, allTerminal), "CLOSE_EXECUTION")).toEqual([
      { kind: "CLOSE_EXECUTION", outcome: "TIMED_OUT" },
    ]);
  });

  it("runs finally once, exactly when every main step is terminal", () => {
    const notRunningYet = snapshotsOf({
      "server-quality": "SUCCEEDED",
      "client-quality": "SUCCEEDED",
      "server-image": "SUCCEEDED",
      "client-image": "SUCCEEDED",
      deploy: "RUNNING", // main steps not all terminal yet
    });
    expect(planNextActions(PRMS_DEFINITION, notRunningYet).some((a) => a.kind === "RUN_FINALLY")).toBe(false);

    const allMainTerminal = snapshotsOf({
      "server-quality": "SUCCEEDED",
      "client-quality": "SUCCEEDED",
      "server-image": "SUCCEEDED",
      "client-image": "SUCCEEDED",
      deploy: "SUCCEEDED",
    });
    const actions = planNextActions(PRMS_DEFINITION, allMainTerminal);
    expect(actionsOfKind(actions, "RUN_FINALLY")).toEqual([{ kind: "RUN_FINALLY", stepIds: ["notify"] }]);
    // Not closed yet: `notify` itself is still PENDING.
    expect(actionsOfKind(actions, "CLOSE_EXECUTION")).toEqual([]);

    // Once `notify` has already been dispatched (no longer PENDING), the
    // same all-main-terminal snapshot must NOT re-emit RUN_FINALLY — proves
    // "finally runs once" without needing a second planner call to look stale.
    const finallyAlreadyRunning = snapshotsOf({
      "server-quality": "SUCCEEDED",
      "client-quality": "SUCCEEDED",
      "server-image": "SUCCEEDED",
      "client-image": "SUCCEEDED",
      deploy: "SUCCEEDED",
      notify: "RUNNING",
    });
    expect(actionsOfKind(planNextActions(PRMS_DEFINITION, finallyAlreadyRunning), "RUN_FINALLY")).toEqual([]);
  });

  it("closes the execution SUCCEEDED once finally also finishes, and a FAILED finally does NOT flip it (FR-06 'finally' BUT clause)", () => {
    const base: Record<string, StepState> = {
      "server-quality": "SUCCEEDED",
      "client-quality": "SUCCEEDED",
      "server-image": "SUCCEEDED",
      "client-image": "SUCCEEDED",
      deploy: "SUCCEEDED",
    };

    const finallyFailed = snapshotsOf({ ...base, notify: "FAILED" });
    const actions = planNextActions(PRMS_DEFINITION, finallyFailed);
    expect(actionsOfKind(actions, "CLOSE_EXECUTION")).toEqual([
      { kind: "CLOSE_EXECUTION", outcome: "SUCCEEDED" },
    ]);
  });

  it("closes the execution FAILED when a main step failed, regardless of finally's own outcome", () => {
    const snapshots = snapshotsOf({
      "server-quality": "FAILED",
      "client-quality": "SUCCEEDED",
      "client-image": "SUCCEEDED",
      "server-image": "SKIPPED",
      deploy: "SKIPPED",
      notify: "SUCCEEDED",
    });

    const actions = planNextActions(PRMS_DEFINITION, snapshots);

    expect(actionsOfKind(actions, "CLOSE_EXECUTION")).toEqual([{ kind: "CLOSE_EXECUTION", outcome: "FAILED" }]);
  });

  it("is idempotent: the same snapshot produces the exact same actions on repeated calls (pure function)", () => {
    const snapshots = snapshotsOf({
      "server-quality": "FAILED",
      "client-quality": "SUCCEEDED",
      "client-image": "SUCCEEDED",
    });

    const first = planNextActions(PRMS_DEFINITION, snapshots);
    const second = planNextActions(PRMS_DEFINITION, snapshots);

    expect(second).toEqual(first);
  });

  it("rejects a step carrying the reserved 'when' field instead of silently evaluating it", () => {
    const definitionWithWhen: PlannerDefinition = {
      steps: [
        { id: "server-quality", type: "lambda" },
        // Cast needed: PlannerStepDefinition deliberately has no `when` field.
        { id: "client-quality", type: "lambda", when: "true" } as unknown as PlannerDefinition["steps"][number],
      ],
    };
    const snapshots = snapshotsOf({}, definitionWithWhen);

    expect(() => planNextActions(definitionWithWhen, snapshots)).toThrow(/when/i);
  });
});
