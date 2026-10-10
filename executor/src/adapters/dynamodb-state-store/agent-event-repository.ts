// @akili-spec changes/cicd-executor-poc architecture-change-04 §5, §7, §16
// Audit of every AGENT_EVENT the Executor received for an execution (applied, duplicate, late or refused), one item
// per (dispatchToken, seq): `EXEC#{executionId}` / `AGEVT#{dispatchToken}#{seq}`. Written once (attribute_not_exists),
// so a redelivered event is recorded exactly once; it never touches the Execution item, its version or GSI2.
// Implementation note: AC-04 §5 names this audit `lateEvents[]`; one item per event is unbounded-safe and idempotent.
// Also the agent liveness item `AGENT#{agentId}` / `STATE`, written from AGENT_HEARTBEAT.
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { executionKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "./keys.js";
import { runConditionalWrite } from "./condition-error.js";

/** 180 days, like the execution item. */
const AUDIT_TTL_SECONDS = 180 * 24 * 60 * 60;

export type AgentEventDisposition = "APPLIED" | "PROGRESS" | "DUPLICATE" | "LATE" | "NOT_EVIDENCE" | "HOLD_RELEASED" | "OPERATOR_REQUIRED";

export interface AgentEventAuditEntry {
  readonly executionId: string;
  readonly dispatchToken: string;
  readonly seq: number;
  readonly phase: string;
  readonly agentId: string;
  readonly sentAt: string;
  readonly receivedAt: number;
  readonly disposition: AgentEventDisposition;
  readonly reason?: string;
  readonly exitCode?: number;
}

export interface AgentLivenessEntry {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly lastSeenAt: number;
  readonly clockOffsetMs: number;
  readonly running: readonly string[];
}

export class AgentEventRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** `true` when this call recorded the event; `false` when it was already recorded (a redelivery). */
  public async record(entry: AgentEventAuditEntry): Promise<boolean> {
    const key = executionKey(entry.executionId);
    const sk = `AGEVT#${entry.dispatchToken}#${String(entry.seq).padStart(6, "0")}`;
    return runConditionalWrite(() =>
      this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: sk, ...entry, expiresAt: Math.floor(entry.receivedAt / 1000) + AUDIT_TTL_SECONDS },
          ConditionExpression: `attribute_not_exists(${TABLE_PK_ATTR})`,
        }),
      ),
    );
  }

  /** Last heartbeat wins; never part of any state decision (§9.2: liveness only). */
  public async recordLiveness(entry: AgentLivenessEntry): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { [TABLE_PK_ATTR]: `AGENT#${entry.agentId}`, [TABLE_SK_ATTR]: "STATE", ...entry },
      }),
    );
  }
}
