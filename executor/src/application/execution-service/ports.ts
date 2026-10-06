// @akili-spec changes/cicd-executor-poc design §5.1, §7 (execution-service row), DD-19, DD-20, DD-27
// Ports the execution-service depends on. The storage ports are structurally
// the public surface of the `dynamodb-state-store` repositories (so the real
// classes satisfy them without adapters); the catalog and the target-ordering
// ports are implemented elsewhere (definition-service composition, N-09).
import type { OrderingValue, RaiseMaxDecision, TargetOrderingState } from "../../domain/supersede-policy/index.js";
import type { RejectionRef } from "../../adapters/dynamodb-state-store/keys.js";
import type { DedupeItem, ExecutionItem, RejectionItem } from "../../adapters/dynamodb-state-store/types.js";
import type { ExecutionTransitionExpected, ExecutionUpdatePatch } from "../../adapters/dynamodb-state-store/execution-repository.js";
import type { BoundSource } from "./source-ref.js";

/** What the service needs to know about a known deployment (resolved from its definition via `DefinitionSource`, DD-19). */
export interface DeploymentInfo {
  readonly definitionRef: string;
  readonly lockKey: string;
  /** The artifact units the definition declares: the request must carry exactly these (FR-03). */
  readonly units: readonly string[];
  readonly source: BoundSource;
}

export interface DeploymentCatalog {
  /** `undefined` when no definition exists for the id. */
  getDeployment(deploymentId: string): Promise<DeploymentInfo | undefined>;
}

/** An ordering value as stored in `TARGET#` (design §5.1), carrying the execution that wrote it. */
export interface TargetOrderingEntry extends OrderingValue {
  readonly executionId: string;
}

export interface TargetOrderingPort {
  /** Current ordering attributes of `TARGET#{lockKey}` (each absent until first written). */
  readOrdering(lockKey: string): Promise<TargetOrderingState>;
  /**
   * `highestAccepted` monotonic raise, a SEPARATE conditional write after X1
   * (design §7.3, E2): applied only when absent or `stored <= value`. A refused
   * raise is a normal, error-free outcome (`STORED_IS_NEWER`), never a throw.
   */
  raiseHighestAccepted(lockKey: string, value: TargetOrderingEntry): Promise<RaiseMaxDecision>;
}

export interface DedupePort {
  get(deploymentId: string, requestId: string): Promise<DedupeItem | undefined>;
  claim(deploymentId: string, requestId: string, claimToken: string, claimLeaseExpiresAt: number, expiresAt: number): Promise<boolean>;
  takeOverExpiredClaim(
    deploymentId: string,
    requestId: string,
    previousClaimToken: string,
    newClaimToken: string,
    newClaimLeaseExpiresAt: number,
    now: number,
  ): Promise<boolean>;
  recordSequence(deploymentId: string, requestId: string, claimToken: string, sequence: number): Promise<boolean>;
  bind(deploymentId: string, requestId: string, claimToken: string, executionId: string): Promise<boolean>;
}

export interface SequencePort {
  increment(deploymentId: string): Promise<number>;
}

export interface ExecutionStorePort {
  get(executionId: string): Promise<ExecutionItem | undefined>;
  create(item: ExecutionItem): Promise<boolean>;
  update(executionId: string, expected: ExecutionTransitionExpected, patch: ExecutionUpdatePatch): Promise<boolean>;
}

export interface RejectionStorePort {
  record(ref: RejectionRef, item: Omit<RejectionItem, "expiresAt">): Promise<boolean>;
}
