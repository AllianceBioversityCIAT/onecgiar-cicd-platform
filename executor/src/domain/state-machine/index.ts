// @akili-spec changes/cicd-executor-poc design §7.3, DD-04, DD-28; requirements FR-05, FR-16, RL-4, RL-7
// Closed execution-level state machine X1-X16. Pure: no I/O, no Date.now(),
// no randomness. Timestamps, tokens and validation outcomes (V1-V4, S1/S2,
// dedupe claim, sender authorization) are facts supplied by the caller; the
// conditional write itself (status + version, TransactWriteItems) belongs to
// the StateStore adapter (N-08) and the coordinators (N-10, N-12).
//
// General rule (design §7.3): ONLY the transitions below are valid. Terminal
// states are immutable. Anything else is rejected as INVALID_TRANSITION with
// no effect. X14 (DEPLOYING -> WAITING_LOCK, exit 50) is the only backward
// edge. There is NO `RECEIVED` state: X1/X2 are creations (CW-3).
import { classifyExitCode, type FailureCode, type RejectReason } from "../errors/index.js";

export const EXECUTION_STATUSES = [
  "QUEUED",
  "WAITING_LOCK",
  "DEPLOYING",
  "SUCCEEDED",
  "FAILED",
  "SUPERSEDED",
  "REJECTED",
  "UNKNOWN_TARGET_STATE",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "SUPERSEDED",
  "REJECTED",
  "UNKNOWN_TARGET_STATE",
]);

export const TRANSITION_IDS = [
  "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8",
  "X9", "X10", "X11", "X12", "X13", "X14", "X15", "X16",
] as const;
export type TransitionId = (typeof TRANSITION_IDS)[number];

/** Lock-wait budget (design §7.6): 1,800 s. */
export const LOCK_WAIT_BUDGET_MS = 1_800_000;
/** Lock-wait safety cap (design §7.6): 10 lock attempts in total also end the wait with LOCK_TIMEOUT. */
export const MAX_LOCK_WAIT_ATTEMPTS = 10;

/** Fields X9 and X14 clear so a new attempt never inherits the previous one (CW-1). */
export const PER_ATTEMPT_FIELDS = [
  "execStartedAt",
  "result",
  "error",
  "lockLostDuringRun",
  "targetWriteRejected",
  "windowClosedDuringRun",
] as const;
export type PerAttemptField = (typeof PER_ATTEMPT_FIELDS)[number];

/** Persisted Execution fields the state machine reads and mutates (design §5.1, domain subset). */
export interface ExecutionSnapshot {
  readonly status: ExecutionStatus;
  /** 0 until the first X9. */
  readonly attempt: number;
  /** Current attempt's token, written by X9 (DD-28 phase 1). */
  readonly dispatchToken?: string;
  /** DD-28 phase 2: set immediately before exec, per attempt; cleared by X9 and X14. */
  readonly execStartedAt?: number;
  readonly lockWaitStartedAt?: number;
  /** Lock attempts made so far (design §5.1); maintained by the coordinator, read by X7/X14/X15. */
  readonly lockWaitAttempts?: number;
  readonly nextAttemptAt?: number;
  readonly deadlineAt?: number;
  readonly contentionCount: number;
  /** Set by FAILED / UNKNOWN_TARGET_STATE / SUPERSEDED outcomes. A REJECTED reason lives on the rejection record. */
  readonly error?: { readonly code: FailureCode | "UNKNOWN_TARGET_STATE" | "SUPERSEDED" };
  /** Per-attempt result (script exit code); cleared at X9/X14. */
  readonly result?: { readonly exitCode: number };
  readonly lockLostDuringRun?: boolean;
  readonly targetWriteRejected?: boolean;
  readonly windowClosedDuringRun?: boolean;
}

/** Facts for the creation guards (X1/X2). */
export interface CreationChecks {
  readonly senderAuthorized: boolean;
  readonly schemaValid: boolean;
  readonly requestIdMatches: boolean;
  /** The named target exists in the Target Registry (design §6.3, AC-02 V1). */
  readonly targetKnown: boolean;
  /** The target record is schema-valid and matches its key (design §6.3). */
  readonly targetValid: boolean;
  /** The SenderId session suffix (IAM-enforced repository_id) equals the record's sourceRepositoryId (option A, DD-25). */
  readonly sourceAuthorized: boolean;
  /** Dedupe claim on {targetId, requestId} owned by this processing (DD-20). Required by X1 only: X2 happens before any claim. */
  readonly dedupeClaimOwned: boolean;
}

