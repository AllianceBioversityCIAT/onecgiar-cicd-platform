// @akili-spec changes/cicd-executor-poc design §7.3; requirements FR-05, FR-11, FR-16
//
// Proves the step state machine is EXACTLY the closed list of T1–T13 from
// design §7.3 — nothing more, nothing less. The core of this file is one
// exhaustive cartesian product over (fromState × type × event kind): for
// every one of the 8 × 5 × 13 = 520 combinations, either it is one of the
// 13 permitted transitions (and must be accepted, landing on the exact
// documented `to` state) or it is not (and must be rejected as
// INVALID_TRANSITION). A test suite that only exercises the permitted
// transitions would not prove the other ~500 combinations are rejected —
// that is the whole point of walking the product instead of hand-picking
// cases (see this task's disqualifier note).
//
// The PERMITTED table below is transcribed independently from design §7.3's
// prose table — it does not import anything from state-machine/index.ts
// beyond the type/state vocabularies, so it cannot be tautologically
// satisfied by whatever the implementation happens to do.

import { describe, expect, it } from "vitest";
import {
  applyExecutionTransition,
  applyStepTransition,
  EXECUTION_STATES,
  STEP_STATES,
  STEP_TYPES,
  TERMINAL_EXECUTION_STATES,
  TERMINAL_STEP_STATES,
  type ExecutionOutcome,
  type ExecutionSnapshot,
  type ExecutionState,
  type ExecutionTransitionRequest,
  type StepSnapshot,
  type StepState,
  type StepType,
  type StepTransitionRequest,
  type TransitionId,
} from "../../src/domain/state-machine/index.js";
import { classifyDeployExitCode } from "../../src/domain/errors/index.js";

type EventKind = StepTransitionRequest["kind"];

const ALL_KINDS: readonly EventKind[] = [
  "DISPATCH",
  "ENTER_LOCK_WAIT",
  "ACQUIRE_LOCK",
  "SUPERSEDE",
  "LOCK_WAIT_FAILED",
  "EXTERNAL_REF_REGISTERED",
  "DISPATCH_FAILED",
  "STEP_RESULT",
  "TARGET_BUSY",
  "STEP_RETRY_REQUESTED",
  "DEPENDENCY_SKIP",
  "RECONCILE_TIMEOUT",
  "RECONCILE_REDISPATCH",
];

/** A fresh baseline snapshot for (state, type): never redispatched, no externalRef yet. */
function baseSnapshot(state: StepState, type: StepType): StepSnapshot {
  return {
    type,
    state,
    attempt: state === "PENDING" ? 0 : 1,
    dispatchToken: state === "DISPATCHING" || state === "RUNNING" ? "tok-base" : undefined,
    externalRef: state === "RUNNING" ? "ref-base" : undefined,
    reconcileRedispatchCount: 0,
    lockWaitStartedAt: state === "WAITING_LOCK" ? 500 : undefined,
    contentionCount: 0,
  };
}

/** The "best case" request for a given kind — guard data that, when the
 * (fromState, type) pair is actually permitted, makes the transition succeed. */
function goodEvent(kind: EventKind, type: StepType): StepTransitionRequest {
  switch (kind) {
    case "DISPATCH":
      return { kind, dependenciesSucceeded: true, newDispatchToken: "tok-new" };
    case "ENTER_LOCK_WAIT":
      return { kind, dependenciesSucceeded: true, now: 1_000 };
    case "ACQUIRE_LOCK":
      return { kind, windowValid: true, lockAcquired: true, superseded: false, newDispatchToken: "tok-new" };
    case "SUPERSEDE":
      return { kind, superseded: true };
    case "LOCK_WAIT_FAILED":
      return { kind, failureCode: "LOCK_TIMEOUT" };
    case "EXTERNAL_REF_REGISTERED":
      return { kind, externalRef: "ref-new" };
    case "DISPATCH_FAILED": {
      // Type-aware per-type dispatch-time code, per the T7_FAILURE_CODES
      // allowlist (design §7.2) — review round 3, finding 2. `notify` has
      // NO valid T7 failure code (FR-14: a notification failure never
      // changes step state), so its value here is well-typed but
      // deliberately NOT expected to be accepted (see PERMITTED below,
      // which has no DISPATCHING+notify+DISPATCH_FAILED entry).
      if (type === "ssh") {
        return { kind, reason: "DEPLOY_WINDOW_CLOSED", failureCode: "DEPLOY_WINDOW_CLOSED" };
      }
      if (type === "lambda" || type === "codebuild") {
        return { kind, reason: "NON_RETRYABLE", failureCode: "INFRA" };
      }
      return { kind, reason: "NON_RETRYABLE", failureCode: "SOURCE_CLONE" }; // source, notify
    }
    case "STEP_RESULT":
      return { kind, outcome: "SUCCEEDED", matchesCurrentAttempt: true };
    case "TARGET_BUSY":
      return { kind, exitCode: 50, matchesCurrentAttempt: true };
    case "STEP_RETRY_REQUESTED":
      return { kind, retryable: true, attemptBelowMax: true, newDispatchToken: "tok-new" };
    case "DEPENDENCY_SKIP":
      return { kind, dependencyUnmet: true };
    case "RECONCILE_TIMEOUT":
      return { kind, deadlineExceeded: true };
    case "RECONCILE_REDISPATCH":
      return { kind, deadlineExceeded: true };
  }
}

interface Permitted {
  readonly id: TransitionId;
  readonly to: StepState;
}

function key(state: StepState, type: StepType, kind: EventKind): string {
  return `${state}::${type}::${kind}`;
}

const NON_SSH = ["source", "lambda", "codebuild", "notify"] as const;
const RETRYABLE = ["source", "lambda", "codebuild"] as const;
const RECONCILE_REDISPATCHABLE = ["codebuild", "lambda"] as const;
const NOT_REDISPATCHABLE_AT_DISPATCHING = ["source", "notify", "ssh"] as const; // T12 at baseline (redispatchCount=0)

// Transcribed verbatim from design §7.3's table (T1–T13). This is the ONLY
// place this file encodes "what is permitted" — everything else derives
// from walking state × type × kind against this map.
const PERMITTED = new Map<string, Permitted>();

