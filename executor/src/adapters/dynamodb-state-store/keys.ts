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
 * Dedupe key, scoped by deployment: `requestId` alone is unique only within a
 * repository (P-G9), so the same `requestId` under two `deploymentId`s is two
 * independent claims (CC-2, DD-20).
 */
export function dedupeKey(deploymentId: string, requestId: string): TableKey {
  return { pk: `DEDUPE#${deploymentId}#${requestId}`, sk: "DEDUPE" };
}

/**
 * Rejection record key (design §5.1). The scoped form is used when both
 * identifiers are usable; `REJECT#MSG#{sqsMessageId}` is the fallback when
 * either is missing or unusable (e.g. an unparsable body).
 */
export type RejectionRef =
  | { readonly deploymentId: string; readonly requestId: string }
  | { readonly sqsMessageId: string };

export function rejectionKey(ref: RejectionRef): TableKey {
  if ("sqsMessageId" in ref) {
    return { pk: `REJECT#MSG#${ref.sqsMessageId}`, sk: "META" };
  }
  return { pk: `REJECT#${ref.deploymentId}#${ref.requestId}`, sk: "META" };
}

export function deployWindowKey(lockKey: string): TableKey {
  return { pk: `WINDOW#${lockKey}`, sk: "WINDOW" };
}

export function sequenceKey(deploymentId: string): TableKey {
  return { pk: `DEPLOYMENT#${deploymentId}`, sk: "SEQ" };
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
