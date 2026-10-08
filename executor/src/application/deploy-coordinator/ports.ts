// @akili-spec changes/cicd-executor-poc design §1.2, §5.1, §6.5, §7, DD-09, DD-27, DD-28; tasks R-5 (AC-02 V1)
// Ports the deploy-coordinator depends on. The storage ports are structurally
// the public surface of the `dynamodb-state-store` repositories, so the real
// classes satisfy them without adapters. AC-02 V1: there is no plan resolver;
// the deploy plan is built from the execution's target snapshot (design §6.5).
// The lock key is the `targetId` (design §1.2).
import type { TargetOrderingState } from "../../domain/supersede-policy/index.js";
import type { RevalidationPoint, Revalidation, WindowTarget } from "../deploy-window-service/index.js";
import type { LockItem } from "../../adapters/dynamodb-state-store/types.js";
import type { LockAcquireOutcome } from "../../adapters/dynamodb-state-store/lock-repository.js";
import type {
  RecordDeployedInput,
  RecordDeployedOutcome,
} from "../../adapters/dynamodb-state-store/target-state-repository.js";
import type {
  BeginDispatchInput,
  BeginDispatchOutcome,
  MarkUnknownInput,
  MarkUnknownOutcome,
} from "../../adapters/dynamodb-state-store/deploy-transactions.js";
import type { ExecutionStorePort } from "../execution-service/ports.js";

export type DeployExecutionStore = Pick<ExecutionStorePort, "get" | "update">;

export interface DeployLockPort {
  get(lockKey: string): Promise<LockItem | undefined>;
  acquire(lockKey: string, me: string, now: number, leaseSeconds: number): Promise<LockAcquireOutcome>;
  renew(lockKey: string, owner: string, now: number, leaseSeconds: number): Promise<boolean>;
  release(lockKey: string, owner: string, now: number): Promise<boolean>;
}

export interface DeployTargetPort {
  /** Ordering attributes of `TARGET#{lockKey}`; `undefined` until first written. */
  get(lockKey: string): Promise<TargetOrderingState | undefined>;
  recordDeployed(input: RecordDeployedInput): Promise<RecordDeployedOutcome>;
}

export interface DeployTransactionPort {
  beginDispatch(input: BeginDispatchInput): Promise<BeginDispatchOutcome>;
  markUnknownTargetState(input: MarkUnknownInput): Promise<MarkUnknownOutcome>;
}

export interface WindowRevalidator {
  /** `target` carries the snapshot's window policy (AC-02 V1): the registry is never re-read for an accepted execution. */
  revalidate(point: RevalidationPoint, target: WindowTarget, needUntil: number): Promise<Revalidation>;
}
