// @akili-spec changes/cicd-executor-poc design §7.3
// Closed list of valid step transitions (T1–T13) with their guards. Pure,
// no I/O: no Date.now(), no randomness, no port calls. Every timestamp or
// freshly generated id (dispatchToken) a transition needs is supplied by the
// caller as part of the request — the application layer owns Clock/id
// generation (design §3.2's "domain is pure" boundary).
//
// Regla general (design §7.3): SOLO son válidas las transiciones de la tabla
// de abajo. Cada una se aplica, en la vida real, con una escritura
// condicional sobre el estado de origen, el `attempt` y la `version`
// vigentes (DD-03) — esa parte vive en el adaptador StateStore, no aquí.
// Una transición pedida que no figura aquí se rechaza como
// `INVALID_TRANSITION`, sin efectos. Los estados terminales
// (SUCCEEDED, FAILED, TIMED_OUT, SKIPPED) son inmutables.
import type { DomainErrorCode } from "../errors/index.js";

export const STEP_TYPES = ["source", "lambda", "codebuild", "notify", "ssh"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_STATES = [
  "PENDING",
  "WAITING_LOCK",
  "DISPATCHING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "SKIPPED",
] as const;
export type StepState = (typeof STEP_STATES)[number];

export const TERMINAL_STEP_STATES: ReadonlySet<StepState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "SKIPPED",
]);

export const TRANSITION_IDS = [
  "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13",
] as const;
export type TransitionId = (typeof TRANSITION_IDS)[number];

/** Persisted step fields the state machine reads and mutates (design §5.1's Step item, domain-relevant subset). */
export interface StepSnapshot {
  readonly type: StepType;
  readonly state: StepState;
  /** 0 while never dispatched (PENDING/WAITING_LOCK before the first real attempt). */
  readonly attempt: number;
  readonly dispatchToken?: string;
  readonly externalRef?: string;
  /** T13 guard/counter (design §7.3): at most one idempotent re-dispatch per step. */
  readonly reconcileRedispatchCount: number;
  /** Set by T2, carried unchanged across T9 (design "detalle de T9": "mismo lockWaitStartedAt"). */
  readonly lockWaitStartedAt?: number;
  // NOTE on `deadlineAt` (design §5.1's Step item): this pure state machine
  // does not read or set it. Computing/renewing deadlines (T2's lock-wait
  // budget clock, T12/T13's reconciler deadline) is an application-layer
  // concern (Clock port) owned by the dispatcher/reconciler tasks (T-08,
  // T-11), not by this module — deadlineExceeded/now are supplied to us
  // pre-computed by the caller, per this file's top-of-file boundary note.
  /** Incremented by T9 only (contention via exit code 50). */
  readonly contentionCount: number;
  /** Set only on a terminal/SKIPPED outcome (T4, T5, T7, T8, T12); otherwise carried as-is. */
  readonly resultCode?: DomainErrorCode;
}

// ---------------------------------------------------------------------------
// Transition requests (one discriminated-union member per trigger named in
// design §7.3; several map to the same T-id only when the id itself already
// disambiguates by fromState, e.g. T10 from RUNNING or DISPATCHING).
// ---------------------------------------------------------------------------

