// @akili-spec changes/cicd-executor-poc design §5.1, DD-09 (forward pointer T-08.a)
// Proves the Target-state write's fencing guard is MONOTONIC: a strictly
// lower incoming `fencingToken` is rejected (a stale/superseded lock holder
// can never clobber state written by a newer one), while an equal or higher
// token is accepted — never only `>` (a single lock epoch may legitimately
// write its own state more than once).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TargetStateRepository } from "../../src/adapters/dynamodb-state-store/target-state-repository.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

describe.skipIf(!dynamoDbLocalAvailable())("TargetStateRepository (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;
  let repository: TargetStateRepository;

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
    repository = new TargetStateRepository(client, testTableName());
  });

  afterAll(() => {
    client?.destroy();
  });

  test("a strictly stale fencingToken write is rejected", async () => {
    const lockKey = `target-${randomUUID()}`;

    const firstWrite = await repository.write({
      lockKey,
      lastDeployedSequence: 10,
      updatedAt: 1_000,
      fencingToken: 5,
      currentImages: { app: "image:10" },
    });
    expect(firstWrite).toBe(true);

    const staleWrite = await repository.write({
      lockKey,
      lastDeployedSequence: 999,
      updatedAt: 2_000,
      fencingToken: 4, // strictly lower than the stored 5 — must be rejected
      currentImages: { app: "image:STALE" },
    });
    expect(staleWrite).toBe(false);

    const stored = await repository.get(lockKey);
    // The stale write must not have touched anything.
    expect(stored?.fencingToken).toBe(5);
    expect(stored?.lastDeployedSequence).toBe(10);
    expect(stored?.currentImages).toEqual({ app: "image:10" });
  });

  test("monotonic case: a write with fencingToken EQUAL to the stored one is accepted", async () => {
    const lockKey = `target-monotonic-${randomUUID()}`;

    const firstWrite = await repository.write({
      lockKey,
      lastDeployedSequence: 1,
      updatedAt: 1_000,
      fencingToken: 7,
      currentImages: { app: "image:1" },
    });
    expect(firstWrite).toBe(true);

    // SAME lock epoch (fencingToken 7) writing its state a second time
    // (e.g. currentImages now, lastDeployedSequence moments later).
    const sameEpochWrite = await repository.write({
      lockKey,
      lastDeployedSequence: 2,
      updatedAt: 2_000,
      fencingToken: 7,
      currentImages: { app: "image:1" },
    });
    expect(sameEpochWrite).toBe(true);

    const stored = await repository.get(lockKey);
    expect(stored?.lastDeployedSequence).toBe(2);
    expect(stored?.fencingToken).toBe(7);

    // A strictly HIGHER token (new lock epoch) is also accepted.
    const higherEpochWrite = await repository.write({
      lockKey,
      lastDeployedSequence: 3,
      updatedAt: 3_000,
      fencingToken: 8,
      currentImages: { app: "image:3" },
    });
    expect(higherEpochWrite).toBe(true);
  });
});