export type TransitionRequest =
  /** X1 / X2: creation from nothing. */
  | { readonly kind: "CREATE"; readonly checks: CreationChecks }
  /** X3: S1 says a newer request already deployed, dispatched or was accepted. */
  | { readonly kind: "SUPERSEDE_QUEUED"; readonly superseded: boolean }
  /** X4 (V1 fails) or X5 (V1 OK, enter lock wait). */
  | { readonly kind: "EVALUATE_QUEUED"; readonly v1Valid: boolean; readonly now: number }
  /** X6: S2 under the lock (authoritative). */
  | { readonly kind: "SUPERSEDE_UNDER_LOCK"; readonly superseded: boolean; readonly lockHeld: boolean }
  /** X7: lock wait budget exhausted (handler or reconciler). */
  | { readonly kind: "LOCK_WAIT_TIMEOUT"; readonly now: number }
  /** X8: V2 fails on a retry. */
  | { readonly kind: "WAITING_WINDOW_CLOSED"; readonly v2Valid: boolean }
  /** X9: intent (DD-28 phase 1). */
  | {
      readonly kind: "BEGIN_DISPATCH";
      readonly v2Valid: boolean;
      readonly lockAcquired: boolean;
      readonly superseded: boolean;
      readonly newDispatchToken: string;
    }
  /** X10: V4 fails right before exec. */
  | { readonly kind: "WINDOW_CLOSED_BEFORE_EXEC"; readonly dispatchToken: string; readonly v4Valid: boolean }
  /** X11: failure before exec (connect, host key). DISPATCH_INTERRUPTED comes only from the reconciler request. */
  | {
      readonly kind: "FAIL_BEFORE_EXEC";
      readonly dispatchToken: string;
      readonly code: "SSH_CONNECT" | "HOST_KEY_MISMATCH";
    }
  /** X12 / X13 / X14 / X15 / X16, chosen by exit code. */
  | {
      readonly kind: "SCRIPT_EXITED";
      readonly dispatchToken: string;
      readonly exitCode: number;
      /** V3, evaluated after exit 50 before requeuing. */
      readonly v3Valid: boolean;
      readonly now: number;
      /** Next lock-retry time computed by the lock policy (used by X14 only). */
      readonly nextAttemptAt: number;
    }
  /** X16: session lost while the script may be running. */
  | { readonly kind: "SESSION_LOST"; readonly dispatchToken: string }
  /** Reconciler: overdue DEPLOYING resolves to X16 (execStartedAt set) or X11 DISPATCH_INTERRUPTED. */
  | { readonly kind: "RECONCILE_OVERDUE_DEPLOYING"; readonly now: number };

/** Persistence hints the adapter needs for the conditional write; no I/O here. */
export interface TransitionEffects {
  /** Snapshot fields to remove in the same write. */
  readonly clear: readonly PerAttemptField[];
  /** X16: append the execution to TARGET.unresolved[] in the same TransactWriteItems (R2-8). */
  readonly appendTargetUnresolved: boolean;
  /** X9: highestDispatched must be raised in the same TransactWriteItems (CS-2). */
  readonly raiseHighestDispatched: boolean;
  /** The write must also be conditional on the persisted dispatchToken (X10-X16). */
  readonly conditionOnDispatchToken: boolean;
  /** `to` is terminal: activeStatus/deadlineAt leave the sparse index, finishedAt is set. */
  readonly terminal: boolean;
}

export type TransitionResult =
  | {
      readonly accepted: true;
      readonly transitionId: TransitionId;
      readonly next: ExecutionSnapshot;
      readonly effects: TransitionEffects;
      /** X2 only. */
      readonly rejectReason?: RejectReason;
    }
  | { readonly accepted: false; readonly code: "INVALID_TRANSITION" };

const REJECT: TransitionResult = { accepted: false, code: "INVALID_TRANSITION" };

/** DEPLOYING rows conditional on the persisted dispatchToken (X10-X16). */
const TOKEN_EFFECTS = { conditionOnDispatchToken: true } as const;

export function newExecutionSnapshot(status: "QUEUED" | "REJECTED"): ExecutionSnapshot {
  return { status, attempt: 0, contentionCount: 0 };
}

