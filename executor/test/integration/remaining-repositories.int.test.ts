// @akili-spec changes/cicd-executor-poc design §5.1, DD-20; requirements FR-03, FR-04, FR-05, FR-08
// Smoke coverage (against real DynamoDB Local) for the repositories not
// exercised by this task's dedicated scenario files: Execution, Sequence,
// Event mark and Rejection.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { SequenceRepository } from "../../src/adapters/dynamodb-state-store/sequence-repository.js";
import { EventMarkRepository } from "../../src/adapters/dynamodb-state-store/event-mark-repository.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";
import { RejectionRepository } from "../../src/adapters/dynamodb-state-store/rejection-repository.js";
import { executionFixture } from "./execution-fixture.js";

describe.skipIf(!dynamoDbLocalAvailable())("Remaining repositories (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
  });

  afterAll(() => {
    client?.destroy();
  });

  test("ExecutionRepository: create is attribute_not_exists, update is conditional on status + version", async () => {
    const repo = new ExecutionRepository(client, testTableName());
    const item = executionFixture({ status: "QUEUED" });

    expect(await repo.create(item)).toBe(true);
    expect(await repo.create(item)).toBe(false); // second create is a no-op

    const stale = await repo.update(item.executionId, { status: "QUEUED", version: 99 }, { activeStatus: "EXECUTION", deadlineAt: Date.now() + 1_000 });
    expect(stale).toBe(false);

    const update = await repo.update(
      item.executionId,
      { status: "QUEUED", version: 1 },
      { status: "WAITING_LOCK", activeStatus: "EXECUTION", deadlineAt: Date.now() + 1_000 },
    );
    expect(update).toBe(true);

    const stored = await repo.get(item.executionId);
    expect(stored?.status).toBe("WAITING_LOCK");
    expect(stored?.version).toBe(2);
  });

  test("SequenceRepository: ADD is atomic and monotonic across calls, keyed by deployment", async () => {
    const repo = new SequenceRepository(client, testTableName());
    const deploymentId = `<LOGICAL_DEPLOYMENT>-${randomUUID()}`;
    const otherDeployment = `<LOGICAL_DEPLOYMENT>-${randomUUID()}`;

    const first = await repo.increment(deploymentId);
    const second = await repo.increment(deploymentId);
    const third = await repo.increment(deploymentId);

    expect([first, second, third]).toEqual([1, 2, 3]);
    expect(await repo.increment(otherDeployment)).toBe(1);
  });

  test("EventMarkRepository: a notification mark is created exactly once", async () => {
    const repo = new EventMarkRepository(client, testTableName());
    const executionId = `exec-evt-${randomUUID()}`;
    const eventKey = "notify-slack-failure";

    expect(await repo.markOnce(executionId, eventKey, Date.now() + 7 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(await repo.markOnce(executionId, eventKey, Date.now() + 7 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  test("RejectionRepository: the record is created once (idempotent), TTL 30 d, keyed only by the SQS message id (AC-02 V1)", async () => {
    const repo = new RejectionRepository(client, testTableName());
    const ref = { sqsMessageId: `msg-${randomUUID()}` };
    const receivedAt = Date.now();

    expect(await repo.record(ref, { reason: "UNAUTHORIZED_SENDER", senderRef: "<SENDER_REF>", targetId: "example-app-dev", requestId: "100-1", receivedAt })).toBe(true);
    // Redelivery with a different reason must not overwrite the first record.
    expect(await repo.record(ref, { reason: "SCHEMA_INVALID", senderRef: "<SENDER_REF>", receivedAt: receivedAt + 5 })).toBe(false);

    const stored = await repo.get(ref);
    expect(stored?.reason).toBe("UNAUTHORIZED_SENDER");
    expect(stored?.receivedAt).toBe(receivedAt);
    expect(stored?.expiresAt).toBe(Math.floor(receivedAt / 1000) + 30 * 24 * 60 * 60);

    const msgRef = { sqsMessageId: `msg-${randomUUID()}` };
    expect(await repo.record(msgRef, { reason: "SCHEMA_INVALID", senderRef: "<SENDER_REF>", receivedAt })).toBe(true);
    expect(await repo.record(msgRef, { reason: "SCHEMA_INVALID", senderRef: "<SENDER_REF>", receivedAt })).toBe(false);
    expect((await repo.get(msgRef))?.targetId).toBeUndefined();
    expect((await repo.get(ref))?.targetId).toBe("example-app-dev");
  });
});
