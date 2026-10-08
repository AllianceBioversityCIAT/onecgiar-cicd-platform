// @akili-spec changes/cicd-executor-poc design §5.1
// PK/SK builders for the single table `cicd-executions-dev` (design §5.1's
// item table). One function per row of that table — centralizing the key
// shape here means every repository (and the table-schema's key attribute
// names) agree on it by construction instead of by convention.

export const TABLE_PK_ATTR = "pk";
export const TABLE_SK_ATTR = "sk";

export interface TableKey {
  readonly pk: string;
  readonly sk: string;
}

export function executionKey(executionId: string): TableKey {
  return { pk: `EXEC#${executionId}`, sk: "META" };
}

/**
 * Dedupe key, scoped by target (AC-02 V1, design §1.2): `requestId` alone is
 * unique only within a repository (P-G9), so the same `requestId` under two
 * targets is two independent claims (CC-2, DD-20).
 */
export function dedupeKey(targetId: string, requestId: string): TableKey {
  return { pk: `DEDUPE#${targetId}#${requestId}`, sk: "DEDUPE" };
}

/**
 * Rejection record key (design §5.1, §6.3). AC-02 V1: every DEPLOY_REQUESTED
 * rejection is recorded under the SQS message identity, so a rejected request
 * never writes an item keyed by a target or its `requestId`.
 */
export interface RejectionRef {
  readonly sqsMessageId: string;
}

export function rejectionKey(ref: RejectionRef): TableKey {
  return { pk: `REJECT#MSG#${ref.sqsMessageId}`, sk: "META" };
}

export function deployWindowKey(lockKey: string): TableKey {
  return { pk: `WINDOW#${lockKey}`, sk: "WINDOW" };
}

export function sequenceKey(targetId: string): TableKey {
  return { pk: `DEPLOYMENT#${targetId}`, sk: "SEQ" };
}

export function targetStateKey(lockKey: string): TableKey {
  return { pk: `TARGET#${lockKey}`, sk: "STATE" };
}

export function lockKeyOf(lockKey: string): TableKey {
  return { pk: `LOCK#${lockKey}`, sk: "LOCK" };
}

export function eventMarkKey(executionId: string, eventKey: string): TableKey {
  return { pk: `EXEC#${executionId}`, sk: `EVT#${eventKey}` };
}
