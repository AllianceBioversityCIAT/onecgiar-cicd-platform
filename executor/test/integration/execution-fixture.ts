// @akili-spec changes/cicd-executor-poc design §5.1 (T-08 integration tests); tasks R-4 (AC-02 V1: targetId + snapshot)
// Builds a valid Execution item with obviously fake, logical values only.
import { randomUUID } from "node:crypto";
import type { ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";

export function executionFixture(overrides: Partial<ExecutionItem> = {}): ExecutionItem {
  const now = Date.now();
  return {
    executionId: `exec-${randomUUID()}`,
    targetId: `it-target-${randomUUID().slice(0, 8)}`,
    targetSnapshot: {
      version: 1,
      project: "example",
      environment: "dev",
      host: "target.example.internal",
      user: "deploy",
      hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
      credentialRef: "cicd-poc/dev/example/ssh",
      deployScript: "/opt/cicd/example/deploy.sh",
      deployWindowPolicy: "not-required",
      sourceRepositoryId: "123456789",
    },
    requestId: `${String(now)}-1`,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    artifacts: { app: "sha256:<DIGEST>" },
    order: { sourceRef: "refs/heads/main", runNumber: 1, runAttempt: 1 },
    ci: { repository: "<LOGICAL_REPOSITORY_REF>", runId: String(now), workflowRef: "<WORKFLOW_REF>" },
    senderRef: "<SENDER_REF>",
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
