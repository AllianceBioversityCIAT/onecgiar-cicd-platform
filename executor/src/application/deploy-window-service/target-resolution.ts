// @akili-spec changes/cicd-executor-poc design §1.2, §6.4, runbook §12.2 (TARGET_RESOLUTION_RECORDED), DD-25; requirements FR-17; tasks R-5 (AC-02 V1)
// Handles TARGET_RESOLUTION_RECORDED. The CLI is not trusted: the Executor
// checks the preconditions here, through ports:
//   1. the execution exists, is UNKNOWN_TARGET_STATE and belongs to `targetId`;
//   2. it is listed in the target's `unresolved[]`;
//   3. the target (the V1 lock key, design §1.2) has no live lock owner.
// Effect: audit first (idempotent per eventId), then remove that ONE entry
// from `unresolved[]` through a conditional write. The ports below expose no
// way to touch `lastDeployed`, `highestDispatched`, `highestAccepted` or any
// terminal state, so resolution cannot edit ordering fields (OD-A8).
import type { Clock } from "../../ports/clock.js";

/** Read side of the target state's `unresolved[]` (N-09) plus the single permitted write. */
export interface UnresolvedStore {
  listUnresolved(lockKey: string): Promise<readonly string[]>;
  /** Conditional removal of one executionId; false when the entry is gone or the condition failed. */
  removeUnresolved(lockKey: string, executionId: string): Promise<boolean>;
}

export interface ExecutionLookup {
  getStatus(executionId: string): Promise<{ readonly status: string; readonly targetId: string } | undefined>;
}

export interface LockOwnerLookup {
  /** True when a non-expired lease exists for `lockKey` at `nowMs`. */
  hasLiveOwner(lockKey: string, nowMs: number): Promise<boolean>;
}

export interface ResolutionAudit {
  readonly eventId: string;
  readonly targetId: string;
  readonly executionId: string;
  readonly resolvedBy: string;
  /** SQS SenderId role of the operator principal, when the caller supplies it. */
  readonly senderId?: string;
  readonly observedDigests: Readonly<Record<string, string>>;
  readonly note?: string;
  readonly at: number;
}

export interface ResolutionAuditWriter {
  /** Idempotent per `eventId` (writing the same event twice is a no-op). */
  write(entry: ResolutionAudit): Promise<void>;
}

export interface ResolutionContext {
  readonly senderId?: string;
}

export type ResolutionRejection =
  | "EXECUTION_NOT_FOUND"
  | "EXECUTION_NOT_UNKNOWN_TARGET_STATE"
  | "TARGET_MISMATCH"
  | "NOT_LISTED_IN_UNRESOLVED"
  | "LOCK_HAS_LIVE_OWNER";

export type ResolutionOutcome =
  | { readonly outcome: "RECORDED" }
  | { readonly outcome: "REJECTED"; readonly reason: ResolutionRejection }
  /** The conditional removal lost a race; let the message be redelivered. */
  | { readonly outcome: "CONFLICT" };

export interface TargetResolutionDeps {
  readonly unresolved: UnresolvedStore;
  readonly executions: ExecutionLookup;
  readonly locks: LockOwnerLookup;
  readonly audit: ResolutionAuditWriter;
  readonly clock: Clock;
}

export interface TargetResolutionEvent {
  readonly eventId: string;
  readonly targetId: string;
  readonly executionId: string;
  readonly resolvedBy: string;
  readonly observedDigests: Readonly<Record<string, string>>;
  readonly note?: string;
}

function reject(reason: ResolutionRejection): ResolutionOutcome {
  return { outcome: "REJECTED", reason };
}

export class TargetResolutionService {
  public constructor(private readonly deps: TargetResolutionDeps) {}

  public async record(event: TargetResolutionEvent, context: ResolutionContext = {}): Promise<ResolutionOutcome> {
    const execution = await this.deps.executions.getStatus(event.executionId);
    if (execution === undefined) return reject("EXECUTION_NOT_FOUND");
    if (execution.status !== "UNKNOWN_TARGET_STATE") return reject("EXECUTION_NOT_UNKNOWN_TARGET_STATE");
    if (execution.targetId !== event.targetId) return reject("TARGET_MISMATCH");

    const unresolved = await this.deps.unresolved.listUnresolved(event.targetId);
    if (!unresolved.includes(event.executionId)) return reject("NOT_LISTED_IN_UNRESOLVED");

    const now = this.deps.clock.now().getTime();
    if (await this.deps.locks.hasLiveOwner(event.targetId, now)) return reject("LOCK_HAS_LIVE_OWNER");

    await this.deps.audit.write({
      eventId: event.eventId,
      targetId: event.targetId,
      executionId: event.executionId,
      resolvedBy: event.resolvedBy,
      ...(context.senderId === undefined ? {} : { senderId: context.senderId }),
      observedDigests: event.observedDigests,
      ...(event.note === undefined ? {} : { note: event.note }),
      at: now,
    });
    const removed = await this.deps.unresolved.removeUnresolved(event.targetId, event.executionId);
    return removed ? { outcome: "RECORDED" } : { outcome: "CONFLICT" };
  }
}