for (const type of NON_SSH) {
  PERMITTED.set(key("PENDING", type, "DISPATCH"), { id: "T1", to: "DISPATCHING" });
}
PERMITTED.set(key("PENDING", "ssh", "ENTER_LOCK_WAIT"), { id: "T2", to: "WAITING_LOCK" });
PERMITTED.set(key("WAITING_LOCK", "ssh", "ACQUIRE_LOCK"), { id: "T3", to: "DISPATCHING" });
PERMITTED.set(key("WAITING_LOCK", "ssh", "SUPERSEDE"), { id: "T4", to: "SKIPPED" });
PERMITTED.set(key("WAITING_LOCK", "ssh", "LOCK_WAIT_FAILED"), { id: "T5", to: "FAILED" });
for (const type of STEP_TYPES) {
  PERMITTED.set(key("DISPATCHING", type, "EXTERNAL_REF_REGISTERED"), { id: "T6", to: "RUNNING" });
  // T8's good event uses outcome SUCCEEDED; FAILED/TIMED_OUT outcomes are
  // proven accepted separately below (same (from,type,kind), different payload).
  PERMITTED.set(key("RUNNING", type, "STEP_RESULT"), { id: "T8", to: "SUCCEEDED" });
  PERMITTED.set(key("PENDING", type, "DEPENDENCY_SKIP"), { id: "T11", to: "SKIPPED" });
}
// T7 (DISPATCH_FAILED): every type EXCEPT `notify` has at least one valid
// dispatch-time failure code (T7_FAILURE_CODES allowlist, design §7.2).
// `notify` is deliberately ABSENT — FR-14 "fallo del proveedor": a
// notification failure is logged and never changes step state, so
// DISPATCHING+notify+DISPATCH_FAILED must be rejected for ANY failure code
// (review round 3, finding 2).
for (const type of ["source", "lambda", "codebuild", "ssh"] as const) {
  PERMITTED.set(key("DISPATCHING", type, "DISPATCH_FAILED"), { id: "T7", to: "FAILED" });
}
PERMITTED.set(key("RUNNING", "ssh", "TARGET_BUSY"), { id: "T9", to: "WAITING_LOCK" });
// T12 (RECONCILE_TIMEOUT) from RUNNING: the general §7.3 T12 row applies to
// "todos" whenever T13/adoption don't — only TWO RUNNING cases are carved
// out by the "Recuperación de resultados perdidos por el reconciler" table:
// RUNNING codebuild (always has an externalRef once RUNNING -> BatchGetBuilds
// adopts via T8, or the deadline is extended) and RUNNING ssh (expired lease
// -> T8 FAILED(UNKNOWN_TARGET_STATE)). RUNNING lambda/source/notify have no
// such carve-out, so the general rule applies and T12 IS valid for them
// (Leader correction to review round 3's advisory).
for (const type of ["lambda", "source", "notify"] as const) {
  PERMITTED.set(key("RUNNING", type, "RECONCILE_TIMEOUT"), { id: "T12", to: "TIMED_OUT" });
}
for (const type of RETRYABLE) {
  PERMITTED.set(key("RUNNING", type, "STEP_RETRY_REQUESTED"), { id: "T10", to: "DISPATCHING" });
  PERMITTED.set(key("DISPATCHING", type, "STEP_RETRY_REQUESTED"), { id: "T10", to: "DISPATCHING" });
}
for (const type of NOT_REDISPATCHABLE_AT_DISPATCHING) {
  PERMITTED.set(key("DISPATCHING", type, "RECONCILE_TIMEOUT"), { id: "T12", to: "TIMED_OUT" });
}
// NOTE: (DISPATCHING, codebuild|lambda, RECONCILE_TIMEOUT) is deliberately
// ABSENT at baseline (reconcileRedispatchCount = 0): design §7.3's recovery
// table routes that case through T13 first. It becomes reachable only after
// T13 has already run once — see the dedicated "T12 after T13" test below.
for (const type of RECONCILE_REDISPATCHABLE) {
  PERMITTED.set(key("DISPATCHING", type, "RECONCILE_REDISPATCH"), { id: "T13", to: "DISPATCHING" });
}

describe("state machine — exhaustive cartesian product (fromState × type × event kind)", () => {
  for (const state of STEP_STATES) {
    for (const type of STEP_TYPES) {
      for (const kind of ALL_KINDS) {
        const permitted = PERMITTED.get(key(state, type, kind));
        const label = `${state} + ${type} + ${kind} → ${permitted ? `${permitted.id} accepted (to ${permitted.to})` : "rejected (INVALID_TRANSITION)"}`;

        it(label, () => {
          const snapshot = baseSnapshot(state, type);
          const result = applyStepTransition(snapshot, goodEvent(kind, type));

          if (permitted) {
            expect(result.accepted).toBe(true);
            if (result.accepted) {
              expect(result.transitionId).toBe(permitted.id);
              expect(result.next.state).toBe(permitted.to);
            }
          } else {
            expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
          }
        });
      }
    }
  }
});

describe("terminal states are immutable (FR-05: estados terminales inmutables)", () => {
  for (const state of STEP_STATES) {
    if (!TERMINAL_STEP_STATES.has(state)) continue;
    it(`no event kind moves a step out of ${state}`, () => {
      for (const type of STEP_TYPES) {
        for (const kind of ALL_KINDS) {
          const result = applyStepTransition(baseSnapshot(state, type), goodEvent(kind, type));
          expect(result.accepted).toBe(false);
        }
      }
    });
  }
});

