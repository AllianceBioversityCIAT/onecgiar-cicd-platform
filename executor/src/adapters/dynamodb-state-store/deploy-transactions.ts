// @akili-spec changes/cicd-executor-poc design §5.1, §7.3 (X9, X16), DD-27, DD-28; requirements FR-23, RL-4
// The two multi-item atomic writes of the deploy coordinator, as one
// `TransactWriteItems` each:
//   - X9 intent: the Execution update (WAITING_LOCK -> DEPLOYING, dispatchToken,
//     attempt + 1, per-attempt fields cleared) TOGETHER WITH `TARGET.highestDispatched`
//     (unfenced monotonic max). A failed highestDispatched condition cancels the
//     whole transaction, so a cancelled X9 leaves NO intent behind (CS-2).
//   - X16: the Execution update (-> UNKNOWN_TARGET_STATE) TOGETHER WITH the
//     `TARGET.unresolved[]` append (R2-8).
// The statements themselves come from the two repositories (single place per
// condition); this class only composes them and classifies a cancellation.
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  ExecutionRepository,
  ExecutionTransitionExpected,
  ExecutionUpdatePatch,
} from "./execution-repository.js";
import type { TargetStateRepository } from "./target-state-repository.js";
import type { DispatchedStamp, UnresolvedEntry } from "./types.js";

export interface BeginDispatchInput {
  readonly executionId: string;
  readonly expected: ExecutionTransitionExpected;
  readonly patch: ExecutionUpdatePatch;
  readonly lockKey: string;
  readonly dispatched: DispatchedStamp;
  readonly now: number;
}

export type BeginDispatchOutcome =
  | { readonly outcome: "COMMITTED" }
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
}

export type MarkUnknownOutcome = { readonly outcome: "COMMITTED" } | { readonly outcome: "EXECUTION_CONFLICT" };

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
  ) {}

  /** X9 (DD-28 phase 1): intent and `highestDispatched`, atomically. Item 0 = Execution, item 1 = TARGET. */
  public async beginDispatch(input: BeginDispatchInput): Promise<BeginDispatchOutcome> {
    const executionUpdate = this.executions.updateSpec(input.executionId, input.expected, input.patch);
    const targetUpdate = this.targets.highestDispatchedUpdate(input.lockKey, input.dispatched, input.now);
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: [{ Update: executionUpdate }, { Update: targetUpdate }] }),
      );
      return { outcome: "COMMITTED" };
    } catch (error) {
      const reasons = cancellationReasons(error);
      if (reasons === undefined) throw error;
      if (reasons[1]?.Code === CONDITION_FAILED) return { outcome: "TARGET_CONDITION_FAILED" };
      if (reasons[0]?.Code === CONDITION_FAILED) return { outcome: "EXECUTION_CONFLICT" };
      // Transaction conflicts and throttling are not a verdict: let the message be redelivered.
      throw error;
    }
  }

  /** X16: `UNKNOWN_TARGET_STATE` and the `unresolved[]` append, atomically. Item 0 = Execution, item 1 = TARGET. */
  public async markUnknownTargetState(input: MarkUnknownInput): Promise<MarkUnknownOutcome> {
    const executionUpdate = this.executions.updateSpec(input.executionId, input.expected, input.patch);
    const targetUpdate = this.targets.unresolvedAppendUpdate(input.lockKey, input.entry, input.now);
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: [{ Update: executionUpdate }, { Update: targetUpdate }] }),
      );
      return { outcome: "COMMITTED" };
    } catch (error) {
      const reasons = cancellationReasons(error);
      if (reasons === undefined) throw error;
      if (reasons[0]?.Code === CONDITION_FAILED) return { outcome: "EXECUTION_CONFLICT" };
      throw error;
    }
  }
}
