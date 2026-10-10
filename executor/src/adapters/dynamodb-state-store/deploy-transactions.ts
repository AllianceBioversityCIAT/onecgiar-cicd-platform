// @akili-spec changes/cicd-executor-poc design §5.1, §7.3 (X9, X16), DD-27, DD-28; requirements FR-23, RL-4
// The two multi-item atomic writes of the deploy coordinator, as one
// `TransactWriteItems` each:
//   - X9 intent: the Execution update (WAITING_LOCK -> DEPLOYING, dispatchToken,
//     attempt + 1, per-attempt fields cleared) TOGETHER WITH `TARGET.highestDispatched`
//     (unfenced monotonic max). A failed highestDispatched condition cancels the
//     whole transaction, so a cancelled X9 leaves NO intent behind (CS-2).
//   - X16: the Execution update (-> UNKNOWN_TARGET_STATE) TOGETHER WITH the
//     `TARGET.unresolved[]` append (R2-8).
// architecture-change-04 adds the lock to these transactions:
//   - X9 of an sqs-agent dispatch also PINS the lock (owner + fencing token + live
//     short lease); a cancelled pin dispatches nothing;
//   - a closing transition with proof that no process exists RELEASES the lock in
//     the same transaction (fenced on owner and token);
//   - X16 HOLDS the lock in the same transaction (AP-3), for both transports.
// The statements themselves come from the repositories (single place per
// condition); this class only composes them and classifies a cancellation.
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  ExecutionRepository,
  ExecutionTransitionExpected,
  ExecutionUpdatePatch,
} from "./execution-repository.js";
import type { LockRepository } from "./lock-repository.js";
import type { TargetStateRepository } from "./target-state-repository.js";
import type { DispatchedStamp, UnresolvedEntry } from "./types.js";

export interface BeginDispatchInput {
  readonly executionId: string;
  readonly expected: ExecutionTransitionExpected;
  readonly patch: ExecutionUpdatePatch;
  readonly lockKey: string;
  readonly dispatched: DispatchedStamp;
  readonly now: number;
  /** architecture-change-04: pin the lock in the same transaction (sqs-agent dispatch). */
  readonly pin?: { readonly owner: string; readonly fencingToken: number };
}

export type BeginDispatchOutcome =
  | { readonly outcome: "COMMITTED" }
  /** The pin condition failed (our short lease expired or the lock changed hands): nothing was written. */
  | { readonly outcome: "LOCK_CONDITION_FAILED" }
  /** `highestDispatched` is newer (or of another source): nothing was written. */
  | { readonly outcome: "TARGET_CONDITION_FAILED" }
  /** The Execution item no longer matches status/version: another actor moved it; nothing was written. */
  | { readonly outcome: "EXECUTION_CONFLICT" };

export interface MarkUnknownInput {
  readonly executionId: string;
  readonly expected: ExecutionTransitionExpected;
  readonly patch: ExecutionUpdatePatch;
  readonly lockKey: string;
  readonly entry: UnresolvedEntry;
  readonly now: number;
  /** architecture-change-04 §9.1 (AP-3): hold the lock in the same transaction when this execution still owns it. */
  readonly hold?: { readonly owner: string; readonly fencingToken: number; readonly reason: string };
}

export type MarkUnknownOutcome =
  | { readonly outcome: "COMMITTED"; readonly held: boolean }
  | { readonly outcome: "EXECUTION_CONFLICT" };

/** architecture-change-04 §9.1: a closing transition and the fenced lock release, atomically. */
export interface CloseWithReleaseInput {
  readonly executionId: string;
  readonly expected: ExecutionTransitionExpected;
  readonly patch: ExecutionUpdatePatch;
  readonly lockKey: string;
  readonly owner: string;
  readonly fencingToken: number;
  readonly now: number;
}

export type CloseWithReleaseOutcome =
  | { readonly outcome: "COMMITTED" }
  | { readonly outcome: "EXECUTION_CONFLICT" }
  /** The lock is not this execution's (or is held): nothing was written. */
  | { readonly outcome: "LOCK_CONDITION_FAILED" };

interface CancellationReason {
  readonly Code?: string;
}

function cancellationReasons(error: unknown): readonly CancellationReason[] | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const named = error as { name?: unknown; CancellationReasons?: unknown };
  if (named.name !== "TransactionCanceledException") return undefined;
  return Array.isArray(named.CancellationReasons) ? (named.CancellationReasons as CancellationReason[]) : [];
}

