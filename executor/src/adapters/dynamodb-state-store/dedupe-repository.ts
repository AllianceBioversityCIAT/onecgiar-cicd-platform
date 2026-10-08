// @akili-spec changes/cicd-executor-poc design §5.1, DD-20; requirements FR-03, FR-07
// Repository for the Dedupe item (DD-20's leased-claim pattern). Each method
// below is one numbered step of DD-20's decision, applied as its own
// conditional write — the redelivery table (DD-20) is an application-layer
// (execution-service, a later task) concern; this repository only exposes
// the primitives that table is built from.
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dedupeKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";
import type { DedupeItem } from "./types.js";

export class DedupeRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async get(targetId: string, requestId: string): Promise<DedupeItem | undefined> {
    const key = dedupeKey(targetId, requestId);
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk } }),
    );
    return result.Item as DedupeItem | undefined;
  }

  /** DD-20 step 1: claim a brand-new `{targetId, requestId}` (`attribute_not_exists`). */
  public async claim(targetId: string, requestId: string, claimToken: string, claimLeaseExpiresAt: number, expiresAt: number): Promise<boolean> {
    const key = dedupeKey(targetId, requestId);
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            [TABLE_PK_ATTR]: key.pk,
            [TABLE_SK_ATTR]: key.sk,
            targetId,
            requestId,
            state: "CLAIMED",
            claimToken,
            claimLeaseExpiresAt,
            expiresAt,
          },
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR})`,
        }),
      ),
    );
  }

  /**
   * DD-20 "CLAIMED, lease vencido": takes over an expired claim, conditional
   * on the PREVIOUS `claimToken` still being the one stored (so only one of
   * several racing takeovers wins) — preserves `sequence`/`executionId` if
   * already set, per DD-20: an already stored sequence is reused.
   */
  public async takeOverExpiredClaim(
    targetId: string,
    requestId: string,
    previousClaimToken: string,
    newClaimToken: string,
    newClaimLeaseExpiresAt: number,
    now: number,
  ): Promise<boolean> {
    const key = dedupeKey(targetId, requestId);
    return runConditionalWrite(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          UpdateExpression: "SET #claimToken = :newToken, #claimLeaseExpiresAt = :newLease",
          ConditionExpression: "#claimToken = :previousToken AND #claimLeaseExpiresAt < :now AND #state = :claimed",
          ExpressionAttributeNames: { "#claimToken": "claimToken", "#claimLeaseExpiresAt": "claimLeaseExpiresAt", "#state": "state" },
          ExpressionAttributeValues: {
            ":previousToken": previousClaimToken,
            ":newToken": newClaimToken,
            ":newLease": newClaimLeaseExpiresAt,
            ":now": now,
            ":claimed": "CLAIMED",
          },
        }),
      ),
    );
  }

  /** DD-20 step 2: record the sequence, conditional on owning the claim and the sequence being unassigned. */
  public async recordSequence(targetId: string, requestId: string, claimToken: string, sequence: number): Promise<boolean> {
    const key = dedupeKey(targetId, requestId);
    return runConditionalWrite(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          UpdateExpression: "SET #sequence = :sequence",
          ConditionExpression: "#claimToken = :claimToken AND attribute_not_exists(#sequence)",
          ExpressionAttributeNames: { "#claimToken": "claimToken", "#sequence": "sequence" },
          ExpressionAttributeValues: { ":claimToken": claimToken, ":sequence": sequence },
        }),
      ),
    );
  }

  /** DD-20 step 4: bind the dedupe record to the created execution, conditional on owning the claim. */
  public async bind(targetId: string, requestId: string, claimToken: string, executionId: string): Promise<boolean> {
    const key = dedupeKey(targetId, requestId);
    return runConditionalWrite(() =>
      this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk },
          UpdateExpression: "SET #state = :bound, #executionId = :executionId",
          ConditionExpression: "#claimToken = :claimToken",
          ExpressionAttributeNames: { "#state": "state", "#executionId": "executionId", "#claimToken": "claimToken" },
          ExpressionAttributeValues: { ":bound": "BOUND", ":claimToken": claimToken, ":executionId": executionId },
        }),
      ),
    );
  }
}
