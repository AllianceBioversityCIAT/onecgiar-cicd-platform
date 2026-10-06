// @akili-spec changes/cicd-executor-poc design §5.1; requirements FR-14
// Repository for `EVT#{eventKey}` marks — presence-only items used to avoid
// duplicating a side effect with no natural state transition of its own
// (design §5.1: only for events with no natural state transition,
// e.g. notifications already sent). `attribute_not_exists` is the only write this
// item ever needs: whichever caller creates it first "owns" the one-time
// effect; everyone else sees `false` and skips it.
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { eventMarkKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";

export class EventMarkRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** `true`: this call created the mark (do the effect). `false`: already marked (skip it). */
  public async markOnce(executionId: string, eventKey: string, expiresAt: number): Promise<boolean> {
    const key = eventMarkKey(executionId, eventKey);
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk, executionId, eventKey, expiresAt },
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR})`,
        }),
      ),
    );
  }
}
