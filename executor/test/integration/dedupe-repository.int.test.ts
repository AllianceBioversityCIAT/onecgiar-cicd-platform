// @akili-spec changes/cicd-executor-poc design §5.1, DD-20; requirements FR-03, FR-07
// Proves the Dedupe item's conditional creation (DD-20 step 1): the first
// claim for a `requestId` succeeds; a second claim for the SAME `requestId`
// (the redelivery case FR-07 is built on) is rejected — `attribute_not_exists`
// enforced by real DynamoDB, not assumed.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DedupeRepository } from "../../src/adapters/dynamodb-state-store/dedupe-repository.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

describe.skipIf(!dynamoDbLocalAvailable())("DedupeRepository (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;
  let repository: DedupeRepository;

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
    repository = new DedupeRepository(client, testTableName());
  });

  afterAll(() => {
    client?.destroy();
  });

  test("DD-20 step 1: claiming a brand-new requestId succeeds, a second claim for the SAME requestId is rejected", async () => {
    const deploymentId = `<LOGICAL_DEPLOYMENT>-${randomUUID()}`;
    const requestId = `req-${randomUUID()}`;
    const now = Date.now();

    const firstClaim = await repository.claim(deploymentId, requestId, "claim-token-A", now + 120_000, now + 7 * 24 * 60 * 60 * 1000);
    expect(firstClaim).toBe(true);

    const secondClaim = await repository.claim(deploymentId, requestId, "claim-token-B", now + 120_000, now + 7 * 24 * 60 * 60 * 1000);
    expect(secondClaim).toBe(false);

    const stored = await repository.get(deploymentId, requestId);
    expect(stored?.claimToken).toBe("claim-token-A");
    expect(stored?.state).toBe("CLAIMED");
  });

  test("DD-20 full happy path: claim -> recordSequence -> bind, each step conditional on owning the claim", async () => {
    const deploymentId = `<LOGICAL_DEPLOYMENT>-${randomUUID()}`;
    const requestId = `req-${randomUUID()}`;
    const now = Date.now();
    const claimToken = "claim-token-owner";

    expect(await repository.claim(deploymentId, requestId, claimToken, now + 120_000, now + 7 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(await repository.recordSequence(deploymentId, requestId, claimToken, 42)).toBe(true);
    // Repeating recordSequence is NOT idempotent by itself (sequence already assigned) —
    // DD-20 step 3 handles that by deriving executionId from the stored sequence instead.
    expect(await repository.recordSequence(deploymentId, requestId, claimToken, 43)).toBe(false);

    expect(await repository.bind(deploymentId, requestId, claimToken, "exec-123")).toBe(true);

    const stored = await repository.get(deploymentId, requestId);
    expect(stored?.state).toBe("BOUND");
    expect(stored?.sequence).toBe(42);
    expect(stored?.executionId).toBe("exec-123");
  });

  test("CC-2: the dedupe key is scoped by deploymentId; the same requestId under two deployments is two independent claims", async () => {
    const requestId = `${String(Date.now())}-1`;
    const deploymentA = `<LOGICAL_DEPLOYMENT_A>-${randomUUID()}`;
    const deploymentB = `<LOGICAL_DEPLOYMENT_B>-${randomUUID()}`;
    const now = Date.now();

    expect(await repository.claim(deploymentA, requestId, "token-A", now + 120_000, now + 604_800)).toBe(true);
    expect(await repository.claim(deploymentB, requestId, "token-B", now + 120_000, now + 604_800)).toBe(true);
    // Still exclusive within ONE deployment.
    expect(await repository.claim(deploymentA, requestId, "token-A2", now + 120_000, now + 604_800)).toBe(false);

    expect((await repository.get(deploymentA, requestId))?.claimToken).toBe("token-A");
    expect((await repository.get(deploymentB, requestId))?.claimToken).toBe("token-B");
    // Binding one claim leaves the other untouched.
    expect(await repository.bind(deploymentA, requestId, "token-A", "exec-A")).toBe(true);
    expect((await repository.get(deploymentB, requestId))?.state).toBe("CLAIMED");
  });
});
