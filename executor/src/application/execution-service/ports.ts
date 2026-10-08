// @akili-spec changes/cicd-executor-poc design §1.2, §5.1, §7 (execution-service row), DD-20, DD-27; tasks R-4 (AC-02 V1)
// Ports the execution-service depends on. The storage ports are structurally
// the public surface of the `dynamodb-state-store` repositories (so the real
// classes satisfy them without adapters); the target-ordering port is adapted
// in the composition. AC-02 V1: there is no deployment catalog; the deploy
// identity and lock key is the `targetId` (design §1.2).
import type { OrderingValue, RaiseMaxDecision, TargetOrderingState } from "../../domain/supersede-policy/index.js";
import type { RejectionRef } from "../../adapters/dynamodb-state-store/keys.js";
import type { DedupeItem, ExecutionItem, RejectionItem } from "../../adapters/dynamodb-state-store/types.js";
import type { ExecutionTransitionExpected, ExecutionUpdatePatch } from "../../adapters/dynamodb-state-store/execution-repository.js";

/** An ordering value as stored in `TARGET#` (design §5.1), carrying the execution that wrote it. */
export interface TargetOrderingEntry extends OrderingValue {
  readonly executionId: string;
}

export interface TargetOrderingPort {
  /** Current ordering attributes of `TARGET#{targetId}` (each absent until first written). */
  readOrdering(targetId: string): Promise<TargetOrderingState>;
  /**
   * `highestAccepted` monotonic raise, a SEPARATE conditional write after X1
   * (design §7.3, E2): applied only when absent or `stored <= value`. A refused
   * raise is a normal, error-free outcome (`STORED_IS_NEWER`), never a throw.
   */
  raiseHighestAccepted(targetId: string, value: TargetOrderingEntry): Promise<RaiseMaxDecision>;
}

export interface DedupePort {
  get(targetId: string, requestId: string): Promise<DedupeItem | undefined>;
  claim(targetId: string, requestId: string, claimToken: string, claimLeaseExpiresAt: number, expiresAt: number): Promise<boolean>;
  takeOverExpiredClaim(
    targetId: string,
    requestId: string,
    previousClaimToken: string,
    newClaimToken: string,
    newClaimLeaseExpiresAt: number,
    now: number,
  ): Promise<boolean>;
  recordSequence(targetId: string, requestId: string, claimToken: string, sequence: number): Promise<boolean>;
  bind(targetId: string, requestId: string, claimToken: string, executionId: string): Promise<boolean>;
}

export interface SequencePort {
  increment(targetId: string): Promise<number>;
}

export interface ExecutionStorePort {
  get(executionId: string): Promise<ExecutionItem | undefined>;
  create(item: ExecutionItem): Promise<boolean>;
  update(executionId: string, expected: ExecutionTransitionExpected, patch: ExecutionUpdatePatch): Promise<boolean>;
}

export interface RejectionStorePort {
  record(ref: RejectionRef, item: Omit<RejectionItem, "expiresAt">): Promise<boolean>;
}