describe("única vuelta atrás permitida (design §7.3, FR-05 scenario)", () => {
  // Backward order used only to express "vuelta atrás": a transition is
  // backward if `to` precedes `from` in the normal forward flow. DISPATCHING
  // and RUNNING share a rank: both mean "an attempt is in flight", and T10's
  // RUNNING/DISPATCHING -> DISPATCHING (same tier, new attempt) is a retry,
  // not the "vuelta atrás" the design calls out — design §7.3 itself labels
  // only T9 that way, precisely because T9 is the sole transition that
  // leaves the dispatch/execution tier back into the lock-wait tier.
  const ORDER: Record<StepState, number> = {
    PENDING: 0,
    WAITING_LOCK: 1,
    DISPATCHING: 2,
    RUNNING: 2,
    SUCCEEDED: 3,
    FAILED: 3,
    TIMED_OUT: 3,
    SKIPPED: 3,
  };

  it("T9 is the ONLY transition the IMPLEMENTATION ever accepts whose `to` state precedes its `from` state", () => {
    // Walks applyStepTransition's own accepted results (not this file's
    // PERMITTED map, which only proves what the test author intended — see
    // review advisory on the previous version of this test). A future bug
    // that adds a second accidental backward path would be invisible to a
    // check against PERMITTED (since PERMITTED wouldn't list it either way);
    // this check interrogates the real function's outputs directly.
    const backwardTransitionIds = new Set<TransitionId>();
    let sawAnyBackward = false;
    for (const state of STEP_STATES) {
      for (const type of STEP_TYPES) {
        for (const kind of ALL_KINDS) {
          const result = applyStepTransition(baseSnapshot(state, type), goodEvent(kind, type));
          if (!result.accepted) continue;
          if (ORDER[result.next.state] < ORDER[state]) {
            sawAnyBackward = true;
            backwardTransitionIds.add(result.transitionId);
          }
        }
      }
    }
    expect(sawAnyBackward).toBe(true); // not vacuously true
    expect([...backwardTransitionIds]).toEqual(["T9"]);
  });

  it("T9: same executionId/step identity preserved, resources released, attempt and contentionCount incremented", () => {
    const running: StepSnapshot = {
      type: "ssh",
      state: "RUNNING",
      attempt: 2,
      dispatchToken: "tok-live",
      externalRef: "ssh-session-7",
      reconcileRedispatchCount: 0,
      lockWaitStartedAt: 10_000,
      contentionCount: 1,
    };
    const result = applyStepTransition(running, { kind: "TARGET_BUSY", exitCode: 50, matchesCurrentAttempt: true });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T9");
    expect(result.next.state).toBe("WAITING_LOCK");
    expect(result.next.attempt).toBe(3);
    expect(result.next.contentionCount).toBe(2);
    expect(result.next.lockWaitStartedAt).toBe(10_000); // same budget clock, not reset
    expect(result.next.dispatchToken).toBeUndefined(); // the closed intent's token is gone
    expect(result.next.externalRef).toBeUndefined();
  });

  it("falsifier: RUNNING→WAITING_LOCK with exit code 40 (not 50) MUST be rejected", () => {
    const running = baseSnapshot("RUNNING", "ssh");
    const result = applyStepTransition(running, { kind: "TARGET_BUSY", exitCode: 40, matchesCurrentAttempt: true });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it.each([0, 10, 20, 30, 40, 51, 100, -1])("T9 rejects any exit code other than 50 (got %i)", (exitCode) => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "ssh"), {
      kind: "TARGET_BUSY",
      exitCode,
      matchesCurrentAttempt: true,
    });
    expect(result.accepted).toBe(false);
  });

  it("T9 from DISPATCHING is rejected (design: code 50 cannot exist before exec/T6)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "TARGET_BUSY",
      exitCode: 50,
      matchesCurrentAttempt: true,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("falsifier (review round 3, finding 1): a stale/redelivered 50 (matchesCurrentAttempt=false) MUST be rejected — it must NOT bounce the live later attempt back to WAITING_LOCK", () => {
    const running: StepSnapshot = {
      type: "ssh",
      state: "RUNNING",
      attempt: 5, // the live, later attempt (e.g. after T3 -> T6 re-dispatched following an earlier T9)
      dispatchToken: "tok-live-attempt-5",
      externalRef: "ssh-session-live",
      reconcileRedispatchCount: 0,
      lockWaitStartedAt: 10_000,
      contentionCount: 1,
    };
    const staleRedelivery = applyStepTransition(running, {
      kind: "TARGET_BUSY",
      exitCode: 50,
      matchesCurrentAttempt: false, // the redelivered message belongs to an earlier, already-superseded attempt
    });
    expect(staleRedelivery).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

});

describe("T10 (STEP_RETRY_REQUESTED) never applies to ssh", () => {
  it.each(["RUNNING", "DISPATCHING"] as const)("rejected from %s", (state) => {
    const result = applyStepTransition(baseSnapshot(state, "ssh"), {
      kind: "STEP_RETRY_REQUESTED",
      retryable: true,
      attemptBelowMax: true,
      newDispatchToken: "tok-new",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("rejected for notify too (design: source, lambda, codebuild only)", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "notify"), {
      kind: "STEP_RETRY_REQUESTED",
      retryable: true,
      attemptBelowMax: true,
      newDispatchToken: "tok-new",
    });
    expect(result.accepted).toBe(false);
  });
});

describe("T13 (RECONCILE_REDISPATCH): ssh and source excluded, at most once", () => {
  it.each(["ssh", "source", "notify"] as const)("rejected for type %s", (type) => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", type), {
      kind: "RECONCILE_REDISPATCH",
      deadlineExceeded: true,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("codebuild/lambda: accepted once, keeps the SAME attempt and dispatchToken, bumps reconcileRedispatchCount", () => {
    const snapshot = baseSnapshot("DISPATCHING", "codebuild");
    const result = applyStepTransition(snapshot, { kind: "RECONCILE_REDISPATCH", deadlineExceeded: true });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T13");
    expect(result.next.state).toBe("DISPATCHING");
    expect(result.next.attempt).toBe(snapshot.attempt); // unchanged
    expect(result.next.dispatchToken).toBe(snapshot.dispatchToken); // SAME token, not new
    expect(result.next.reconcileRedispatchCount).toBe(1);
  });

  it("rejected the second time (reconcileRedispatchCount already 1)", () => {
    const firstRound = baseSnapshot("DISPATCHING", "lambda");
    const firstResult = applyStepTransition(firstRound, { kind: "RECONCILE_REDISPATCH", deadlineExceeded: true });
    expect(firstResult.accepted).toBe(true);
    if (!firstResult.accepted) return;

    const secondResult = applyStepTransition(firstResult.next, {
      kind: "RECONCILE_REDISPATCH",
      deadlineExceeded: true,
    });
    expect(secondResult).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T12 becomes reachable for (DISPATCHING, codebuild/lambda) only AFTER a T13 round already happened", () => {
    const fresh = baseSnapshot("DISPATCHING", "codebuild");

    // At baseline (reconcileRedispatchCount = 0): T12 is rejected, must go through T13 first.
    const prematureTimeout = applyStepTransition(fresh, { kind: "RECONCILE_TIMEOUT", deadlineExceeded: true });
    expect(prematureTimeout).toEqual({ accepted: false, code: "INVALID_TRANSITION" });

    const afterRedispatch = applyStepTransition(fresh, { kind: "RECONCILE_REDISPATCH", deadlineExceeded: true });
    expect(afterRedispatch.accepted).toBe(true);
    if (!afterRedispatch.accepted) return;

    const secondTimeout = applyStepTransition(afterRedispatch.next, {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: true,
    });
    expect(secondTimeout.accepted).toBe(true);
    if (!secondTimeout.accepted) return;
    expect(secondTimeout.transitionId).toBe("T12");
    expect(secondTimeout.next.state).toBe("TIMED_OUT");
  });
});

describe("canonical rule: WAITING_LOCK budget exhaustion is ALWAYS FAILED(LOCK_TIMEOUT), never TIMED_OUT (design §7.3, FR-11)", () => {
  it("the lock-retry handler's path: LOCK_WAIT_FAILED(LOCK_TIMEOUT) from WAITING_LOCK -> FAILED with resultCode LOCK_TIMEOUT", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "LOCK_WAIT_FAILED",
      failureCode: "LOCK_TIMEOUT",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T5");
    expect(result.next.state).toBe("FAILED");
    expect(result.next.resultCode).toBe("LOCK_TIMEOUT");
  });

  it("the reconciler's path produces the exact same result (determinism across whoever detects it first)", () => {
    const snapshot = baseSnapshot("WAITING_LOCK", "ssh");
    const fromHandler = applyStepTransition(snapshot, { kind: "LOCK_WAIT_FAILED", failureCode: "LOCK_TIMEOUT" });
    const fromReconciler = applyStepTransition(snapshot, { kind: "LOCK_WAIT_FAILED", failureCode: "LOCK_TIMEOUT" });
    expect(fromHandler).toEqual(fromReconciler);
  });

  it("T12 (generic TIMED_OUT) is never reachable from WAITING_LOCK, for any type", () => {
    for (const type of STEP_TYPES) {
      const result = applyStepTransition(baseSnapshot("WAITING_LOCK", type), {
        kind: "RECONCILE_TIMEOUT",
        deadlineExceeded: true,
      });
      expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
    }
  });

  it("STEP_RESULT(TIMED_OUT) is never reachable from WAITING_LOCK either (T8 requires RUNNING)", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "STEP_RESULT",
      outcome: "TIMED_OUT",
      matchesCurrentAttempt: true,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("DEPLOY_WINDOW_CLOSED is the only other valid T5 outcome (V1/V2 revalidation, FR-18)", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "LOCK_WAIT_FAILED",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.state).toBe("FAILED");
    expect(result.next.resultCode).toBe("DEPLOY_WINDOW_CLOSED");
  });
});

describe("T7 guard: DEPLOY_WINDOW_CLOSED (V4) is ssh-only (design §7.7)", () => {
  it("rejected for a non-ssh type even though DISPATCHING->FAILED is otherwise permitted", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "lambda"), {
      kind: "DISPATCH_FAILED",
      reason: "DEPLOY_WINDOW_CLOSED",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("accepted for ssh", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "DISPATCH_FAILED",
      reason: "DEPLOY_WINDOW_CLOSED",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result.accepted).toBe(true);
  });

  it("ssh can still fail with a non-window reason (e.g. SSH_CONNECT exhausted retries)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "DISPATCH_FAILED",
      reason: "RETRIES_EXHAUSTED",
      failureCode: "SSH_CONNECT",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.resultCode).toBe("SSH_CONNECT");
  });
});