function omitPerAttempt(s: ExecutionSnapshot): ExecutionSnapshot {
  const rest: Record<string, unknown> = { ...s };
  for (const field of PER_ATTEMPT_FIELDS) delete rest[field];
  return rest as unknown as ExecutionSnapshot;
}

function ok(
  id: TransitionId,
  next: ExecutionSnapshot,
  over: Partial<TransitionEffects> = {},
  rejectReason?: RejectReason,
): TransitionResult {
  const effects: TransitionEffects = {
    clear: [],
    appendTargetUnresolved: false,
    raiseHighestDispatched: false,
    conditionOnDispatchToken: false,
    terminal: TERMINAL_EXECUTION_STATUSES.has(next.status),
    ...over,
  };
  return rejectReason === undefined
    ? { accepted: true, transitionId: id, next, effects }
    : { accepted: true, transitionId: id, next, effects, rejectReason };
}

function failed(
  id: TransitionId,
  current: ExecutionSnapshot,
  code: FailureCode,
  over: Partial<TransitionEffects> = {},
): TransitionResult {
  return ok(id, { ...current, status: "FAILED", error: { code } }, over);
}

/** Canonical LOCK_TIMEOUT condition (design §7.6): 1,800 s elapsed OR the 10-attempt cap reached. */
function lockWaitExhausted(s: ExecutionSnapshot, now: number): boolean {
  if (s.lockWaitStartedAt === undefined) return false;
  return now - s.lockWaitStartedAt >= LOCK_WAIT_BUDGET_MS || (s.lockWaitAttempts ?? 0) >= MAX_LOCK_WAIT_ATTEMPTS;
}

function budgetRemaining(s: ExecutionSnapshot, now: number): boolean {
  if (s.lockWaitStartedAt === undefined) return false;
  return !lockWaitExhausted(s, now);
}

function firstRejectReason(c: CreationChecks): RejectReason | undefined {
  if (!c.senderAuthorized) return "UNAUTHORIZED_SENDER";
  if (!c.schemaValid) return "SCHEMA_INVALID";
  if (!c.requestIdMatches) return "REQUEST_ID_MISMATCH";
  if (!c.targetKnown) return "TARGET_UNKNOWN";
  if (!c.targetValid) return "TARGET_INVALID";
  if (!c.sourceAuthorized) return "TARGET_NOT_AUTHORIZED";
  return undefined;
}

function isCurrentAttempt(s: ExecutionSnapshot, token: string): boolean {
  return s.status === "DEPLOYING" && s.dispatchToken !== undefined && s.dispatchToken === token;
}

/** X16: requires `execStartedAt` for the current dispatchToken (DD-28, CW-1). */
function unknownTargetState(s: ExecutionSnapshot): TransitionResult {
  if (s.execStartedAt === undefined) return REJECT;
  return ok(
    "X16",
    { ...s, status: "UNKNOWN_TARGET_STATE", error: { code: "UNKNOWN_TARGET_STATE" } },
    { ...TOKEN_EFFECTS, appendTargetUnresolved: true },
  );
}

/**
 * Applies one transition request. Pure, never throws, never mutates input.
 * `current` is `null` for creations (X1/X2) and a snapshot otherwise.
 * Anything outside the closed list (wrong source state, failed guard, stale
 * dispatchToken, terminal source) returns INVALID_TRANSITION.
 */