export type StepTransitionRequest =
  /** T1: Planner dispatch for non-ssh types. */
  | { readonly kind: "DISPATCH"; readonly dependenciesSucceeded: boolean; readonly newDispatchToken: string }
  /** T2: Planner enters lock-wait for ssh. */
  | { readonly kind: "ENTER_LOCK_WAIT"; readonly dependenciesSucceeded: boolean; readonly now: number }
  /** T3: lock acquisition succeeds (V1/V2 window check already passed by the caller). */
  | {
      readonly kind: "ACQUIRE_LOCK";
      readonly windowValid: boolean;
      readonly lockAcquired: boolean;
      readonly superseded: boolean;
      readonly newDispatchToken: string;
    }
  /** T4: supersede while waiting for the lock. */
  | { readonly kind: "SUPERSEDE"; readonly superseded: boolean }
  /** T5: WAITING_LOCK gives up — canonically LOCK_TIMEOUT, or DEPLOY_WINDOW_CLOSED (V1/V2/V3). */
  | { readonly kind: "LOCK_WAIT_FAILED"; readonly failureCode: "LOCK_TIMEOUT" | "DEPLOY_WINDOW_CLOSED" }
  /** T6: externalRef registered just before the dispatch is considered live (ssh: after V4, before exec). */
  | { readonly kind: "EXTERNAL_REF_REGISTERED"; readonly externalRef: string }
  /** T7: dispatch fails outright. */
  | {
      readonly kind: "DISPATCH_FAILED";
      readonly reason: "NON_RETRYABLE" | "RETRIES_EXHAUSTED" | "DEPLOY_WINDOW_CLOSED";
      readonly failureCode: DomainErrorCode;
    }
  /** T8: the vigent attempt's result arrives. */
  | {
      readonly kind: "STEP_RESULT";
      readonly outcome: "SUCCEEDED" | "FAILED" | "TIMED_OUT";
      readonly matchesCurrentAttempt: boolean;
      readonly failureCode?: DomainErrorCode;
    }
  /**
   * T9: the ONLY backward transition — deploy script exit code 50, ssh only,
   * from RUNNING only, and only for the VIGENT attempt (design §7.3 "detalle
   * de T9": "idempotencia" row — a redelivery of the original 50 must find
   * the step already moved on and do nothing). `matchesCurrentAttempt` is
   * the caller's identity check (externalRef/attempt of the inbound result
   * vs. the snapshot) — without it a stale 50 from a superseded attempt
   * could bounce a LIVE later attempt back to WAITING_LOCK (review round 3,
   * finding 1).
   */
  | { readonly kind: "TARGET_BUSY"; readonly exitCode: number; readonly matchesCurrentAttempt: boolean }
  /** T10: STEP_RETRY_REQUESTED — never ssh. */
  | {
      readonly kind: "STEP_RETRY_REQUESTED";
      readonly retryable: boolean;
      readonly attemptBelowMax: boolean;
      readonly newDispatchToken: string;
    }
  /** T11: dependency failed/timed-out/skipped, or `when` false. */
  | { readonly kind: "DEPENDENCY_SKIP"; readonly dependencyUnmet: boolean }
  /** T12: reconciler deadline, generic timeout — never applies to WAITING_LOCK (canonical rule). */
  | { readonly kind: "RECONCILE_TIMEOUT"; readonly deadlineExceeded: boolean }
  /** T13: reconciler idempotent re-dispatch — codebuild/lambda only, same attempt, same token, once. */
  | { readonly kind: "RECONCILE_REDISPATCH"; readonly deadlineExceeded: boolean };

export type StepTransitionResult =
  | { readonly accepted: true; readonly transitionId: TransitionId; readonly next: StepSnapshot }
  | { readonly accepted: false; readonly code: "INVALID_TRANSITION" };

function rejected(): StepTransitionResult {
  return { accepted: false, code: "INVALID_TRANSITION" };
}

function accepted(transitionId: TransitionId, next: StepSnapshot): StepTransitionResult {
  return { accepted: true, transitionId, next };
}

const NON_SSH_DISPATCH_TYPES: ReadonlySet<StepType> = new Set(["source", "lambda", "codebuild", "notify"]);
const RETRYABLE_STEP_TYPES: ReadonlySet<StepType> = new Set(["source", "lambda", "codebuild"]);
const RECONCILE_REDISPATCH_TYPES: ReadonlySet<StepType> = new Set(["codebuild", "lambda"]);