describe("T8 outcome fan-out and the orphan-event guard (FR-07, §6.1)", () => {
  it("FAILED outcome carries the given failureCode through", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "codebuild"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "BUILD",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.state).toBe("FAILED");
    expect(result.next.resultCode).toBe("BUILD");
  });

  it("TIMED_OUT outcome always carries resultCode TIMED_OUT", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "STEP_RESULT",
      outcome: "TIMED_OUT",
      matchesCurrentAttempt: true,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.resultCode).toBe("TIMED_OUT");
  });

  it("a result from a superseded/orphan attempt (matchesCurrentAttempt=false) is rejected, never modifies the vigent attempt", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "codebuild"), {
      kind: "STEP_RESULT",
      outcome: "SUCCEEDED",
      matchesCurrentAttempt: false,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });
});

describe("FR-05 scenarios (requirements.md verbatim scenario titles)", () => {
  it("Scenario: transición válida — a RUNNING step whose finalization succeeds moves to SUCCEEDED", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "STEP_RESULT",
      outcome: "SUCCEEDED",
      matchesCurrentAttempt: true,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.state).toBe("SUCCEEDED");
  });

  it("Scenario: transición inválida — a terminal step ignores any incoming event (no-op)", () => {
    const terminalSnapshot = baseSnapshot("SUCCEEDED", "lambda");
    const result = applyStepTransition(terminalSnapshot, {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "INFRA",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("Scenario: única vuelta atrás permitida — BUT no other transition reopens an earlier state (real check, not a placeholder)", () => {
    // The full exhaustive proof lives in the "única vuelta atrás permitida"
    // describe block above; this restates the scenario's own BUT clause
    // concretely instead of a vacuous assertion: take two transitions the
    // scenario text explicitly calls out as NOT allowed to go backward
    // (LOCK_WAIT_FAILED, STEP_RESULT) and confirm neither one ever lands on
    // a state ranked behind its origin.
    const lockWaitFailed = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "LOCK_WAIT_FAILED",
      failureCode: "LOCK_TIMEOUT",
    });
    expect(lockWaitFailed.accepted && lockWaitFailed.next.state).toBe("FAILED"); // forward (terminal), not backward to PENDING

    const stepResult = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "INFRA",
    });
    expect(stepResult.accepted && stepResult.next.state).toBe("FAILED"); // forward (terminal), not backward to DISPATCHING
  });

  it("Scenario: steps paralelos — applyStepTransition is pure: independent snapshots never share mutable state", () => {
    const a = baseSnapshot("RUNNING", "lambda");
    const b = baseSnapshot("RUNNING", "codebuild");
    const resultA = applyStepTransition(a, { kind: "STEP_RESULT", outcome: "SUCCEEDED", matchesCurrentAttempt: true });
    const resultB = applyStepTransition(b, { kind: "STEP_RESULT", outcome: "FAILED", matchesCurrentAttempt: true, failureCode: "BUILD" });
    expect(a.state).toBe("RUNNING"); // input snapshot never mutated
    expect(b.state).toBe("RUNNING");
    expect(resultA.accepted && resultA.next.state).toBe("SUCCEEDED");
    expect(resultB.accepted && resultB.next.state).toBe("FAILED");
  });

  it("Scenario: reinicio del Executor — the function is a deterministic pure function of its inputs (no in-process memory)", () => {
    const snapshot = baseSnapshot("DISPATCHING", "codebuild");
    const event: StepTransitionRequest = { kind: "EXTERNAL_REF_REGISTERED", externalRef: "build-123" };
    const first = applyStepTransition(snapshot, event);
    const second = applyStepTransition(snapshot, event); // same inputs, called again "after a restart"
    expect(first).toEqual(second);
  });
});

describe("FR-11 scenarios mapped to transitions", () => {
  it("Scenario: ocupado — tras agotar la espera de 30 min, el único resultado es LOCK_TIMEOUT", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "LOCK_WAIT_FAILED",
      failureCode: "LOCK_TIMEOUT",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.resultCode).toBe("LOCK_TIMEOUT");
    expect(result.next.state).toBe("FAILED");
  });

  it("Scenario: supersede — WAITING_LOCK -> SKIPPED(SUPERSEDED), without ever reaching DISPATCHING", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "SUPERSEDE",
      superseded: true,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T4");
    expect(result.next.state).toBe("SKIPPED");
    expect(result.next.resultCode).toBe("SUPERSEDED");
  });

  it("ACQUIRE_LOCK is rejected once superseded is true (must take T4, not T3)", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "ACQUIRE_LOCK",
      windowValid: true,
      lockAcquired: true,
      superseded: true,
      newDispatchToken: "tok-new",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("SUPERSEDE is rejected when superseded is false", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "SUPERSEDE",
      superseded: false,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });
});

