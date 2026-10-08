// @akili-spec changes/cicd-executor-poc design §5.1, DD-20; requirements FR-03
// Repository for the per-deployment Sequence item. An atomic `ADD` always
// applies (creates the item at 1 on first use) — no condition needed, this
// is DynamoDB's own atomic-counter primitive, and is exactly the one write
// DD-20 relies on to guarantee monotonic (not necessarily contiguous)
// sequence numbers under concurrent claims.
import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { sequenceKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";

export class SequenceRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Returns the post-increment value (DD-20 step 2: the counter is incremented). */
  public async increment(targetId: string): Promise<number> {
    const key = sequenceKey(targetId);
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
        UpdateExpression: "ADD #value :one",
        ExpressionAttributeNames: { "#value": "value" },
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return (result.Attributes as { value: number }).value;
  }
}