const CONDITION_FAILED = "ConditionalCheckFailed";

export class DeployTransactions {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly executions: ExecutionRepository,
    private readonly targets: TargetStateRepository,
    /** Needed only by the architecture-change-04 operations (pin, release, hold). */
    private readonly locks?: LockRepository,
  ) {}

  private lockRepository(): LockRepository {
    if (this.locks === undefined) throw new Error("deploy-transactions: lock operations need the LockRepository");
    return this.locks;
  }

  /** X9 (DD-28 phase 1): intent and `highestDispatched`, atomically. Item 0 = Execution, item 1 = TARGET. */
  public async beginDispatch(input: BeginDispatchInput): Promise<BeginDispatchOutcome> {
    const executionUpdate = this.executions.updateSpec(input.executionId, input.expected, input.patch);
    const targetUpdate = this.targets.highestDispatchedUpdate(input.lockKey, input.dispatched, input.now);
    const items: { Update: object }[] = [{ Update: executionUpdate }, { Update: targetUpdate }];
    if (input.pin !== undefined) {
      items.push({ Update: this.lockRepository().pinSpec(input.lockKey, input.pin.owner, input.pin.fencingToken, input.now) });
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items as never }));
      return { outcome: "COMMITTED" };
    } catch (error) {
      const reasons = cancellationReasons(error);
      if (reasons === undefined) throw error;
      if (reasons[2]?.Code === CONDITION_FAILED) return { outcome: "LOCK_CONDITION_FAILED" };
      if (reasons[1]?.Code === CONDITION_FAILED) return { outcome: "TARGET_CONDITION_FAILED" };
      if (reasons[0]?.Code === CONDITION_FAILED) return { outcome: "EXECUTION_CONFLICT" };
      // Transaction conflicts and throttling are not a verdict: let the message be redelivered.
      throw error;
    }
  }

  /**
   * X16: `UNKNOWN_TARGET_STATE` and the `unresolved[]` append, atomically (item 0 = Execution, item 1 = TARGET), plus
   * the lock hold (item 2) when requested. If only the hold condition fails, this execution no longer owns the lock
   * (an SSH lease lost during the run): X16 is still written, without a hold, and `held` is false.
   */
  public async markUnknownTargetState(input: MarkUnknownInput): Promise<MarkUnknownOutcome> {
    const executionUpdate = this.executions.updateSpec(input.executionId, input.expected, input.patch);
    const targetUpdate = this.targets.unresolvedAppendUpdate(input.lockKey, input.entry, input.now);
    const items: { Update: object }[] = [{ Update: executionUpdate }, { Update: targetUpdate }];
    if (input.hold !== undefined) {
      items.push({ Update: this.lockRepository().holdSpec(input.lockKey, input.hold.owner, input.hold.fencingToken, input.now, input.hold.reason) });
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items as never }));
      return { outcome: "COMMITTED", held: input.hold !== undefined };
    } catch (error) {
      const reasons = cancellationReasons(error);
      if (reasons === undefined) throw error;
      if (reasons[0]?.Code === CONDITION_FAILED) return { outcome: "EXECUTION_CONFLICT" };
      if (input.hold !== undefined && reasons[2]?.Code === CONDITION_FAILED) {
        const withoutHold = await this.markUnknownTargetState({ ...input, hold: undefined } as MarkUnknownInput);
        return withoutHold.outcome === "COMMITTED" ? { outcome: "COMMITTED", held: false } : withoutHold;
      }
      throw error;
    }
  }

  /** architecture-change-04 §9.1: closing transition + fenced lock release, atomically. Item 0 = Execution, item 1 = LOCK. */
  public async closeWithRelease(input: CloseWithReleaseInput): Promise<CloseWithReleaseOutcome> {
    const executionUpdate = this.executions.updateSpec(input.executionId, input.expected, input.patch);
    const lockUpdate = this.lockRepository().releaseSpec(input.lockKey, input.owner, input.fencingToken, input.now);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [{ Update: executionUpdate }, { Update: lockUpdate }] as never }));
      return { outcome: "COMMITTED" };
    } catch (error) {
      const reasons = cancellationReasons(error);
      if (reasons === undefined) throw error;
      if (reasons[0]?.Code === CONDITION_FAILED) return { outcome: "EXECUTION_CONFLICT" };
      if (reasons[1]?.Code === CONDITION_FAILED) return { outcome: "LOCK_CONDITION_FAILED" };
      throw error;
    }
  }
}
