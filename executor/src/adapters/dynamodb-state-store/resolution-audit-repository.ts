// @akili-spec changes/cicd-executor-poc design §5.1, runbook §12.2 step 6 (LOG# audit entry), DD-25; requirements FR-17
// Audit entry of an operator target resolution: `TARGET#{lockKey}` / `LOG#RESOLUTION#{eventId}`.
// Idempotent per event id (`attribute_not_exists`): a redelivered
// TARGET_RESOLUTION_RECORDED never writes a second entry. Written BEFORE the
// `unresolved[]` removal (the service's order), so a crash leaves an audit
// entry without the removal, never the reverse.
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { targetStateKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";

export const RESOLUTION_AUDIT_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface ResolutionAuditEntry {
  readonly eventId: string;
  readonly lockKey: string;
  readonly executionId: string;
  readonly resolvedBy: string;
  /** SQS SenderId role-ID prefix of the operator principal (audit only). */
  readonly senderId?: string;
  readonly observedDigests: Readonly<Record<string, string>>;
  readonly note?: string;
  readonly at: number;
}

export class ResolutionAuditRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** `true` when this call wrote the entry, `false` when it already existed. */
  public async write(entry: ResolutionAuditEntry): Promise<boolean> {
    const key = targetStateKey(entry.lockKey);
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...entry,
            [TABLE_PK_ATTR]: key.pk,
            [TABLE_SK_ATTR]: `LOG#RESOLUTION#${entry.eventId}`,
            expiresAt: Math.floor(entry.at / 1000) + RESOLUTION_AUDIT_TTL_SECONDS,
          },
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR})`,
        }),
      ),
    );
  }
}
