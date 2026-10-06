// @akili-spec changes/cicd-executor-poc design DD-09; requirements FR-11
// Proves DD-09/FR-11's lock guarantees against real DynamoDB conditional
// writes: ownership (a non-owner's renew/release has no effect) and an
// expired lease becoming acquirable by someone else — never by deleting the
// row (forward pointer T-08.a).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LockRepository } from "../../src/adapters/dynamodb-state-store/lock-repository.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

describe.skipIf(!dynamoDbLocalAvailable())("LockRepository (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;
  let repository: LockRepository;

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
    repository = new LockRepository(client, testTableName());
  });

  afterAll(() => {
    client?.destroy();
  });

  test("FR-11 ownership: a non-owner's renew and release have no effect", async () => {
    const lockKey = `lock-ownership-${randomUUID()}`;
    const now = Date.now();

    const acquired = await repository.acquire(lockKey, "execution-A", now, 300);
    expect(acquired.outcome).toBe("ACQUIRED");

    const renewByStranger = await repository.renew(lockKey, "execution-B", now + 1_000, 300);
    expect(renewByStranger).toBe(false);

    const releaseByStranger = await repository.release(lockKey, "execution-B", now + 1_000);
    expect(releaseByStranger).toBe(false);

    const stillHeldByOwner = await repository.get(lockKey);
    expect(stillHeldByOwner?.owner).toBe("execution-A");
    expect(stillHeldByOwner?.leaseExpiresAt).toBeGreaterThan(now + 1_000);

    const renewByOwner = await repository.renew(lockKey, "execution-A", now + 2_000, 300);
    expect(renewByOwner).toBe(true);
  });

  test("DD-09 orphan lock: an expired lease is acquirable by a different execution, fencingToken advances, item is never deleted", async () => {
    const lockKey = `lock-expired-${randomUUID()}`;
    const now = Date.now();
    const leaseSeconds = 60;

    const firstAcquire = await repository.acquire(lockKey, "execution-A", now, leaseSeconds);
    expect(firstAcquire).toMatchObject({ outcome: "ACQUIRED", fencingToken: 1 });

    // Simulate the lease having expired: "now" advances well past leaseExpiresAt.
    const muchLater = now + (leaseSeconds + 120) * 1000;
    const secondAcquire = await repository.acquire(lockKey, "execution-B", muchLater, leaseSeconds);
    expect(secondAcquire).toMatchObject({ outcome: "ACQUIRED", fencingToken: 2 });

    const item = await repository.get(lockKey);
    expect(item).toBeDefined();
    expect(item?.owner).toBe("execution-B");
    expect(item?.fencingToken).toBe(2);
  });

  test("DD-09 release never deletes the row — fencingToken survives a release/re-acquire cycle (forward pointer T-08.a)", async () => {
    const lockKey = `lock-release-${randomUUID()}`;
    const now = Date.now();
    const leaseSeconds = 60;

    const acquired = await repository.acquire(lockKey, "execution-A", now, leaseSeconds);
    expect(acquired).toMatchObject({ outcome: "ACQUIRED", fencingToken: 1 });

    const released = await repository.release(lockKey, "execution-A", now + 1_000);
    expect(released).toBe(true);

    const afterRelease = await repository.get(lockKey);
    // The row still exists (never deleted) and still carries fencingToken 1.
    expect(afterRelease).toBeDefined();
    expect(afterRelease?.fencingToken).toBe(1);
    expect(afterRelease?.leaseExpiresAt).toBeLessThan(now + 1_000);

    const reacquired = await repository.acquire(lockKey, "execution-B", now + 2_000, leaseSeconds);
    // fencingToken continues monotonically from the PRESERVED value (2, not
    // reset to 1 as a TTL-deleted-and-recreated row would produce).
    expect(reacquired).toMatchObject({ outcome: "ACQUIRED", fencingToken: 2 });
  });
});
