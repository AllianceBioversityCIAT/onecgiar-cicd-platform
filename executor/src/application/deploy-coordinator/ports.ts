// @akili-spec changes/cicd-executor-poc design §5.1, §7, DD-09, DD-27, DD-28
// Ports the deploy-coordinator depends on. The storage ports are structurally
// the public surface of the `dynamodb-state-store` repositories, so the real
// classes satisfy them without adapters; the plan resolver is implemented by
// the definition-service composition (DD-19).
import type { TargetOrderingState } from "../../domain/supersede-policy/index.js";
import type { RevalidationPoint, Revalidation } from "../deploy-window-service/index.js";
import type { ExecutionItem, LockItem } from "../../adapters/dynamodb-state-store/types.js";
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
  revalidate(point: RevalidationPoint, lockKey: string, needUntil: number): Promise<Revalidation>;
}

/** What the coordinator needs to run one deployment, resolved from the definition and the target registry (DD-19). */
export interface DeployPlan {
  /** Logical reference of the target, opaque to the coordinator; handed to the transport. */
  readonly targetRef: string;
  readonly timeoutMinutes: number;
  /** Script arguments (design §6.5), one element per argument; the fencing token is the lock's. */
  scriptArgs(fencingToken: number): readonly string[];
}

export interface DeployPlanResolver {
  resolve(execution: ExecutionItem): Promise<DeployPlan>;
}