export function applyTransition(
  current: ExecutionSnapshot | null,
  request: TransitionRequest,
): TransitionResult {
  if (request.kind === "CREATE") {
    if (current !== null) return REJECT;
    // Rejection precedes any dedupe claim (design §3.3, §5.1 REJECT#MSG#): X2 never needs one.
    const reason = firstRejectReason(request.checks);
    if (reason !== undefined) return ok("X2", newExecutionSnapshot("REJECTED"), {}, reason);
    // Only X1 requires the owned dedupe claim (DD-20).
    if (!request.checks.dedupeClaimOwned) return REJECT;
    return ok("X1", newExecutionSnapshot("QUEUED"));
  }
  if (current === null) return REJECT;
  if (TERMINAL_EXECUTION_STATUSES.has(current.status)) return REJECT;

  switch (request.kind) {
    case "SUPERSEDE_QUEUED": {
      if (current.status !== "QUEUED" || !request.superseded) return REJECT;
      return ok("X3", { ...current, status: "SUPERSEDED", error: { code: "SUPERSEDED" } });
    }

    case "EVALUATE_QUEUED": {
      if (current.status !== "QUEUED") return REJECT;
      if (!request.v1Valid) return failed("X4", current, "DEPLOY_WINDOW_CLOSED");
      return ok("X5", {
        ...current,
        status: "WAITING_LOCK",
        lockWaitStartedAt: request.now,
        nextAttemptAt: request.now,
      });
    }

    case "SUPERSEDE_UNDER_LOCK": {
      if (current.status !== "WAITING_LOCK" || !request.lockHeld || !request.superseded) return REJECT;
      return ok("X6", { ...current, status: "SUPERSEDED", error: { code: "SUPERSEDED" } });
    }

    case "LOCK_WAIT_TIMEOUT": {
      if (current.status !== "WAITING_LOCK" || current.lockWaitStartedAt === undefined) return REJECT;
      if (!lockWaitExhausted(current, request.now)) return REJECT;
      return failed("X7", current, "LOCK_TIMEOUT");
    }

    case "WAITING_WINDOW_CLOSED": {
      if (current.status !== "WAITING_LOCK" || request.v2Valid) return REJECT;
      return failed("X8", current, "DEPLOY_WINDOW_CLOSED");
    }

    case "BEGIN_DISPATCH": {
      if (current.status !== "WAITING_LOCK") return REJECT;
      if (!request.v2Valid || !request.lockAcquired || request.superseded) return REJECT;
      if (request.newDispatchToken === "") return REJECT;
      return ok(
        "X9",
        {
          ...omitPerAttempt(current),
          status: "DEPLOYING",
          attempt: current.attempt + 1,
          dispatchToken: request.newDispatchToken,
        },
        { clear: PER_ATTEMPT_FIELDS, raiseHighestDispatched: true },
      );
    }

    case "WINDOW_CLOSED_BEFORE_EXEC": {
      if (!isCurrentAttempt(current, request.dispatchToken)) return REJECT;
      if (request.v4Valid || current.execStartedAt !== undefined) return REJECT;
      return failed("X10", current, "DEPLOY_WINDOW_CLOSED", TOKEN_EFFECTS);
    }

    case "FAIL_BEFORE_EXEC": {
      if (!isCurrentAttempt(current, request.dispatchToken)) return REJECT;
      if (current.execStartedAt !== undefined) return REJECT;
      // Runtime guard too: DISPATCH_INTERRUPTED is reconciler-only (callers may bypass the type).
      if (request.code !== "SSH_CONNECT" && request.code !== "HOST_KEY_MISMATCH") return REJECT;
      return failed("X11", current, request.code, TOKEN_EFFECTS);
    }

    case "SCRIPT_EXITED": {
      if (!isCurrentAttempt(current, request.dispatchToken)) return REJECT;
      const exit = classifyExitCode(request.exitCode);
      const withResult: ExecutionSnapshot = { ...current, result: { exitCode: request.exitCode } };
      switch (exit.kind) {
        case "SUCCESS":
          return ok("X12", { ...withResult, status: "SUCCEEDED" }, TOKEN_EFFECTS);
        case "FAILED":
          return failed("X13", withResult, exit.code, TOKEN_EFFECTS);
        case "TARGET_BUSY": {
          if (request.v3Valid && budgetRemaining(current, request.now)) {
            return ok(
              "X14",
              {
                ...omitPerAttempt(current),
                status: "WAITING_LOCK",
                nextAttemptAt: request.nextAttemptAt,
                contentionCount: current.contentionCount + 1,
              },
              { ...TOKEN_EFFECTS, clear: PER_ATTEMPT_FIELDS },
            );
          }
          return failed("X15", withResult, request.v3Valid ? "LOCK_TIMEOUT" : "DEPLOY_WINDOW_CLOSED", TOKEN_EFFECTS);
        }
        case "UNKNOWN":
          return unknownTargetState(withResult);
      }
    }

    case "SESSION_LOST": {
      if (!isCurrentAttempt(current, request.dispatchToken)) return REJECT;
      return unknownTargetState(current);
    }

    case "RECONCILE_OVERDUE_DEPLOYING": {
      if (current.status !== "DEPLOYING" || current.deadlineAt === undefined) return REJECT;
      if (!(current.deadlineAt < request.now)) return REJECT;
      return current.execStartedAt !== undefined
        ? unknownTargetState(current)
        : failed("X11", current, "DISPATCH_INTERRUPTED", TOKEN_EFFECTS);
    }

    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}
