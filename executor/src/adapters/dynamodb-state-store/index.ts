// @akili-spec changes/cicd-executor-poc design §4.2, §5.1, §7
// DynamoDB adapter for the single table `cicd-executions-dev` (design §5.1):
// the generic `StateStore` port implementation plus one repository per item
// row of §5.1's table (no Step or Instance-lease items, no GSI1: AC-01,
// design §15.2). Creating the REAL table is Gate B, out of this task's
// scope (table-schema.ts's `buildCreateTableInput` is reused by the
// DynamoDB-Local test harness so the schema is defined exactly once).
export { createDocumentClient, type DynamoDbStateStoreConfig } from "./client.js";
export {
  GSI2_NAME,
  GSI2_PK_ATTR,
  GSI2_SK_ATTR,
  TTL_ATTR,
  buildCreateTableInput,
} from "./table-schema.js";
export * from "./keys.js";
export * from "./types.js";

export { DynamoDbStateStore } from "./state-store.js";
export {
  ExecutionRepository,
  type ExecutionTransitionExpected,
  type ExecutionUpdatePatch,
} from "./execution-repository.js";
export { RejectionRepository } from "./rejection-repository.js";
export { DedupeRepository } from "./dedupe-repository.js";
export { SequenceRepository } from "./sequence-repository.js";
export { TargetStateRepository } from "./target-state-repository.js";
export { LockRepository, type LockAcquireOutcome, LOCK_ITEM_TTL_SECONDS } from "./lock-repository.js";
export { DeployWindowRepository } from "./deploy-window-repository.js";
export { EventMarkRepository } from "./event-mark-repository.js";
