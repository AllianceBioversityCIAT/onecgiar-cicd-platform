// @akili-spec changes/cicd-executor-poc design §5.1, §7.7, DD-21; requirements FR-18
// Repository for the deploy-window item. Writes are conditional on `state`
// and `version` (design §5.1's Window row). Opening sets `activeStatus =
// WINDOW` + `deadlineAt = closesAt` (GSI2 indexing, §7.7); closing REMOVES
// both, so a closed window leaves the sparse index immediately.
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { deployWindowKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";
import type { DeployWindowItem } from "./types.js";

export class DeployWindowRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async get(lockKey: string): Promise<DeployWindowItem | undefined> {
    const key = deployWindowKey(lockKey);
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk } }),
    );
    return result.Item as DeployWindowItem | undefined;
  }

  /** First open for a `lockKey` with no prior window row (`attribute_not_exists`). */
  public async createOpen(item: DeployWindowItem & { readonly state: "OPEN" }): Promise<boolean> {
    const key = deployWindowKey(item.lockKey);
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR})`,
        }),
      ),
    );
  }

  /** Re-open an existing (necessarily `CLOSED`) window row. */
  public async reopen(
    lockKey: string,
    expectedVersion: number,
    patch: { readonly openedBy: string; readonly openedAt: number; readonly closesAt: number; readonly externalJobsDisabled: readonly string[]; readonly note?: string },
  ): Promise<boolean> {
    return this.writeConditionalOnState(lockKey, "CLOSED", expectedVersion, {
      state: "OPEN",
      activeStatus: "WINDOW",
      deadlineAt: patch.closesAt,
      openedBy: patch.openedBy,
      openedAt: patch.openedAt,
      closesAt: patch.closesAt,
      externalJobsDisabled: patch.externalJobsDisabled,
      note: patch.note,
      closedBy: undefined,
      closedReason: undefined,
      closedAt: undefined,
    });
  }

  /** Close an `OPEN` window — manual or by the reconciler on `closesAt < now` (§7.7). */
  public async close(
    lockKey: string,
    expectedVersion: number,
    patch: { readonly closedBy?: string; readonly closedReason: "MANUAL" | "EXPIRED"; readonly closedAt: number },
  ): Promise<boolean> {
    return this.writeConditionalOnState(lockKey, "OPEN", expectedVersion, {
      state: "CLOSED",
      activeStatus: undefined,
      deadlineAt: undefined,
      closedBy: patch.closedBy,
      closedReason: patch.closedReason,
      closedAt: patch.closedAt,
    });
  }

  private async writeConditionalOnState(
    lockKey: string,
    expectedState: "OPEN" | "CLOSED",
    expectedVersion: number,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const key = deployWindowKey(lockKey);
    const names: Record<string, string> = { "#state": "state", "#version": "version" };
    const values: Record<string, unknown> = {
      ":expectedState": expectedState,
      ":expectedVersion": expectedVersion,
      ":nextVersion": expectedVersion + 1,
    };
    const setClauses: string[] = ["#version = :nextVersion"];
    const removeClauses: string[] = [];

    for (const [field, value] of Object.entries(patch)) {
      const nameToken = `#${field}`;
      names[nameToken] = field;
      if (value === undefined) {
        removeClauses.push(nameToken);
      } else {
        const valueToken = `:${field}`;
        values[valueToken] = value;
        setClauses.push(`${nameToken} = ${valueToken}`);
      }
    }

    const updateExpressionParts = [`SET ${setClauses.join(", ")}`];
    if (removeClauses.length > 0) {
      updateExpressionParts.push(`REMOVE ${removeClauses.join(", ")}`);
    }

    return runConditionalWrite(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          UpdateExpression: updateExpressionParts.join(" "),
          ConditionExpression: "#state = :expectedState AND #version = :expectedVersion",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      ),
    );
  }
}
