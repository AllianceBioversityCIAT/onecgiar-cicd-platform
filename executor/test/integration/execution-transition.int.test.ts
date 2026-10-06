// @akili-spec changes/cicd-executor-poc design §5.1, §7.3, DD-03; requirements FR-05, FR-07
// Proves DD-03's central claim for the Execution item: a conditional write on
// `status` + `version` (+ `dispatchToken` for X10-X16) lets several concurrent
// writers race on the exact same transition and guarantees only one applies
// it, against REAL DynamoDB (Local) conditional-write semantics.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { createBarrier } from "../support/barrier.js";
import { executionFixture } from "./execution-fixture.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

const RACE_REPETITIONS = 50;
const CONCURRENT_WRITERS = 5;

describe.skipIf(!dynamoDbLocalAvailable())("ExecutionRepository.update: concurrency (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;
  let repository: ExecutionRepository;

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
    repository = new ExecutionRepository(client, testTableName());
  });

  afterAll(() => {
    client?.destroy();
  });

  /**
   * Disqualifier guard: a real barrier releases all writers at the same
   * instant, repeated RACE_REPETITIONS times; sequential writers would never
   * exercise DynamoDB's own condition arbitration. The transition keeps the
   * same `status` (a lock-wait retry bump), so `version` is the ONLY guard
   * that can arbitrate the race: removing it makes every writer win.
   */
  test(`exactly one of ${String(CONCURRENT_WRITERS)} concurrent writers applies the SAME transition, over ${String(RACE_REPETITIONS)} repetitions`, async () => {
    const winnerCounts: number[] = [];

    for (let round = 0; round < RACE_REPETITIONS; round += 1) {
      const seed = executionFixture({ status: "WAITING_LOCK", version: 1 });
      expect(await repository.create(seed)).toBe(true);

      const barrier = createBarrier(CONCURRENT_WRITERS);
      const results = await Promise.all(
        Array.from({ length: CONCURRENT_WRITERS }, (_, writerIndex) =>
          (async () => {
            await barrier();
            return repository.update(
              seed.executionId,
              { status: "WAITING_LOCK", version: 1 },
              {
                lockWaitAttempts: writerIndex + 1,
                nextAttemptAt: Date.now() + 5_000,
                activeStatus: "EXECUTION",
                deadlineAt: Date.now() + 60_000,
              },
            );
          })(),
        ),
      );
      const appliedCount = results.filter((applied) => applied).length;
      winnerCounts.push(appliedCount);
      expect(appliedCount).toBe(1);

      const stored = await repository.get(seed.executionId);
      expect(stored?.version).toBe(2);
    }

    const min = Math.min(...winnerCounts);
    const max = Math.max(...winnerCounts);
    console.log(
      `[concurrency] ${String(RACE_REPETITIONS)} rounds x ${String(CONCURRENT_WRITERS)} writers; winners per round: min=${String(min)} max=${String(max)} (expected 1 and 1)`,
    );
    expect(min).toBe(1);
    expect(max).toBe(1);
  }, 120_000);

  test("a status-changing race (X5: QUEUED to WAITING_LOCK) also has exactly one winner", async () => {
    const seed = executionFixture({ status: "QUEUED" });
    expect(await repository.create(seed)).toBe(true);
    const barrier = createBarrier(CONCURRENT_WRITERS);
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_WRITERS }, () =>
        (async () => {
          await barrier();
          return repository.update(
            seed.executionId,
            { status: "QUEUED", version: 1 },
            { status: "WAITING_LOCK", lockWaitStartedAt: Date.now(), activeStatus: "EXECUTION", deadlineAt: Date.now() + 60_000 },
          );
        })(),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repository.get(seed.executionId))?.status).toBe("WAITING_LOCK");
  });

  test("a stale expected status or version is rejected with no effect", async () => {
    const seed = executionFixture({ status: "WAITING_LOCK" });
    await repository.create(seed);
    const patch = { lockWaitAttempts: 9, activeStatus: "EXECUTION", deadlineAt: Date.now() + 1_000 } as const;

    expect(await repository.update(seed.executionId, { status: "DEPLOYING", version: 1 }, patch)).toBe(false);
    expect(await repository.update(seed.executionId, { status: "WAITING_LOCK", version: 99 }, patch)).toBe(false);
    const stored = await repository.get(seed.executionId);
    expect(stored?.version).toBe(1);
    expect(stored?.lockWaitAttempts).toBe(0);
  });

  test("DD-28: a transition guarded by dispatchToken applies only for the current attempt's token", async () => {
    const seed = executionFixture({ status: "DEPLOYING", attempt: 1, dispatchToken: "token-current" });
    await repository.create(seed);
    const patch = { execStartedAt: Date.now(), activeStatus: "EXECUTION", deadlineAt: Date.now() + 1_000 } as const;

    expect(
      await repository.update(seed.executionId, { status: "DEPLOYING", version: 1, dispatchToken: "token-stale" }, patch),
    ).toBe(false);
    expect(
      await repository.update(seed.executionId, { status: "DEPLOYING", version: 1, dispatchToken: "token-current" }, patch),
    ).toBe(true);
    const stored = await repository.get(seed.executionId);
    expect(stored?.execStartedAt).toBeDefined();
    expect(stored?.dispatchToken).toBe("token-current");
  });

  test("X14: per-attempt fields are cleared by patching them to undefined", async () => {
    const seed = executionFixture({ status: "DEPLOYING", attempt: 1, dispatchToken: "t1", execStartedAt: 123, lockLostDuringRun: true });
    await repository.create(seed);
    const applied = await repository.update(
      seed.executionId,
      { status: "DEPLOYING", version: 1, dispatchToken: "t1" },
      { status: "WAITING_LOCK", execStartedAt: undefined, lockLostDuringRun: undefined, activeStatus: "EXECUTION", deadlineAt: Date.now() + 1_000 },
    );
    expect(applied).toBe(true);
    const stored = await repository.get(seed.executionId);
    expect(stored?.execStartedAt).toBeUndefined();
    expect(stored?.lockLostDuringRun).toBeUndefined();
  });

  test("create() enforces the same GSI2 sparse rule as update()", async () => {
    await expect(repository.create(executionFixture({ status: "QUEUED", activeStatus: undefined }))).rejects.toThrow(/non-terminal/);
    await expect(repository.create(executionFixture({ status: "QUEUED", deadlineAt: undefined }))).rejects.toThrow(/non-terminal/);
    await expect(repository.create(executionFixture({ status: "REJECTED" }))).rejects.toThrow(/terminal/);
    expect(
      await repository.create(executionFixture({ status: "SUCCEEDED", activeStatus: undefined, deadlineAt: undefined })),
    ).toBe(true);
  });

  test("a patch that contradicts GSI2's sparse covenant throws before any write", async () => {
    const seed = executionFixture({ status: "DEPLOYING" });
    await repository.create(seed);
    await expect(
      repository.update(seed.executionId, { status: "DEPLOYING", version: 1 }, { status: "SUCCEEDED", activeStatus: "EXECUTION", deadlineAt: 1 }),
    ).rejects.toThrow(/terminal/);
    await expect(
      repository.update(seed.executionId, { status: "DEPLOYING", version: 1 }, { activeStatus: undefined, deadlineAt: undefined }),
    ).rejects.toThrow(/non-terminal/);
    expect((await repository.get(seed.executionId))?.version).toBe(1);
  });
});
