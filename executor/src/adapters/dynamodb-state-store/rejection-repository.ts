// @akili-spec changes/cicd-executor-poc design §5.1, §7.3 (X2); requirements FR-07, FR-16
// Repository for the Rejection record: the only trace an X2 rejection leaves
// (X2 creates no Execution item). The write is `attribute_not_exists`, so a
// redelivered message that is rejected again is an idempotent no-op that
// preserves the first record (reason and receivedAt are never overwritten).
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { rejectionKey, TABLE_PK_ATTR, TABLE_SK_ATTR, type RejectionRef } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";
import type { RejectionItem } from "./types.js";

/** Retention of a rejection record (design §5.1): 30 days. */
export const REJECTION_TTL_SECONDS = 30 * 24 * 60 * 60;

export class RejectionRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async get(ref: RejectionRef): Promise<RejectionItem | undefined> {
    const key = rejectionKey(ref);
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk } }),
    );
    return result.Item as RejectionItem | undefined;
  }

  /**
   * `true`: this call recorded the rejection. `false`: a record already
   * existed (redelivery); the stored one is kept untouched.
   * `expiresAt` is derived from `receivedAt` (epoch ms) as epoch seconds.
   */
  public async record(ref: RejectionRef, item: Omit<RejectionItem, "expiresAt">): Promise<boolean> {
    const key = rejectionKey(ref);
    const expiresAt = Math.floor(item.receivedAt / 1000) + REJECTION_TTL_SECONDS;
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk, expiresAt },
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR})`,
        }),
      ),
    );
  }
}