// ---------------------------------------------------------------------------
// T7 (DISPATCH_FAILED) and T8 (STEP_RESULT outcome FAILED) failure-code
// ALLOWLISTS, one per step type, transcribed directly from design §7.2's
// failure-mapping table — never a blocklist (review round 3, finding 2: a
// blocklist only excludes the codes someone thought to name, which is how
// attempt 2 let SUPERSEDED/TIMED_OUT/exit-code-on-DISPATCHING slip through).
// A code not listed for a (transition, type) pair is REJECTED, full stop.
//
// T7 = dispatch-time failures (before the attempt is ever RUNNING):
//   - source:    "Clone"/"ZIP"/"Subida" (§7.2 rows 1-3) can all fail before
//                the handler's work starts.
//   - lambda:    invoke-level INFRA (the lambda-invoke equivalent of
//                codebuild's "StartBuild rechazado (API)" row).
//   - codebuild: "StartBuild rechazado (API)" -> INFRA (§7.2 row 6).
//   - ssh:       "Conexión SSH o host key" -> SSH_CONNECT/HOST_KEY_MISMATCH
//                (§7.2 row 9, "antes de ejecutar" = still DISPATCHING), plus
//                DEPLOY_WINDOW_CLOSED at V4 (§7.7, ssh-only).
//   - notify:    NONE. FR-14 "fallo del proveedor": a notification failure
//                is logged and "IT MUST NOT cambiar el estado de la
//                ejecución" — notify never reports a step-level FAILED.
//
// T8 = result-time failures (the vigent attempt's outcome arrives RUNNING):
//   - source:    same three codes — the clone/zip/upload can also fail once
//                the handler has already started running.
//   - lambda:    "status de fallo" -> QUALITY, "error de función" -> INFRA
//                (§7.2 rows 4-5, both arrive via the async Destination result).
//   - codebuild: "Build FAILED/STOPPED" -> BUILD (§7.2 row 7). INFRA is
//                NOT a codebuild T8 code — only StartBuild rejection (T7).
//   - ssh:       deploy-script exit codes 10/20/30/40/otro -> PULL/
//                MIGRATION/START/HEALTH/UNKNOWN_TARGET_STATE (§7.2 row 10) —
//                the script only runs after T6, so these can ONLY be T8.
//   - notify:    NONE (same FR-14 reasoning as T7).
//
// Deliberately absent from BOTH lists, for every type (so rejected
// unconditionally): TARGET_BUSY (exit 50 is never itself a terminal outcome
// — it always routes back via T9), LOCK_TIMEOUT (T5-only, §7.3's regla
// canónica), SUPERSEDED (T4-only, ssh WAITING_LOCK supersede), the
// TIMED_OUT *code* (TIMED_OUT is only ever produced as T8/T12's `outcome`,
// never as a FAILED outcome's failureCode — conflating the two would erase
// the FAILED/TIMED_OUT distinction FR-16 depends on), and INVALID_TRANSITION
// (the state machine's own rejection code).
const T7_FAILURE_CODES: Readonly<Record<StepType, ReadonlySet<DomainErrorCode>>> = {
  source: new Set(["SOURCE_CLONE", "SOURCE_PREP", "ARTIFACT_UPLOAD"]),
  lambda: new Set(["INFRA"]),
  codebuild: new Set(["INFRA"]),
  ssh: new Set(["SSH_CONNECT", "HOST_KEY_MISMATCH", "DEPLOY_WINDOW_CLOSED"]),
  notify: new Set(),
};

const T8_FAILURE_CODES: Readonly<Record<StepType, ReadonlySet<DomainErrorCode>>> = {
  source: new Set(["SOURCE_CLONE", "SOURCE_PREP", "ARTIFACT_UPLOAD"]),
  lambda: new Set(["QUALITY", "INFRA"]),
  codebuild: new Set(["BUILD"]),
  ssh: new Set(["PULL", "MIGRATION", "START", "HEALTH", "UNKNOWN_TARGET_STATE"]),
  notify: new Set(),
};

/**
 * Applies one step transition request against a snapshot. Returns the
 * accepted next snapshot (with the T-id applied) or a rejection — never
 * throws, never mutates `current`. The caller (step-dispatcher/reconciler)
 * is responsible for turning an acceptance into the actual conditional
 * DynamoDB write (DD-03); this function only decides what SHOULD happen.
 *
 * Falsifier (must stay red if ever "fixed" to pass): RUNNING→WAITING_LOCK
 * for an `ssh` step with exitCode 40 must be rejected — only exitCode 50
 * (TARGET_BUSY) may take T9. See state-machine.test.ts's dedicated case.
 */
