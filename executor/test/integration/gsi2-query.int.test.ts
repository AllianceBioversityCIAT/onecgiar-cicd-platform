// @akili-spec changes/cicd-executor-poc design §5.1 ("the reconciler finds live items without scans"), FR-15
// Proves GSI2 (the reconciler's sparse "activeStatus + deadlineAt" index) is
// read with Query, never Scan: the repository/state-store under test receive
// ONLY a wrapped client that THROWS the moment a ScanCommand is sent.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DeployWindowRepository } from "../../src/adapters/dynamodb-state-store/deploy-window-repository.js";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { DynamoDbStateStore } from "../../src/adapters/dynamodb-state-store/state-store.js";
import { GSI2_NAME } from "../../src/adapters/dynamodb-state-store/table-schema.js";
import { createScanForbiddingClient, ScanAttemptedError } from "../support/scan-forbidding-client.js";
import { executionFixture } from "./execution-fixture.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";
import type { DeployWindowItem, ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";

describe.skipIf(!dynamoDbLocalAvailable())("GSI2 access: Query only, never Scan (DynamoDB Local)", () => {
  let realClient: DynamoDBDocumentClient;
  let guardedClient: DynamoDBDocumentClient;
  let executions: ExecutionRepository;
  let windows: DeployWindowRepository;
  let stateStore: DynamoDbStateStore;

  beforeAll(async () => {
    await ensureTestTable();
    realClient = createTestDocumentClient();
    guardedClient = createScanForbiddingClient(realClient);
    executions = new ExecutionRepository(guardedClient, testTableName());
    windows = new DeployWindowRepository(guardedClient, testTableName());
    stateStore = new DynamoDbStateStore(guardedClient, testTableName());
  });

  afterAll(() => {
    realClient?.destroy();
  });

  test("the guard itself works: a raw ScanCommand through the wrapped client throws", async () => {
    await expect(guardedClient.send(new ScanCommand({ TableName: testTableName() }))).rejects.toThrow(ScanAttemptedError);
  });

  test("queryIndex(GSI2, EXECUTION) returns live executions past a deadline, via Query", async () => {
    const deadlineAt = Date.now() + 5_000;
    const overdue = executionFixture({ status: "DEPLOYING", deadlineAt });
    const notYetDue = executionFixture({ status: "QUEUED", deadlineAt: deadlineAt + 3_600_000 });
    expect(await executions.create(overdue)).toBe(true);
    expect(await executions.create(notYetDue)).toBe(true);

    const found = await stateStore.queryIndex<ExecutionItem>(GSI2_NAME, "EXECUTION", { sortKeyBefore: deadlineAt + 1 });
    expect(found.some((item) => item.executionId === overdue.executionId)).toBe(true);
    expect(found.some((item) => item.executionId === notYetDue.executionId)).toBe(false);
  });

  test("queryIndex(GSI2, WINDOW) returns open windows past closesAt, via Query", async () => {
    const lockKey = `window-${randomUUID()}`;
    const closesAt = Date.now() + 5_000;
    expect(
      await windows.createOpen({
        lockKey,
        state: "OPEN",
        openedBy: "<OPERATOR_REF>",
        openedAt: Date.now(),
        closesAt,
        externalJobsDisabled: [],
        version: 1,
        activeStatus: "WINDOW",
        deadlineAt: closesAt,
      }),
    ).toBe(true);

    const found = await stateStore.queryIndex<DeployWindowItem>(GSI2_NAME, "WINDOW", { sortKeyBefore: closesAt + 1 });
    expect(found.some((item) => item.lockKey === lockKey)).toBe(true);
  });
});
