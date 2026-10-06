// @akili-spec changes/cicd-executor-poc design §5.1, §7.3, §7.7
// Proves GSI2's sparse-index covenant: `activeStatus`/`deadlineAt` are
// removed the instant an Execution reaches a terminal status, and the instant a
// deploy Window closes — so a terminal step or a closed window can never
// show up in a reconciler GSI2 `Query` again (design §5.1: the attribute is
// removed on terminal states and on window closure).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeployWindowRepository } from "../../src/adapters/dynamodb-state-store/deploy-window-repository.js";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { executionFixture } from "./execution-fixture.js";
import { DynamoDbStateStore } from "../../src/adapters/dynamodb-state-store/state-store.js";
import { GSI2_NAME } from "../../src/adapters/dynamodb-state-store/table-schema.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";
import type { DeployWindowItem, ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";

describe.skipIf(!dynamoDbLocalAvailable())("GSI2 sparse-index removal (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;
  let executionRepository: ExecutionRepository;
  let windowRepository: DeployWindowRepository;
  let stateStore: DynamoDbStateStore;

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
    executionRepository = new ExecutionRepository(client, testTableName());
    windowRepository = new DeployWindowRepository(client, testTableName());
    stateStore = new DynamoDbStateStore(client, testTableName());
  });

  afterAll(() => {
    client?.destroy();
  });

  test("an execution reaching a terminal status (X13 SUCCEEDED) removes activeStatus and deadlineAt from GSI2", async () => {
    const deadlineAt = Date.now() + 5_000;
    const seed = executionFixture({ status: "DEPLOYING", attempt: 1, dispatchToken: "t1", deadlineAt });
    expect(await executionRepository.create(seed)).toBe(true);

    const beforeTerminal = await stateStore.queryIndex<ExecutionItem>(GSI2_NAME, "EXECUTION", { sortKeyBefore: deadlineAt + 1 });
    expect(beforeTerminal.some((item) => item.executionId === seed.executionId)).toBe(true);

    const applied = await executionRepository.update(
      seed.executionId,
      { status: "DEPLOYING", version: 1, dispatchToken: "t1" },
      { status: "SUCCEEDED", finishedAt: Date.now(), activeStatus: undefined, deadlineAt: undefined },
    );
    expect(applied).toBe(true);

    const stored = await executionRepository.get(seed.executionId);
    expect(stored?.status).toBe("SUCCEEDED");
    expect(stored?.activeStatus).toBeUndefined();
    expect(stored?.deadlineAt).toBeUndefined();

    const afterTerminal = await stateStore.queryIndex<ExecutionItem>(GSI2_NAME, "EXECUTION", { sortKeyBefore: deadlineAt + 1 });
    expect(afterTerminal.some((item) => item.executionId === seed.executionId)).toBe(false);
  });

  test("closing an OPEN deploy window removes activeStatus/deadlineAt (§7.7's indexed reconciliation)", async () => {
    const lockKey = `window-${randomUUID()}`;
    const closesAt = Date.now() + 5_000;

    const opened = await windowRepository.createOpen({
      lockKey,
      state: "OPEN",
      openedBy: "operator-1",
      openedAt: Date.now(),
      closesAt,
      externalJobsDisabled: [],
      version: 1,
      activeStatus: "WINDOW",
      deadlineAt: closesAt,
    });
    expect(opened).toBe(true);

    const beforeClose = await stateStore.queryIndex<DeployWindowItem>(GSI2_NAME, "WINDOW", { sortKeyBefore: closesAt + 1 });
    expect(beforeClose.some((item) => item.lockKey === lockKey)).toBe(true);

    const closed = await windowRepository.close(lockKey, 1, { closedReason: "MANUAL", closedAt: Date.now(), closedBy: "operator-1" });
    expect(closed).toBe(true);

    const stored = await windowRepository.get(lockKey);
    expect(stored?.state).toBe("CLOSED");
    expect(stored?.activeStatus).toBeUndefined();
    expect(stored?.deadlineAt).toBeUndefined();

    const afterClose = await stateStore.queryIndex<DeployWindowItem>(GSI2_NAME, "WINDOW", { sortKeyBefore: closesAt + 1 });
    expect(afterClose.some((item) => item.lockKey === lockKey)).toBe(false);
  });
});
