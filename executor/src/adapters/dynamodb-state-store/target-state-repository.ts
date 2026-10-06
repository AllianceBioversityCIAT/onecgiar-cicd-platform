// @akili-spec changes/cicd-executor-poc design §5.1, §7.3 (X1/E2, X9, X12, X16), DD-09, DD-27; requirements FR-11, FR-23
// Repository for the Target state item (`TARGET#{lockKey}` / `STATE`). Four
// independent write paths, each with its own storage-level guard:
//
//   - `recordDeployed` (X12 success): FENCED. Writes `lastDeployed`, the current
//     and previous images and the fencing token only when the incoming token is
//     never LOWER than the stored one (a stale lock holder must not clobber a
//     newer epoch's state; equal is accepted: the same epoch may write twice)
//     and the source is the one already bound.
//   - `highestDispatched` (X9 intent): monotonic max, NEVER fenced (a lost lease
//     cannot reject it). Exposed as a TransactWriteItems item builder so the
//     coordinator puts it in the same transaction as the X9 execution update.
//   - `raiseHighestAccepted` (after X1, editorial E2): a SEPARATE conditional
//     update, not part of X1. A failed condition is the expected, error-free
//     outcome for an older request.
//   - `unresolved[]`: appended in the X16 transaction (builder); entries are
//     removed only by the operator mechanism of runbook §12.2, which never
//     touches an ordering field.
//
// Ordering semantics (`stored <= new`, equal accepted, never across sources)
// are decided by `domain/supersede-policy`; the condition expressions below only
// make that rule atomic in storage, and `decideRaiseMax` classifies a refusal.
// Images are opaque strings: `previousImages` may carry the script's
// `unresolved:sha256:<id>` marker, which is never interpreted as a digest.
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { decideRaiseMax, type OrderingValue } from "../../domain/supersede-policy/index.js";
import { targetStateKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { isConditionalCheckFailure, runConditionalWrite } from "./condition-error.js";
import type { AcceptedStamp, DeployedStamp, DispatchedStamp, TargetStateItem, UnresolvedEntry } from "./types.js";

/** An Update usable both as a standalone `UpdateCommand` input and as a `TransactWriteItems` `Update` item. */
export interface TargetUpdateSpec {
  readonly TableName: string;
  readonly Key: Record<string, string>;
  readonly UpdateExpression: string;
  readonly ConditionExpression?: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues: Record<string, unknown>;
}

export type RaiseOutcome =
  | { readonly raised: true }
  | { readonly raised: false; readonly reason: "STORED_IS_NEWER" | "SOURCE_MISMATCH" };

export type RecordDeployedOutcome =
  | { readonly written: true }
  | { readonly written: false; readonly reason: "STALE_FENCING_TOKEN" | "SOURCE_MISMATCH" };

export interface RecordDeployedInput {
  readonly lockKey: string;
  readonly fencingToken: number;
  readonly lastDeployed: DeployedStamp;
  /** Absent when the script reported no `CICD_RESULT`: the stored images are then left untouched. */
  readonly currentImages?: Readonly<Record<string, string>>;
  /** Opaque strings; may include the `unresolved:sha256:<id>` marker. */
  readonly previousImages?: Readonly<Record<string, string>>;
  readonly updatedAt: number;
}

type RaisableAttribute = "highestDispatched" | "highestAccepted";

export class TargetStateRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async get(lockKey: string): Promise<TargetStateItem | undefined> {
    const key = targetStateKey(lockKey);
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
        ConsistentRead: true,
      }),
    );
    return result.Item as TargetStateItem | undefined;
  }

  /**
   * X12 success: fenced write of `lastDeployed` and the images. Applied iff the
   * incoming `fencingToken >= stored fencingToken` (or none stored yet) AND the
   * stored `lastDeployed`, if any, belongs to the same source. Never touches
   * `highestDispatched`, `highestAccepted` or `unresolved`.
   */
  public async recordDeployed(input: RecordDeployedInput): Promise<RecordDeployedOutcome> {
    assertValidOrdering(input.lastDeployed);
    const names: Record<string, string> = {
      "#lockKey": "lockKey",
      "#lastDeployed": "lastDeployed",
      "#fencingToken": "fencingToken",
      "#updatedAt": "updatedAt",
      "#version": "version",
      "#sourceRef": "sourceRef",
    };
    const values: Record<string, unknown> = {
      ":lockKey": input.lockKey,
      ":lastDeployed": input.lastDeployed,
      ":fencingToken": input.fencingToken,
      ":updatedAt": input.updatedAt,
      ":sourceRef": input.lastDeployed.sourceRef,
      ":one": 1,
    };
    const sets = [
      "#lockKey = :lockKey",
      "#lastDeployed = :lastDeployed",
      "#fencingToken = :fencingToken",
      "#updatedAt = :updatedAt",
    ];
    if (input.currentImages !== undefined) {
      names["#currentImages"] = "currentImages";
      values[":currentImages"] = input.currentImages;
      sets.push("#currentImages = :currentImages");
    }
    if (input.previousImages !== undefined) {
      names["#previousImages"] = "previousImages";
      values[":previousImages"] = input.previousImages;
      sets.push("#previousImages = :previousImages");
    }
    const key = targetStateKey(input.lockKey);
    const spec: TargetUpdateSpec = {
      TableName: this.tableName,
      Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
      UpdateExpression: `SET ${sets.join(", ")} ADD #version :one`,
      ConditionExpression:
        "(attribute_not_exists(#fencingToken) OR #fencingToken <= :fencingToken) AND " +
        "(attribute_not_exists(#lastDeployed) OR #lastDeployed.#sourceRef = :sourceRef)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    };
    if (await runConditionalWrite(() => this.client.send(new UpdateCommand(spec)))) {
      return { written: true };
    }
    const stored = await this.get(input.lockKey);
    if (stored?.lastDeployed !== undefined && stored.lastDeployed.sourceRef !== input.lastDeployed.sourceRef) {
      return { written: false, reason: "SOURCE_MISMATCH" };
    }
    return { written: false, reason: "STALE_FENCING_TOKEN" };
  }

  /**
   * X9 intent: the `TransactWriteItems` `Update` item that raises
   * `highestDispatched` (condition: absent, or same source and
   * `stored.runNumber <= new.runNumber`; equal accepted). Unfenced by design.
   * If the condition fails the whole X9 transaction is cancelled (the
   * coordinator treats it as a newer dispatch having won).
   */
  public highestDispatchedUpdate(lockKey: string, value: DispatchedStamp, updatedAt: number): TargetUpdateSpec {
    return this.raiseSpec("highestDispatched", lockKey, value, updatedAt);
  }

  /** Standalone form of `highestDispatchedUpdate` (same condition, outside a transaction). */
  public async raiseHighestDispatched(
    lockKey: string,
    value: DispatchedStamp,
    updatedAt: number,
  ): Promise<RaiseOutcome> {
    return this.raise("highestDispatched", lockKey, value, updatedAt);
  }

  /**
   * After X1 commits (E2): separate conditional update raising `highestAccepted`
   * only when absent or `stored <= new`. `{ raised: false }` is the expected,
   * error-free outcome for an older request.
   */
  public async raiseHighestAccepted(lockKey: string, value: AcceptedStamp, updatedAt: number): Promise<RaiseOutcome> {
    return this.raise("highestAccepted", lockKey, value, updatedAt);
  }

  /**
   * X16: the `TransactWriteItems` `Update` item appending an entry to
   * `unresolved[]`. Touches no ordering field.
   */
  public unresolvedAppendUpdate(lockKey: string, entry: UnresolvedEntry, updatedAt: number): TargetUpdateSpec {
    const key = targetStateKey(lockKey);
    return {
      TableName: this.tableName,
      Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
      UpdateExpression:
        "SET #lockKey = if_not_exists(#lockKey, :lockKey), #unresolved = list_append(if_not_exists(#unresolved, :empty), :entry), " +
        "#updatedAt = :updatedAt ADD #version :one",
      ExpressionAttributeNames: {
        "#lockKey": "lockKey",
        "#unresolved": "unresolved",
        "#updatedAt": "updatedAt",
        "#version": "version",
      },
      ExpressionAttributeValues: {
        ":lockKey": lockKey,
        ":empty": [],
        ":entry": [entry],
        ":updatedAt": updatedAt,
        ":one": 1,
      },
    };
  }

  /**
   * Operator resolution (runbook §12.2 step 6): removes the entry of
   * `executionId` from `unresolved[]` with a conditional write on its position.
   * Returns `false` when no such entry exists. NEVER edits an ordering field,
   * the images or the fencing token. Preconditions (execution status, no live
   * lock owner) are the service's, not storage's.
   */
  public async removeUnresolved(lockKey: string, executionId: string, updatedAt: number): Promise<boolean> {
    const key = targetStateKey(lockKey);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stored = await this.get(lockKey);
      const index = stored?.unresolved?.findIndex((entry) => entry.executionId === executionId) ?? -1;
      if (index < 0) return false;
      // The index is a literal inside the expression (DynamoDB does not accept a placeholder there).
      const removed = await runConditionalWrite(() =>
        this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
            UpdateExpression: `REMOVE #unresolved[${String(index)}] SET #updatedAt = :updatedAt ADD #version :one`,
            ConditionExpression: `#unresolved[${String(index)}].#executionId = :executionId`,
            ExpressionAttributeNames: {
              "#unresolved": "unresolved",
              "#executionId": "executionId",
              "#updatedAt": "updatedAt",
              "#version": "version",
            },
            ExpressionAttributeValues: { ":executionId": executionId, ":updatedAt": updatedAt, ":one": 1 },
          }),
        ),
      );
      if (removed) return true;
      // The list shifted under us (a concurrent removal): re-read and retry.
    }
    throw new Error(`removeUnresolved: could not settle the unresolved list for ${lockKey} after 5 attempts`);
  }

  private raiseSpec(
    attribute: RaisableAttribute,
    lockKey: string,
    value: OrderingValue & { readonly executionId: string },
    updatedAt: number,
  ): TargetUpdateSpec {
    assertValidOrdering(value);
    const key = targetStateKey(lockKey);
    return {
      TableName: this.tableName,
      Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
      UpdateExpression:
        "SET #lockKey = if_not_exists(#lockKey, :lockKey), #attr = :value, #updatedAt = :updatedAt ADD #version :one",
      ConditionExpression:
        "attribute_not_exists(#attr) OR (#attr.#sourceRef = :sourceRef AND #attr.#runNumber <= :runNumber)",
      ExpressionAttributeNames: {
        "#lockKey": "lockKey",
        "#attr": attribute,
        "#updatedAt": "updatedAt",
        "#version": "version",
        "#sourceRef": "sourceRef",
        "#runNumber": "runNumber",
      },
      ExpressionAttributeValues: {
        ":lockKey": lockKey,
        ":value": value,
        ":updatedAt": updatedAt,
        ":sourceRef": value.sourceRef,
        ":runNumber": value.runNumber,
        ":one": 1,
      },
    };
  }

  private async raise(
    attribute: RaisableAttribute,
    lockKey: string,
    value: OrderingValue & { readonly executionId: string },
    updatedAt: number,
  ): Promise<RaiseOutcome> {
    const spec = this.raiseSpec(attribute, lockKey, value, updatedAt);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.client.send(new UpdateCommand(spec));
        return { raised: true };
      } catch (error) {
        if (!isConditionalCheckFailure(error)) throw error;
      }
      // Classify the refusal with the shared pure rule instead of re-deriving it here.
      const decision = decideRaiseMax((await this.get(lockKey))?.[attribute], value);
      if (!decision.accepted) return { raised: false, reason: decision.reason };
      // The stored value changed between the failed write and the read and now
      // admits ours: try again.
    }
    throw new Error(`raise ${attribute}: could not settle for ${lockKey} after 5 attempts`);
  }
}

/** Rejects non-integer or < 1 run numbers with the policy's own rule (single place, no duplication). */
function assertValidOrdering(value: OrderingValue): void {
  decideRaiseMax(undefined, value);
}
