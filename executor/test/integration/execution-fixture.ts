// @akili-spec changes/cicd-executor-poc design §5.1 (T-08 integration tests)
// Builds a valid Execution item with obviously fake, logical values only.
import { randomUUID } from "node:crypto";
import type { ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";

export function executionFixture(overrides: Partial<ExecutionItem> = {}): ExecutionItem {
  const now = Date.now();
  return {
    executionId: `exec-${randomUUID()}`,
    deploymentId: "<LOGICAL_DEPLOYMENT>",
    definitionRef: "<DEFINITION_REF>",
    requestId: `${String(now)}-1`,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    artifacts: { app: "sha256:<DIGEST>" },
    order: { sourceRef: "refs/heads/main", runNumber: 1, runAttempt: 1 },
    ci: { repository: "<LOGICAL_REPOSITORY_REF>", runId: String(now), workflowRef: "<WORKFLOW_REF>" },
    senderRef: "<SENDER_REF>",
    lockKey: `<LOGICAL_LOCK_KEY>-${randomUUID()}`,
    sequence: 1,
    status: "WAITING_LOCK",
    version: 1,
    attempt: 0,
    contentionCount: 0,
    lockWaitAttempts: 0,
    startedAt: now,
    deadlineAt: now + 60_000,
    activeStatus: "EXECUTION",
    expiresAt: Math.floor(now / 1000) + 180 * 24 * 60 * 60,
    ...overrides,
  };
}