describe("FR-16 failure-behavior rows mapped to transitions", () => {
  it("F4: Lambda INFRA error re-dispatches via T10 (RUNNING -> DISPATCHING, attempt+1)", () => {
    const snapshot = baseSnapshot("RUNNING", "lambda");
    const result = applyStepTransition(snapshot, {
      kind: "STEP_RETRY_REQUESTED",
      retryable: true,
      attemptBelowMax: true,
      newDispatchToken: "tok-retry",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T10");
    expect(result.next.attempt).toBe(snapshot.attempt + 1);
    expect(result.next.dispatchToken).toBe("tok-retry");
  });

  it("F5: Quality rojo (Lambda business failure) -> FAILED, no retry path offered by the machine itself", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "QUALITY",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.resultCode).toBe("QUALITY");
  });

  it("F6: Lambda sin resultado al vencer el plazo -> T12 TIMED_OUT (recovery table)", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: true,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T12");
    expect(result.next.state).toBe("TIMED_OUT");
  });

  it("F7: Build fallido -> FAILED (BUILD) sin reintento", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "codebuild"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "BUILD",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.resultCode).toBe("BUILD");
  });

  it("F11/F12/F13: deploy script exit codes 20/30/40 map through classifyDeployExitCode into T8 FAILED", () => {
    for (const exitCode of [10, 20, 30, 40] as const) {
      const failureCode = classifyDeployExitCode(exitCode);
      const result = applyStepTransition(baseSnapshot("RUNNING", "ssh"), {
        kind: "STEP_RESULT",
        outcome: "FAILED",
        matchesCurrentAttempt: true,
        failureCode,
      });
      expect(result.accepted).toBe(true);
      if (!result.accepted) continue;
      expect(result.next.resultCode).toBe(failureCode);
    }
  });

  it("F16: ejecución atascada -> reconciliación -> TIMED_OUT (T12, DISPATCHING, non-redispatchable type)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "source"), {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: true,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T12");
  });

  it("F17: lock huérfano con deploy en curso -> cierre con UNKNOWN_TARGET_STATE (T8 FAILED)", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "ssh"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "UNKNOWN_TARGET_STATE",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.resultCode).toBe("UNKNOWN_TARGET_STATE");
  });

  it("F18: código 50 vuelve a WAITING_LOCK (T9); si se agota el presupuesto, LOCK_TIMEOUT (T5)", () => {
    const running: StepSnapshot = { ...baseSnapshot("RUNNING", "ssh"), lockWaitStartedAt: 0 };
    const busy = applyStepTransition(running, { kind: "TARGET_BUSY", exitCode: 50, matchesCurrentAttempt: true });
    expect(busy.accepted).toBe(true);
    if (!busy.accepted) return;
    expect(busy.next.state).toBe("WAITING_LOCK");

    const exhausted = applyStepTransition(busy.next, { kind: "LOCK_WAIT_FAILED", failureCode: "LOCK_TIMEOUT" });
    expect(exhausted.accepted).toBe(true);
    if (!exhausted.accepted) return;
    expect(exhausted.next.state).toBe("FAILED");
    expect(exhausted.next.resultCode).toBe("LOCK_TIMEOUT");
  });

  it("F19: ventana cerrada sin abrir SSH -> FAILED(DEPLOY_WINDOW_CLOSED) desde WAITING_LOCK (V1/V2)", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "LOCK_WAIT_FAILED",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.next.state).toBe("FAILED");
    expect(result.next.resultCode).toBe("DEPLOY_WINDOW_CLOSED");
  });

  it("F19 (V4 variant): ventana cerrada justo antes del exec -> FAILED(DEPLOY_WINDOW_CLOSED) desde DISPATCHING", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "DISPATCH_FAILED",
      reason: "DEPLOY_WINDOW_CLOSED",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T7");
    expect(result.next.resultCode).toBe("DEPLOY_WINDOW_CLOSED");
  });
});

// ---------------------------------------------------------------------------
// Review round 2 remediation: every guard must be proven with a FAILING
// value, not just the "good request" the cartesian product sends. Deleting
// any one of these guard checks from index.ts must turn exactly the named
// test red (falsifiers quoted in the completion report).
// ---------------------------------------------------------------------------

