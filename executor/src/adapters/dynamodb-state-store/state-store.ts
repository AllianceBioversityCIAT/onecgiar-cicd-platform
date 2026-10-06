// @akili-spec changes/cicd-executor-poc design §4.2, §5.1, §7; DD-03
// Generic `StateStore` port implementation (ports/state-store.ts). This is
// the storage-agnostic surface other application modules may depend on when
// all they need is "conditional put/get/delete + an indexed query" without
// any of this adapter's richer, item-specific repository methods. GSI2
// is ALWAYS read with `QueryCommand` — `ScanCommand` is never imported here,
// enforced by the "GSI2 Query, never Scan" integration test (a spy on the
// underlying client fails the test the moment a ScanCommand is ever sent).
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { StateItemKey, StateStore, WriteCondition } from "../../ports/state-store.js";
import { runConditionalWrite } from "./condition-error.js";
import { TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { GSI2_NAME, GSI2_PK_ATTR, GSI2_SK_ATTR } from "./table-schema.js";

const INDEX_KEY_ATTRS: Readonly<Record<string, { readonly pk: string; readonly sk: string }>> = {
  [GSI2_NAME]: { pk: GSI2_PK_ATTR, sk: GSI2_SK_ATTR },
};

export class DynamoDbStateStore implements StateStore {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async getItem<TItem>(key: StateItemKey): Promise<TItem | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [TABLE_PK_ATTR]: key.partitionKey, [TABLE_SK_ATTR]: key.sortKey },
      }),
    );
    return result.Item as TItem | undefined;
  }

  public async putItem<TItem>(key: StateItemKey, item: TItem, condition: WriteCondition): Promise<boolean> {
    const conditionExpression =
      condition.expectedVersion === undefined ? `attribute_not_exists(${TABLE_PK_ATTR})` : "#version = :expectedVersion";
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, [TABLE_PK_ATTR]: key.partitionKey, [TABLE_SK_ATTR]: key.sortKey },
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: condition.expectedVersion === undefined ? undefined : { "#version": "version" },
          ExpressionAttributeValues:
            condition.expectedVersion === undefined ? undefined : { ":expectedVersion": condition.expectedVersion },
        }),
      ),
    );
  }

  public async deleteItem(key: StateItemKey, condition: WriteCondition): Promise<boolean> {
    const conditionExpression =
      condition.expectedVersion === undefined ? `attribute_exists(${TABLE_PK_ATTR})` : "#version = :expectedVersion";
    return runConditionalWrite(() =>
      this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.partitionKey, [TABLE_SK_ATTR]: key.sortKey },
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: condition.expectedVersion === undefined ? undefined : { "#version": "version" },
          ExpressionAttributeValues:
            condition.expectedVersion === undefined ? undefined : { ":expectedVersion": condition.expectedVersion },
        }),
      ),
    );
  }

  /** design §5.1: "one Query per partition... no scans". Never issues a ScanCommand. */
  public async queryIndex<TItem>(
    indexName: string,
    partitionValue: string,
    options?: { readonly sortKeyBefore?: string | number },
  ): Promise<TItem[]> {
    const indexKeyAttrs = INDEX_KEY_ATTRS[indexName];
    if (indexKeyAttrs === undefined) {
      throw new Error(`unknown index "${indexName}" — expected one of: ${Object.keys(INDEX_KEY_ATTRS).join(", ")}`);
    }

    const names: Record<string, string> = { "#pk": indexKeyAttrs.pk };
    const values: Record<string, unknown> = { ":pv": partitionValue };
    let keyConditionExpression = "#pk = :pv";
    if (options?.sortKeyBefore !== undefined) {
      names["#sk"] = indexKeyAttrs.sk;
      values[":sk"] = options.sortKeyBefore;
      keyConditionExpression += " AND #sk < :sk";
    }

    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: indexName,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return (result.Items ?? []) as TItem[];
  }
}
