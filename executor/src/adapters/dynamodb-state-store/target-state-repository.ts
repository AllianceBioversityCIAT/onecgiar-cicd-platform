// @akili-spec changes/cicd-executor-poc design §5.1, DD-09
// Repository for the Target state item. (design §5.1: write conditional on the
// lock owner and the fencingToken) — the lock OWNERSHIP check already
// happened at the SSH handler layer (it only calls this with the
// `fencingToken` its own successful lock acquisition returned); what THIS
// repository alone can and must enforce at the storage layer is that the
// fencing token on an incoming write is never LOWER than the one already
// stored (forward pointer T-08.a): a write from a stale/superseded holder of
// an older fencing token must never clobber state written by a newer one,
// even if the stale write arrives later (e.g. a slow SSH session whose lock
// lease has since been taken over). Equal-to-current is accepted (the SAME
// lock epoch may legitimately write its target state more than once, e.g.
// `currentImages` now, `lastDeployedSequence` moments later).
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { targetStateKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";
import type { TargetStateItem } from "./types.js";

export class TargetStateRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async get(lockKey: string): Promise<TargetStateItem | undefined> {
    const key = targetStateKey(lockKey);
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk } }),
    );
    return result.Item as TargetStateItem | undefined;
  }

  /**
   * Monotonic-fencing conditional write (forward pointer T-08.a): applied iff
   * the item does not exist yet, OR `item.fencingToken >= stored.fencingToken`.
   * A strictly-lower incoming token is rejected — `false`, no exception
   * (DD-03's "condition failure = no-op").
   */
  public async write(item: TargetStateItem): Promise<boolean> {
    const key = targetStateKey(item.lockKey);
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR}) OR #fencingToken <= :newFencingToken`,
          ExpressionAttributeNames: { "#fencingToken": "fencingToken" },
          ExpressionAttributeValues: { ":newFencingToken": item.fencingToken },
        }),
      ),
    );
  }

  /** Narrower helper used by the SSH handler to bump only `lastDeployedSequence` (supersede checks, DD-09). */
  public async updateLastDeployedSequence(
    lockKey: string,
    fencingToken: number,
    lastDeployedSequence: number,
    lastExecutionId: string,
    updatedAt: number,
  ): Promise<boolean> {
    const key = targetStateKey(lockKey);
    return runConditionalWrite(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          UpdateExpression:
            "SET #lastDeployedSequence = :seq, #lastExecutionId = :execId, #updatedAt = :updatedAt, #fencingToken = :fencingToken",
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR}) OR #fencingToken <= :fencingToken`,
          ExpressionAttributeNames: {
            "#lastDeployedSequence": "lastDeployedSequence",
            "#lastExecutionId": "lastExecutionId",
            "#updatedAt": "updatedAt",
            "#fencingToken": "fencingToken",
          },
          ExpressionAttributeValues: {
            ":seq": lastDeployedSequence,
            ":execId": lastExecutionId,
            ":updatedAt": updatedAt,
            ":fencingToken": fencingToken,
          },
        }),
      ),
    );
  }
}