export function applyStepTransition(
  current: StepSnapshot,
  request: StepTransitionRequest,
): StepTransitionResult {
  // Terminal states are immutable — no request of any kind may move them.
  if (TERMINAL_STEP_STATES.has(current.state)) {
    return rejected();
  }

  switch (request.kind) {
    case "DISPATCH": {
      // T1: PENDING -> DISPATCHING, source/lambda/codebuild/notify only.
      if (current.state !== "PENDING") return rejected();
      if (!NON_SSH_DISPATCH_TYPES.has(current.type)) return rejected();
      if (!request.dependenciesSucceeded) return rejected();
      return accepted("T1", {
        ...current,
        state: "DISPATCHING",
        attempt: current.attempt + 1,
        dispatchToken: request.newDispatchToken,
        externalRef: undefined,
      });
    }

    case "ENTER_LOCK_WAIT": {
      // T2: PENDING -> WAITING_LOCK, ssh only.
      if (current.state !== "PENDING") return rejected();
      if (current.type !== "ssh") return rejected();
      if (!request.dependenciesSucceeded) return rejected();
      return accepted("T2", {
        ...current,
        state: "WAITING_LOCK",
        lockWaitStartedAt: request.now,
      });
    }

    case "ACQUIRE_LOCK": {
      // T3: WAITING_LOCK -> DISPATCHING, ssh only.
      if (current.state !== "WAITING_LOCK") return rejected();
      if (current.type !== "ssh") return rejected();
      if (request.superseded) return rejected(); // supersede takes T4, not T3
      if (!request.windowValid || !request.lockAcquired) return rejected();
      return accepted("T3", {
        ...current,
        state: "DISPATCHING",
        // attempt: consistent with T1's "0 while never dispatched" (field
        // doc) — the FIRST time a step is dispatched (T1 or T3) attempt goes
        // 0 -> 1. A later T3 (after bouncing back via T9) finds attempt
        // already >= 1 because T9 itself incremented it (design "detalle de
        // T9": "se incrementan attempt y contentionCount") — so T3 must NOT
        // increment a second time, only carry it forward.
        attempt: current.attempt === 0 ? 1 : current.attempt,
        dispatchToken: request.newDispatchToken,
        externalRef: undefined,
      });
    }

    case "SUPERSEDE": {
      // T4: WAITING_LOCK -> SKIPPED, ssh only.
      if (current.state !== "WAITING_LOCK") return rejected();
      if (current.type !== "ssh") return rejected();
      if (!request.superseded) return rejected();
      return accepted("T4", {
        ...current,
        state: "SKIPPED",
        resultCode: "SUPERSEDED",
      });
    }

    case "LOCK_WAIT_FAILED": {
      // T5: WAITING_LOCK -> FAILED, ssh only. Canonical: LOCK_TIMEOUT or
      // DEPLOY_WINDOW_CLOSED — the type system already excludes any other
      // code (in particular TIMED_OUT is unreachable from here).
      if (current.state !== "WAITING_LOCK") return rejected();
      if (current.type !== "ssh") return rejected();
      return accepted("T5", {
        ...current,
        state: "FAILED",
        resultCode: request.failureCode,
      });
    }

    case "EXTERNAL_REF_REGISTERED": {
      // T6: DISPATCHING -> RUNNING, all types. For `ssh` the design places
      // this call "justo antes del exec, tras V4" (§7.3) — the V4 window
      // revalidation itself is a live check (isDeployAllowed, a port call)
      // that this pure domain function does not and cannot perform (no I/O,
      // DD-15/§3.2). The caller (handlers/ssh, T-11/T-13) is responsible for
      // running V4 first and choosing EXTERNAL_REF_REGISTERED (valid window)
      // vs DISPATCH_FAILED{reason: DEPLOY_WINDOW_CLOSED} (invalid window)
      // before ever calling into this function.
      if (current.state !== "DISPATCHING") return rejected();
      if (request.externalRef.length === 0) return rejected();
      return accepted("T6", {
        ...current,
        state: "RUNNING",
        externalRef: request.externalRef,
      });
    }

    case "DISPATCH_FAILED": {
      // T7: DISPATCHING -> FAILED. The failure code must be one of this
      // type's dispatch-time codes (T7_FAILURE_CODES allowlist, derived
      // from §7.2 — review round 3, finding 2: this used to be a blocklist
      // and let SUPERSEDED/TIMED_OUT/exit-code-on-DISPATCHING through).
      if (current.state !== "DISPATCHING") return rejected();
      if (!T7_FAILURE_CODES[current.type].has(request.failureCode)) return rejected();
      // reason/code agreement (review round 3, finding 3; design §7.7 V4):
      // `reason` must say DEPLOY_WINDOW_CLOSED exactly when `failureCode`
      // does, and vice versa — a caller cannot report one without the
      // other. Without this check {reason: NON_RETRYABLE, failureCode:
      // DEPLOY_WINDOW_CLOSED} and {reason: DEPLOY_WINDOW_CLOSED, failureCode:
      // INFRA} both slipped through attempt 2, bypassing T7's three named
      // triggers ("Error de despacho no reintentable, o reintentos
      // agotados, o DEPLOY_WINDOW_CLOSED en V4").
      const isWindowClosedCode = request.failureCode === "DEPLOY_WINDOW_CLOSED";
      const isWindowClosedReason = request.reason === "DEPLOY_WINDOW_CLOSED";
      if (isWindowClosedCode !== isWindowClosedReason) return rejected();
      return accepted("T7", {
        ...current,
        state: "FAILED",
        resultCode: request.failureCode,
      });
    }

    case "STEP_RESULT": {
      // T8: RUNNING -> SUCCEEDED/FAILED/TIMED_OUT, all types. A result that
      // does not match the vigent attempt (orphan, §6.1) is rejected here —
      // the caller logs it as ORPHAN_EVENT, it never reaches the state.
      if (current.state !== "RUNNING") return rejected();
      if (!request.matchesCurrentAttempt) return rejected();
      if (request.outcome === "FAILED") {
        // A FAILED outcome MUST carry a failure code (it's how FR-16's rows
        // are told apart later), and that code must be one of this type's
        // result-time codes (T8_FAILURE_CODES allowlist, derived from §7.2
        // — review round 3, finding 2). This allowlist has no
        // DEPLOY_WINDOW_CLOSED entry for ANY type: §7.7 says a window
        // closing mid-run does NOT abort the script, so it can never be the
        // reason a RUNNING step reports FAILED (only T5/T7 report it).
        if (request.failureCode === undefined) return rejected();
        if (!T8_FAILURE_CODES[current.type].has(request.failureCode)) return rejected();
      }
      const resultCode: DomainErrorCode | undefined =
        request.outcome === "TIMED_OUT"
          ? "TIMED_OUT"
          : request.outcome === "FAILED"
            ? request.failureCode
            : undefined;
      return accepted("T8", {
        ...current,
        state: request.outcome,
        resultCode,
      });
    }

    case "TARGET_BUSY": {
      // T9: the ONLY backward transition. RUNNING -> WAITING_LOCK, ssh only,
      // only on exit code 50. DISPATCHING can never receive a 50 (design
      // "detalle de T9": the exit code only exists after exec, which starts
      // after T6) — rejected here because current.state !== "RUNNING".
      if (current.state !== "RUNNING") return rejected();
      if (current.type !== "ssh") return rejected();
      // Identity check (review round 3, finding 1; design §7.3 "detalle de
      // T9" idempotency row): a redelivered/stale 50 from an attempt that is
      // no longer vigent must be rejected, exactly like T8's
      // matchesCurrentAttempt. Without this, a stale 50 could bounce a
      // LIVE later attempt back to WAITING_LOCK.
      if (!request.matchesCurrentAttempt) return rejected();
      if (request.exitCode !== 50) return rejected();
      return accepted("T9", {
        ...current,
        state: "WAITING_LOCK",
        attempt: current.attempt + 1,
        contentionCount: current.contentionCount + 1,
        dispatchToken: undefined,
        externalRef: undefined,
        // lockWaitStartedAt and the accumulated budget are preserved untouched.
      });
    }

    case "STEP_RETRY_REQUESTED": {
      // T10: RUNNING or DISPATCHING -> DISPATCHING, same step, attempt + 1.
      // Never ssh (ssh has no retry path other than T9/T12).
      if (current.state !== "RUNNING" && current.state !== "DISPATCHING") return rejected();
      if (!RETRYABLE_STEP_TYPES.has(current.type)) return rejected();
      if (!request.retryable || !request.attemptBelowMax) return rejected();
      return accepted("T10", {
        ...current,
        state: "DISPATCHING",
        attempt: current.attempt + 1,
        dispatchToken: request.newDispatchToken,
        externalRef: undefined,
      });
    }

    case "DEPENDENCY_SKIP": {
      // T11: PENDING -> SKIPPED, all types.
      if (current.state !== "PENDING") return rejected();
      if (!request.dependencyUnmet) return rejected();
      return accepted("T11", {
        ...current,
        state: "SKIPPED",
      });
    }

    case "RECONCILE_TIMEOUT": {
      // T12: DISPATCHING/RUNNING -> TIMED_OUT. Never WAITING_LOCK (canonical
      // rule, design §7.3: that budget exhaustion is T5/LOCK_TIMEOUT, never
      // T12/TIMED_OUT) — WAITING_LOCK is already excluded because it is not
      // in the fromState check below.
      if (current.state !== "DISPATCHING" && current.state !== "RUNNING") return rejected();
      if (!request.deadlineExceeded) return rejected();
      // RUNNING redirect guard (design §7.3 "Recuperación de resultados
      // perdidos por el reconciler" table; review round 3 advisory; Leader
      // correction — the general T12 row applies to "todos" whenever
      // T13/adoption don't: only TWO RUNNING cases are carved out by the
      // recovery table, and only those two are excluded here:
      //   - RUNNING codebuild (always has an externalRef once RUNNING, see
      //     T6's guard): BatchGetBuilds adopts the real result (T8) or the
      //     deadline is extended — never generic T12.
      //   - RUNNING ssh with an expired lease: closes with
      //     UNKNOWN_TARGET_STATE via T8, never T12 (runbook §12.1).
      // RUNNING lambda, source and notify have no such carve-out row, so
      // the general "todos" rule applies and T12 IS valid for them
      // ("RUNNING lambda sin resultado" -> T12 is the recovery table's own
      // explicit example; source/notify fall under the same general rule).
      if (current.state === "RUNNING" && (current.type === "ssh" || current.type === "codebuild")) {
        return rejected();
      }
      // DISPATCHING redirect guard (design §7.3 recovery table): a
      // DISPATCHING codebuild/lambda step without externalRef, on its FIRST
      // timeout, must take T13 instead — T12 only applies once T13 no
      // longer can (reconcileRedispatchCount already consumed, or any other
      // shape, e.g. ssh/source/notify which go straight to T12).
      if (
        current.state === "DISPATCHING" &&
        RECONCILE_REDISPATCH_TYPES.has(current.type) &&
        current.externalRef === undefined &&
        current.reconcileRedispatchCount === 0
      ) {
        return rejected();
      }
      return accepted("T12", {
        ...current,
        state: "TIMED_OUT",
        resultCode: "TIMED_OUT",
      });
    }

    case "RECONCILE_REDISPATCH": {
      // T13: DISPATCHING (no externalRef) -> DISPATCHING, SAME attempt, SAME
      // dispatchToken. codebuild/lambda only; once (reconcileRedispatchCount
      // must be 0). Never ssh, never source (design §7.3).
      if (current.state !== "DISPATCHING") return rejected();
      if (!RECONCILE_REDISPATCH_TYPES.has(current.type)) return rejected();
      if (current.externalRef !== undefined) return rejected();
      if (current.reconcileRedispatchCount !== 0) return rejected();
      if (!request.deadlineExceeded) return rejected();
      return accepted("T13", {
        ...current,
        state: "DISPATCHING",
        reconcileRedispatchCount: current.reconcileRedispatchCount + 1,
        // attempt and dispatchToken are intentionally left untouched.
      });
    }

    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Execution-level state machine (requirements FR-05's "Ejecución" row;
// proposal §10.6's chain: "QUEUED → RUNNING → SUCCEEDED | FAILED | TIMED_OUT
// | CANCELLED (terminales inmutables)").
//
// This is a SEPARATE closed list from the step machine above (T1–T13 governs
// steps only). Design §7.3 does not number or detail execution-level
// transitions the way it does for steps — the only source-of-truth is the
// chain quoted above plus FR-05's state/terminal table. Per the Leader's
// explicit guidance for this task: implement EXACTLY that closed chain and
// nothing more. In particular:
//   - QUEUED -> RUNNING is the only way out of QUEUED (no QUEUED -> CANCELLED
//     short-circuit, no QUEUED -> FAILED/TIMED_OUT: the chain doesn't list
//     them, and inventing one would mean inventing a guard design never
//     specified). If a direct-from-QUEUED cancellation/failure turns out to
//     be needed, that is a SPEC GAP to raise, not something to add here.
//   - RUNNING is the only state from which any of the four terminals is
//     reached (mirrors T8's "one transition id, several outcomes" shape).
//   - WHICH of the four terminal outcomes applies for a given RUNNING
//     execution (e.g. "all steps SUCCEEDED" vs "a step FAILED and its
//     dependents were SKIPPED", FR-06) is a planner/reconciler decision —
//     this function only enforces that the request's chosen outcome is one
//     of the closed four and that it's reachable only from RUNNING; it does
//     not re-derive the outcome from step states (that cross-aggregate
//     rollup belongs to the planner task, not this pure, single-aggregate
//     state machine).
// ---------------------------------------------------------------------------

export const EXECUTION_STATES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const TERMINAL_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
]);

export const EXECUTION_TRANSITION_IDS = ["E1", "E2"] as const;
export type ExecutionTransitionId = (typeof EXECUTION_TRANSITION_IDS)[number];

/** Execution-terminal outcome, the four non-QUEUED/RUNNING states of FR-05's table. */
export type ExecutionOutcome = Exclude<ExecutionState, "QUEUED" | "RUNNING">;

/** Persisted execution fields the state machine reads and mutates (design §5.1's Ejecución item, domain-relevant subset). */
export interface ExecutionSnapshot {
  readonly state: ExecutionState;
}

export type ExecutionTransitionRequest =
  /** E1: QUEUED -> RUNNING. */
  | { readonly kind: "START" }
  /** E2: RUNNING -> one of the four closed terminals. */
  | { readonly kind: "FINALIZE"; readonly outcome: ExecutionOutcome };

export type ExecutionTransitionResult =
  | { readonly accepted: true; readonly transitionId: ExecutionTransitionId; readonly next: ExecutionSnapshot }
  | { readonly accepted: false; readonly code: "INVALID_TRANSITION" };

function executionRejected(): ExecutionTransitionResult {
  return { accepted: false, code: "INVALID_TRANSITION" };
}

/**
 * Applies one execution-level transition request. Same contract as
 * applyStepTransition: pure, never throws, never mutates `current`. Terminal
 * execution states (SUCCEEDED, FAILED, TIMED_OUT, CANCELLED) are immutable —
 * any request against one of them is rejected as INVALID_TRANSITION.
 */
export function applyExecutionTransition(
  current: ExecutionSnapshot,
  request: ExecutionTransitionRequest,
): ExecutionTransitionResult {
  if (TERMINAL_EXECUTION_STATES.has(current.state)) {
    return executionRejected();
  }

  switch (request.kind) {
    case "START": {
      // E1: QUEUED -> RUNNING. The only non-terminal state besides RUNNING
      // itself is QUEUED, so this is the full guard.
      if (current.state !== "QUEUED") return executionRejected();
      return { accepted: true, transitionId: "E1", next: { state: "RUNNING" } };
    }

    case "FINALIZE": {
      // E2: RUNNING -> {SUCCEEDED, FAILED, TIMED_OUT, CANCELLED}.
      if (current.state !== "RUNNING") return executionRejected();
      return { accepted: true, transitionId: "E2", next: { state: request.outcome } };
    }

    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}