describe("guard falsifiers: each guard rejects on its failing value (review round 2, issue 2)", () => {
  it("T1 DISPATCH: dependenciesSucceeded=false is rejected (PENDING, non-ssh)", () => {
    const result = applyStepTransition(baseSnapshot("PENDING", "lambda"), {
      kind: "DISPATCH",
      dependenciesSucceeded: false,
      newDispatchToken: "tok-new",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T2 ENTER_LOCK_WAIT: dependenciesSucceeded=false is rejected (PENDING, ssh)", () => {
    const result = applyStepTransition(baseSnapshot("PENDING", "ssh"), {
      kind: "ENTER_LOCK_WAIT",
      dependenciesSucceeded: false,
      now: 1_000,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T3 ACQUIRE_LOCK: windowValid=false is rejected even with lockAcquired=true", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "ACQUIRE_LOCK",
      windowValid: false,
      lockAcquired: true,
      superseded: false,
      newDispatchToken: "tok-new",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T3 ACQUIRE_LOCK: lockAcquired=false is rejected even with windowValid=true", () => {
    const result = applyStepTransition(baseSnapshot("WAITING_LOCK", "ssh"), {
      kind: "ACQUIRE_LOCK",
      windowValid: true,
      lockAcquired: false,
      superseded: false,
      newDispatchToken: "tok-new",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T6 EXTERNAL_REF_REGISTERED: empty externalRef is rejected", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "codebuild"), {
      kind: "EXTERNAL_REF_REGISTERED",
      externalRef: "",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T10 STEP_RETRY_REQUESTED: retryable=false is rejected even with attemptBelowMax=true", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "STEP_RETRY_REQUESTED",
      retryable: false,
      attemptBelowMax: true,
      newDispatchToken: "tok-new",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T10 STEP_RETRY_REQUESTED: attemptBelowMax=false is rejected even with retryable=true", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "STEP_RETRY_REQUESTED",
      retryable: true,
      attemptBelowMax: false,
      newDispatchToken: "tok-new",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T11 DEPENDENCY_SKIP: dependencyUnmet=false is rejected", () => {
    const result = applyStepTransition(baseSnapshot("PENDING", "codebuild"), {
      kind: "DEPENDENCY_SKIP",
      dependencyUnmet: false,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T12 RECONCILE_TIMEOUT: deadlineExceeded=false is rejected (RUNNING)", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: false,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T12 RECONCILE_TIMEOUT: deadlineExceeded=false is rejected (DISPATCHING, non-redispatchable type)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "source"), {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: false,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T13 RECONCILE_REDISPATCH: deadlineExceeded=false is rejected", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "codebuild"), {
      kind: "RECONCILE_REDISPATCH",
      deadlineExceeded: false,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T13 RECONCILE_REDISPATCH: already has an externalRef is rejected (design: T13 only applies before externalRef was ever registered)", () => {
    const snapshot: StepSnapshot = {
      ...baseSnapshot("DISPATCHING", "codebuild"),
      externalRef: "build-already-registered",
    };
    const result = applyStepTransition(snapshot, { kind: "RECONCILE_REDISPATCH", deadlineExceeded: true });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });
});

// ---------------------------------------------------------------------------
// Review round 2, issue 3: T7/T8 must not accept failure codes that bypass
// §7.2 / the canonical rule / §7.7. Each of these is a dedicated rejection
// that the previous attempt's suite never exercised.
// ---------------------------------------------------------------------------

describe("T7/T8 reject failure codes that bypass §7.2 / the canonical rule (review round 2, issue 3)", () => {
  it("T8 (STEP_RESULT) rejects FAILED(TARGET_BUSY) from RUNNING ssh — TARGET_BUSY is never a terminal outcome, only T9", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "ssh"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "TARGET_BUSY",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T7 (DISPATCH_FAILED) rejects FAILED(TARGET_BUSY)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "codebuild"), {
      kind: "DISPATCH_FAILED",
      reason: "NON_RETRYABLE",
      failureCode: "TARGET_BUSY",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T8 rejects FAILED(LOCK_TIMEOUT) — LOCK_TIMEOUT is T5-only (canonical rule)", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "ssh"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "LOCK_TIMEOUT",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T7 rejects FAILED(LOCK_TIMEOUT)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "DISPATCH_FAILED",
      reason: "NON_RETRYABLE",
      failureCode: "LOCK_TIMEOUT",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T8 rejects FAILED(INVALID_TRANSITION) — the rejection code is never a step outcome", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "INVALID_TRANSITION",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T7 rejects FAILED(INVALID_TRANSITION)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "lambda"), {
      kind: "DISPATCH_FAILED",
      reason: "NON_RETRYABLE",
      failureCode: "INVALID_TRANSITION",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T7 rejects DISPATCH_FAILED{reason: NON_RETRYABLE, failureCode: DEPLOY_WINDOW_CLOSED} on lambda — the ssh-only guard must key off failureCode, not just reason", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "lambda"), {
      kind: "DISPATCH_FAILED",
      reason: "NON_RETRYABLE",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T7 rejects DISPATCH_FAILED{reason: RETRIES_EXHAUSTED, failureCode: DEPLOY_WINDOW_CLOSED} on codebuild (same bypass shape, different reason)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "codebuild"), {
      kind: "DISPATCH_FAILED",
      reason: "RETRIES_EXHAUSTED",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T8 rejects FAILED(DEPLOY_WINDOW_CLOSED) even for ssh — §7.7: a window closing mid-RUNNING does not abort the script, so DEPLOY_WINDOW_CLOSED can never be a T8 outcome", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "ssh"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("T8 rejects a FAILED outcome with no failureCode at all", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "codebuild"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      // failureCode intentionally omitted
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });
});

// ---------------------------------------------------------------------------
// Review round 3 remediation (rework attempt 3): the per-type ALLOWLISTS
// (T7_FAILURE_CODES / T8_FAILURE_CODES in index.ts) replace attempt 2's
// blocklist. Each test below is a falsifier named in the reviewer's report
// or the Leader's brief: deleting the corresponding allowlist entry (or the
// reason/code or matchesCurrentAttempt guard) must turn exactly that test
// red.
// ---------------------------------------------------------------------------

describe("review round 3, finding 1: T9 rejects a stale/redelivered code-50 (identity check)", () => {
  it("a redelivery of the ORIGINAL attempt's 50, arriving after T9->T3->T6 already moved the step to a NEW RUNNING attempt, is rejected", () => {
    // Reproduces the reviewer's exact scenario: attempt n gets 50 -> T9 ->
    // T3 -> T6, now RUNNING as attempt n+1. A redelivered attempt-n 50 must
    // NOT be accepted (it would otherwise send the live attempt back to
    // WAITING_LOCK).
    const liveLaterAttempt: StepSnapshot = {
      type: "ssh",
      state: "RUNNING",
      attempt: 2, // attempt n+1, already redispatched after the first 50
      dispatchToken: "tok-attempt-2",
      externalRef: "ssh-session-attempt-2",
      reconcileRedispatchCount: 0,
      lockWaitStartedAt: 5_000,
      contentionCount: 1,
    };
    const staleResult = applyStepTransition(liveLaterAttempt, {
      kind: "TARGET_BUSY",
      exitCode: 50,
      matchesCurrentAttempt: false, // this 50 belongs to attempt n, not the vigent attempt n+1
    });
    expect(staleResult).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
    // Contrast: the SAME exitCode, but matching the vigent attempt, is accepted.
    const liveResult = applyStepTransition(liveLaterAttempt, {
      kind: "TARGET_BUSY",
      exitCode: 50,
      matchesCurrentAttempt: true,
    });
    expect(liveResult.accepted).toBe(true);
  });
});

describe("review round 3, finding 2: T7/T8 per-type allowlists reject codes from the wrong transition/type", () => {
  it("falsifier: T7 rejects FAILED(SUPERSEDED) — SUPERSEDED is a T4-only outcome, never a dispatch failure", () => {
    for (const type of ["source", "lambda", "codebuild", "ssh"] as const) {
      const result = applyStepTransition(baseSnapshot("DISPATCHING", type), {
        kind: "DISPATCH_FAILED",
        reason: "NON_RETRYABLE",
        failureCode: "SUPERSEDED",
      });
      expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
    }
  });

  it("falsifier: T8 rejects FAILED(SUPERSEDED) too", () => {
    for (const type of STEP_TYPES) {
      const result = applyStepTransition(baseSnapshot("RUNNING", type), {
        kind: "STEP_RESULT",
        outcome: "FAILED",
        matchesCurrentAttempt: true,
        failureCode: "SUPERSEDED",
      });
      expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
    }
  });

  it("falsifier: T8 rejects FAILED(TIMED_OUT) — TIMED_OUT is only ever the `outcome`, never a FAILED outcome's failureCode (erasing the FAILED/TIMED_OUT distinction)", () => {
    for (const type of STEP_TYPES) {
      const result = applyStepTransition(baseSnapshot("RUNNING", type), {
        kind: "STEP_RESULT",
        outcome: "FAILED",
        matchesCurrentAttempt: true,
        failureCode: "TIMED_OUT",
      });
      expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
    }
  });

  it("falsifier: T7 rejects FAILED(TIMED_OUT) too", () => {
    for (const type of ["source", "lambda", "codebuild", "ssh"] as const) {
      const result = applyStepTransition(baseSnapshot("DISPATCHING", type), {
        kind: "DISPATCH_FAILED",
        reason: "NON_RETRYABLE",
        failureCode: "TIMED_OUT",
      });
      expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
    }
  });

  it("falsifier: T7 rejects MIGRATION (exit code 20's classification) on ssh — the script hasn't run yet in DISPATCHING, it only runs after T6 (design §7.3 'detalle de T9': 'En DISPATCHING no existe ningún código de salida')", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "DISPATCH_FAILED",
      reason: "NON_RETRYABLE",
      failureCode: "MIGRATION",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("falsifier: T7 rejects the OTHER deploy-script exit-code classifications on ssh too (PULL, START, HEALTH, UNKNOWN_TARGET_STATE) — all are T8-only, result-time codes", () => {
    for (const failureCode of ["PULL", "START", "HEALTH", "UNKNOWN_TARGET_STATE"] as const) {
      const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
        kind: "DISPATCH_FAILED",
        reason: "NON_RETRYABLE",
        failureCode,
      });
      expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
    }
  });

  it("falsifier: T8 rejects BUILD for lambda and QUALITY/INFRA for codebuild — codes don't cross between lambda and codebuild", () => {
    const buildOnLambda = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "BUILD",
    });
    expect(buildOnLambda).toEqual({ accepted: false, code: "INVALID_TRANSITION" });

    const qualityOnCodebuild = applyStepTransition(baseSnapshot("RUNNING", "codebuild"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "QUALITY",
    });
    expect(qualityOnCodebuild).toEqual({ accepted: false, code: "INVALID_TRANSITION" });

    const infraOnCodebuild = applyStepTransition(baseSnapshot("RUNNING", "codebuild"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "INFRA",
    });
    expect(infraOnCodebuild).toEqual({ accepted: false, code: "INVALID_TRANSITION" }); // T8 INFRA is lambda-only; codebuild's dispatch-time INFRA is T7-only
  });

  it("falsifier: T7 rejects source-only codes (SOURCE_CLONE/SOURCE_PREP/ARTIFACT_UPLOAD) for lambda/codebuild/ssh", () => {
    for (const type of ["lambda", "codebuild", "ssh"] as const) {
      for (const failureCode of ["SOURCE_CLONE", "SOURCE_PREP", "ARTIFACT_UPLOAD"] as const) {
        const result = applyStepTransition(baseSnapshot("DISPATCHING", type), {
          kind: "DISPATCH_FAILED",
          reason: "NON_RETRYABLE",
          failureCode,
        });
        expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
      }
    }
  });

  it("falsifier: notify has NO valid T7 failure code at all (FR-14: a notification failure never changes step state)", () => {
    for (const failureCode of [
      "INFRA",
      "QUALITY",
      "BUILD",
      "SOURCE_CLONE",
      "SOURCE_PREP",
      "ARTIFACT_UPLOAD",
      "SSH_CONNECT",
      "HOST_KEY_MISMATCH",
      "PULL",
      "MIGRATION",
      "START",
      "HEALTH",
      "UNKNOWN_TARGET_STATE",
    ] as const) {
      const result = applyStepTransition(baseSnapshot("DISPATCHING", "notify"), {
        kind: "DISPATCH_FAILED",
        reason: "NON_RETRYABLE",
        failureCode,
      });
      expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
    }
  });

  it("falsifier: notify has NO valid T8 FAILED failure code either", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "notify"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "INFRA",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("positive control: the allowlists DO accept each type's legitimate T7/T8 codes (so the tests above are proving exclusion, not a universally-broken guard)", () => {
    const t7Accepted = applyStepTransition(baseSnapshot("DISPATCHING", "source"), {
      kind: "DISPATCH_FAILED",
      reason: "NON_RETRYABLE",
      failureCode: "ARTIFACT_UPLOAD",
    });
    expect(t7Accepted.accepted).toBe(true);

    const t8Accepted = applyStepTransition(baseSnapshot("RUNNING", "ssh"), {
      kind: "STEP_RESULT",
      outcome: "FAILED",
      matchesCurrentAttempt: true,
      failureCode: "MIGRATION",
    });
    expect(t8Accepted.accepted).toBe(true);
  });
});

describe("review round 3, finding 3: T7 reason/failureCode agreement for DEPLOY_WINDOW_CLOSED (design §7.7 V4)", () => {
  it("falsifier (reviewer's exact example): {reason: DEPLOY_WINDOW_CLOSED, failureCode: INFRA} on lambda is rejected — reason alone must not smuggle a window-closed outcome past a non-window code", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "lambda"), {
      kind: "DISPATCH_FAILED",
      reason: "DEPLOY_WINDOW_CLOSED",
      failureCode: "INFRA",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("falsifier (reviewer's exact example): {reason: NON_RETRYABLE, failureCode: DEPLOY_WINDOW_CLOSED} on ssh is rejected — the code alone must not smuggle a window-closed outcome past a mismatched reason", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "DISPATCH_FAILED",
      reason: "NON_RETRYABLE",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("positive control: {reason: DEPLOY_WINDOW_CLOSED, failureCode: DEPLOY_WINDOW_CLOSED} on ssh IS accepted (both sides agree)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "DISPATCH_FAILED",
      reason: "DEPLOY_WINDOW_CLOSED",
      failureCode: "DEPLOY_WINDOW_CLOSED",
    });
    expect(result.accepted).toBe(true);
  });

  it("positive control: {reason: RETRIES_EXHAUSTED, failureCode: SSH_CONNECT} on ssh IS accepted (neither side claims DEPLOY_WINDOW_CLOSED)", () => {
    const result = applyStepTransition(baseSnapshot("DISPATCHING", "ssh"), {
      kind: "DISPATCH_FAILED",
      reason: "RETRIES_EXHAUSTED",
      failureCode: "SSH_CONNECT",
    });
    expect(result.accepted).toBe(true);
  });
});

describe("Leader correction: T12 (RECONCILE_TIMEOUT) from RUNNING is valid for lambda/source/notify, rejected only for ssh/codebuild (design §7.3 recovery table)", () => {
  // Correction to the previous round: the general T12 row applies to
  // "todos" whenever T13/adoption don't — only the TWO recovery-table rows
  // that explicitly name a different transition carve RUNNING out: RUNNING
  // codebuild (adopt via T8 / extend deadline) and RUNNING ssh (expired
  // lease -> T8 UNKNOWN_TARGET_STATE). lambda/source/notify fall under the
  // general rule and DO accept T12 from RUNNING.

  it("falsifier: T12 from RUNNING ssh is rejected — the recovery table sends an expired ssh lease to T8 FAILED(UNKNOWN_TARGET_STATE) instead", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "ssh"), {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: true,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("falsifier: T12 from RUNNING codebuild (which always carries an externalRef once RUNNING) is rejected — the recovery table adopts the real BatchGetBuilds result via T8, or extends the deadline; never generic T12", () => {
    const runningCodebuild = baseSnapshot("RUNNING", "codebuild");
    expect(runningCodebuild.externalRef).toBeDefined(); // confirms the premise: RUNNING always has an externalRef (set by T6)
    const result = applyStepTransition(runningCodebuild, {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: true,
    });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("positive control: T12 from RUNNING lambda IS accepted ('RUNNING lambda sin resultado' recovery-table row)", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "lambda"), {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: true,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T12");
    expect(result.next.state).toBe("TIMED_OUT");
  });

  it("positive control (Leader correction): T12 from RUNNING source IS accepted — no recovery-table row carves it out, so the general §7.3 T12 row ('todos') applies", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "source"), {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: true,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T12");
    expect(result.next.state).toBe("TIMED_OUT");
  });

  it("positive control (Leader correction): T12 from RUNNING notify IS accepted — same general-rule reasoning as source", () => {
    const result = applyStepTransition(baseSnapshot("RUNNING", "notify"), {
      kind: "RECONCILE_TIMEOUT",
      deadlineExceeded: true,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("T12");
    expect(result.next.state).toBe("TIMED_OUT");
  });

  it("DISPATCHING is unaffected by this RUNNING-only restriction: ssh/source/notify still close via T12 directly from DISPATCHING", () => {
    for (const type of ["ssh", "source", "notify"] as const) {
      const result = applyStepTransition(baseSnapshot("DISPATCHING", type), {
        kind: "RECONCILE_TIMEOUT",
        deadlineExceeded: true,
      });
      expect(result.accepted).toBe(true);
      if (result.accepted) expect(result.transitionId).toBe("T12");
    }
  });
});

// ---------------------------------------------------------------------------
// Review advisory: T3 must increment `attempt` consistently with T1 (both
// represent "a step is dispatched for the first time"); T9's own increment
// must not be double-counted on the next T3.
// ---------------------------------------------------------------------------

describe("T3 attempt-increment consistency with T1 (review advisory)", () => {
  it("first ssh dispatch (T2 then T3): attempt goes 0 -> 1, same as T1's first dispatch for non-ssh", () => {
    const afterT1 = applyStepTransition(baseSnapshot("PENDING", "lambda"), {
      kind: "DISPATCH",
      dependenciesSucceeded: true,
      newDispatchToken: "tok-1",
    });
    expect(afterT1.accepted && afterT1.next.attempt).toBe(1);

    // baseSnapshot's WAITING_LOCK default is attempt:1 (a generic convenience
    // default, not "first lock wait" specifically) — build the "never
    // dispatched yet" snapshot explicitly instead, per the field doc (T2
    // alone never touches attempt).
    const waitingLock: StepSnapshot = {
      type: "ssh",
      state: "WAITING_LOCK",
      attempt: 0,
      dispatchToken: undefined,
      externalRef: undefined,
      reconcileRedispatchCount: 0,
      lockWaitStartedAt: 500,
      contentionCount: 0,
    };
    const afterT3 = applyStepTransition(waitingLock, {
      kind: "ACQUIRE_LOCK",
      windowValid: true,
      lockAcquired: true,
      superseded: false,
      newDispatchToken: "tok-1",
    });
    expect(afterT3.accepted && afterT3.next.attempt).toBe(1);
  });

  it("T3 after a T9 bounce-back does NOT double-increment: T9 already bumped attempt once", () => {
    const running: StepSnapshot = { ...baseSnapshot("RUNNING", "ssh"), attempt: 1 };
    const busy = applyStepTransition(running, { kind: "TARGET_BUSY", exitCode: 50, matchesCurrentAttempt: true });
    expect(busy.accepted).toBe(true);
    if (!busy.accepted) return;
    expect(busy.next.attempt).toBe(2); // T9 incremented 1 -> 2

    const reacquired = applyStepTransition(busy.next, {
      kind: "ACQUIRE_LOCK",
      windowValid: true,
      lockAcquired: true,
      superseded: false,
      newDispatchToken: "tok-after-bounce",
    });
    expect(reacquired.accepted).toBe(true);
    if (!reacquired.accepted) return;
    expect(reacquired.next.attempt).toBe(2); // unchanged by T3, NOT 3
  });
});

// ---------------------------------------------------------------------------
// classifyDeployExitCode: exit 0 returns a result, it does not throw
// (review advisory). Behavior for known/unknown non-zero codes is unchanged.
// ---------------------------------------------------------------------------

describe("classifyDeployExitCode (review advisory: no throw on exit 0)", () => {
  it("exit 0 returns undefined (success, no failure code) instead of throwing", () => {
    expect(() => classifyDeployExitCode(0)).not.toThrow();
    expect(classifyDeployExitCode(0)).toBeUndefined();
  });

  it("an unmapped non-zero exit code still falls back to UNKNOWN_TARGET_STATE", () => {
    expect(classifyDeployExitCode(999)).toBe("UNKNOWN_TARGET_STATE");
  });
});

// ---------------------------------------------------------------------------
// Execution-level state machine (requirements FR-05's "Ejecución" row;
// proposal §10.6's closed chain). Review round 2, issue 1.
// ---------------------------------------------------------------------------

type ExecutionEventKind = ExecutionTransitionRequest["kind"];
const ALL_EXECUTION_KINDS: readonly ExecutionEventKind[] = ["START", "FINALIZE"];
const EXECUTION_OUTCOMES: readonly ExecutionOutcome[] = ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"];

function goodExecutionEvent(kind: ExecutionEventKind): ExecutionTransitionRequest {
  return kind === "START" ? { kind: "START" } : { kind: "FINALIZE", outcome: "SUCCEEDED" };
}

describe("execution state machine — exhaustive cartesian product (fromState × event kind)", () => {
  // Transcribed independently from proposal §10.6 / FR-05's table — not
  // derived from index.ts, so it cannot be tautologically satisfied.
  const EXECUTION_PERMITTED = new Map<string, { to: ExecutionState }>([
    ["QUEUED::START", { to: "RUNNING" }],
    ["RUNNING::FINALIZE", { to: "SUCCEEDED" }], // outcome varies; see dedicated FINALIZE test below
  ]);

  for (const state of EXECUTION_STATES) {
    for (const kind of ALL_EXECUTION_KINDS) {
      const permitted = EXECUTION_PERMITTED.get(`${state}::${kind}`);
      const label = `${state} + ${kind} → ${permitted ? `accepted (to ${permitted.to})` : "rejected (INVALID_TRANSITION)"}`;

      it(label, () => {
        const snapshot: ExecutionSnapshot = { state };
        const result = applyExecutionTransition(snapshot, goodExecutionEvent(kind));
        if (permitted) {
          expect(result.accepted).toBe(true);
          if (result.accepted) expect(result.next.state).toBe(permitted.to);
        } else {
          expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
        }
      });
    }
  }

  it("FINALIZE from RUNNING accepts each of the four closed outcomes", () => {
    for (const outcome of EXECUTION_OUTCOMES) {
      const result = applyExecutionTransition({ state: "RUNNING" }, { kind: "FINALIZE", outcome });
      expect(result.accepted).toBe(true);
      if (result.accepted) expect(result.next.state).toBe(outcome);
    }
  });
});

describe("execution terminal states are immutable (FR-05: estados terminales inmutables)", () => {
  for (const state of EXECUTION_STATES) {
    if (!TERMINAL_EXECUTION_STATES.has(state)) continue;
    it(`no event kind moves an execution out of ${state}`, () => {
      for (const kind of ALL_EXECUTION_KINDS) {
        const result = applyExecutionTransition({ state }, goodExecutionEvent(kind));
        expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
      }
      // Falsifier-shaped: every one of the four terminals, against both
      // event kinds and all four FINALIZE outcomes, must stay rejected.
      for (const outcome of EXECUTION_OUTCOMES) {
        const result = applyExecutionTransition({ state }, { kind: "FINALIZE", outcome });
        expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
      }
    });
  }

  it("QUEUED cannot FINALIZE directly (only RUNNING can) — proves the guard isn't vacuous", () => {
    const result = applyExecutionTransition({ state: "QUEUED" }, { kind: "FINALIZE", outcome: "CANCELLED" });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("RUNNING cannot START again (already started) — proves the guard isn't vacuous", () => {
    const result = applyExecutionTransition({ state: "RUNNING" }, { kind: "START" });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });
});

describe("FR-05 execution scenarios mapped to the execution machine", () => {
  it("Scenario: transición válida (execution) — QUEUED -> RUNNING on START", () => {
    const result = applyExecutionTransition({ state: "QUEUED" }, { kind: "START" });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.transitionId).toBe("E1");
    expect(result.next.state).toBe("RUNNING");
  });

  it("Scenario: transición inválida (execution) — a terminal execution ignores any incoming event (no-op)", () => {
    const result = applyExecutionTransition({ state: "CANCELLED" }, { kind: "FINALIZE", outcome: "FAILED" });
    expect(result).toEqual({ accepted: false, code: "INVALID_TRANSITION" });
  });

  it("Scenario: terminales inmutables (execution) — all four terminals accept nothing further, proven per-state above", () => {
    expect([...TERMINAL_EXECUTION_STATES].sort()).toEqual(["CANCELLED", "FAILED", "SUCCEEDED", "TIMED_OUT"].sort());
  });
});
