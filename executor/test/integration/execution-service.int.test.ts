// @akili-spec changes/cicd-executor-poc design §5.1, §7 (execution-service row), §7.3 (X1, X2, X3), DD-20; requirements FR-03, FR-07, CC-2
// The execution-service on REAL DynamoDB Local repositories (dedupe, sequence,
// execution, rejection). The catalog and the target-ordering port are in-memory
// fakes: the TARGET adapter is N-09's. The race tests release every contender
// through a barrier at the same instant (a single-threaded duplicate test would
// prove only idempotent replay, not the race the dedupe claim exists for).
import { randomUUID } from "node:crypto";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DedupeRepository } from "../../src/adapters/dynamodb-state-store/dedupe-repository.js";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { RejectionRepository } from "../../src/adapters/dynamodb-state-store/rejection-repository.js";
import { SequenceRepository } from "../../src/adapters/dynamodb-state-store/sequence-repository.js";
import { rejectionKey, sequenceKey, TABLE_PK_ATTR, TABLE_SK_ATTR } from "../../src/adapters/dynamodb-state-store/keys.js";
import {
  buildSourceRef,
  ClaimInProgressError,
  createExecutionService,
  type AcceptedDeployRequest,
  type DeploymentCatalog,
  type DeploymentInfo,
  type ExecutionService,
} from "../../src/application/execution-service/index.js";
import { createBarrier } from "../support/barrier.js";
import { FakeClock, FakeTarget } from "../support/execution-service-fakes.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const SOURCE = { repository: "example-org/example-app", workflow: "example-org/platform/.github/workflows/deploy.yml@refs/heads/main", environment: "dev" };
const SOURCE_REF = buildSourceRef(SOURCE);
const RACE_REPETITIONS = 50;
const CONTENDERS = 8;

function infoFor(deploymentId: string): DeploymentInfo {
  return { definitionRef: "<DEFINITION_REF>", lockKey: `<LOCK_KEY>-${deploymentId}`, units: ["server"], source: SOURCE };
}

const catalog: DeploymentCatalog = { getDeployment: async (deploymentId) => infoFor(deploymentId) };

function uniqueDeploymentId(): string {
  return `d-${randomUUID().slice(0, 18)}`;
}

function accepted(deploymentId: string, over: { runId?: string; runNumber?: number; artifacts?: Record<string, string> } = {}): AcceptedDeployRequest {
  const runId = over.runId ?? String(Date.now());
  return {
    senderRef: "AROA1234",
    source: { repository: SOURCE.repository, workflowRef: SOURCE.workflow },
    checks: { senderAuthorized: true, schemaValid: true, requestIdMatches: true, deploymentKnown: true, consistencyOk: true },
    request: {
      specVersion: 1,
      eventType: "DEPLOY_REQUESTED",
      requestId: `${runId}-1`,
      deploymentId,
      commitSha: "a".repeat(40),
      artifacts: over.artifacts ?? { server: DIGEST },
      ci: { repository: SOURCE.repository, workflowRef: SOURCE.workflow, runId, runAttempt: 1, runNumber: over.runNumber ?? 1 },
    },
  };
}

describe.skipIf(!dynamoDbLocalAvailable())("execution-service (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;
  let dedupe: DedupeRepository;
  let executions: ExecutionRepository;
  let rejections: RejectionRepository;
  let target: FakeTarget;
  let service: ExecutionService;
  const clock = new FakeClock(Date.now());

  async function sequenceValue(deploymentId: string): Promise<number | undefined> {
    const key = sequenceKey(deploymentId);
    const result = await client.send(
      new GetCommand({ TableName: testTableName(), Key: { [TABLE_PK_ATTR]: key.pk, [TABLE_SK_ATTR]: key.sk } }),
    );
    return (result.Item as { value: number } | undefined)?.value;
  }

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
    dedupe = new DedupeRepository(client, testTableName());
    executions = new ExecutionRepository(client, testTableName());
    rejections = new RejectionRepository(client, testTableName());
    target = new FakeTarget();
    service = createExecutionService({
      catalog,
      dedupe,
      sequences: new SequenceRepository(client, testTableName()),
      executions,
      rejections,
      target,
      clock,
    });
  });

  afterAll(() => {
    client?.destroy();
  });

  test(`parallel duplicates (${String(RACE_REPETITIONS)} reps x ${String(CONTENDERS)} contenders, barrier): exactly 1 execution and 0 extra sequence numbers (FR-07)`, async () => {
    for (let rep = 0; rep < RACE_REPETITIONS; rep += 1) {
      const deploymentId = uniqueDeploymentId();
      const request = accepted(deploymentId, { runId: String(1_000_000 + rep) });
      const arrive = createBarrier(CONTENDERS);
      const settled = await Promise.allSettled(
        Array.from({ length: CONTENDERS }, async () => {
          await arrive();
          return service.deployRequested(request);
        }),
      );

      const created = settled.filter((s) => s.status === "fulfilled" && s.value.outcome === "CREATED");
      const duplicates = settled.filter((s) => s.status === "fulfilled" && s.value.outcome === "DUPLICATE");
      const busy = settled.filter((s) => s.status === "rejected" && s.reason instanceof ClaimInProgressError);
      expect(created, `rep ${String(rep)}: exactly one winner`).toHaveLength(1);
      expect(created.length + duplicates.length + busy.length, `rep ${String(rep)}: no other outcome or error`).toBe(CONTENDERS);

      expect(await sequenceValue(deploymentId), `rep ${String(rep)}: exactly one sequence number consumed`).toBe(1);
      expect((await executions.get(`${deploymentId}-1`))?.status).toBe("QUEUED");
      for (let extra = 2; extra <= CONTENDERS + 1; extra += 1) {
        expect(await executions.get(`${deploymentId}-${String(extra)}`), `rep ${String(rep)}: no execution ${String(extra)}`).toBeUndefined();
      }
      expect(await dedupe.get(deploymentId, request.request.requestId)).toMatchObject({ state: "BOUND", sequence: 1, executionId: `${deploymentId}-1` });
    }
  }, 180_000);

  test("sequential redelivery after the race is a no-op that consumes no sequence", async () => {
    const deploymentId = uniqueDeploymentId();
    const request = accepted(deploymentId);
    expect(await service.deployRequested(request)).toMatchObject({ outcome: "CREATED", sequence: 1 });
    expect(await service.deployRequested(request)).toEqual({ outcome: "DUPLICATE", executionId: `${deploymentId}-1` });
    expect(await sequenceValue(deploymentId)).toBe(1);
  });

  test("CC-2: a foreign deployment that pre-claims the victim's requestId does not block the victim", async () => {
    const victim = uniqueDeploymentId();
    const attacker = uniqueDeploymentId();
    const requestId = `${String(Date.now())}-1`;
    const runId = requestId.slice(0, -2);
    // The attacker holds a LIVE claim on the very same requestId under its own deployment.
    expect(await dedupe.claim(attacker, requestId, "attacker-token", clock.nowMs + 120_000, Math.floor(clock.nowMs / 1000) + 604_800)).toBe(true);

    expect(await service.deployRequested(accepted(victim, { runId }))).toMatchObject({ outcome: "CREATED", executionId: `${victim}-1`, sequence: 1, status: "QUEUED" });
    expect(await executions.get(`${victim}-1`)).toMatchObject({ requestId, deploymentId: victim });
    // The attacker's own claim is untouched and its deployment consumed nothing.
    expect((await dedupe.get(attacker, requestId))?.claimToken).toBe("attacker-token");
    expect(await sequenceValue(attacker)).toBeUndefined();
  });

  test("an expired claim left by a crashed owner is taken over: the stored sequence is reused and the execution created once", async () => {
    const deploymentId = uniqueDeploymentId();
    const request = accepted(deploymentId);
    const requestId = request.request.requestId;
    expect(await dedupe.claim(deploymentId, requestId, "dead-owner", clock.nowMs - 1, Math.floor(clock.nowMs / 1000) + 604_800)).toBe(true);
    expect(await dedupe.recordSequence(deploymentId, requestId, "dead-owner", 7)).toBe(true);

    expect(await service.deployRequested(request)).toMatchObject({ outcome: "CREATED", sequence: 7, executionId: `${deploymentId}-7` });
    expect(await sequenceValue(deploymentId)).toBeUndefined(); // the counter was never touched
    expect((await dedupe.get(deploymentId, requestId))?.state).toBe("BOUND");
  });

  test("X2 unit-set mismatch writes the rejection record and consumes no sequence, claim or execution (RL-5)", async () => {
    const deploymentId = uniqueDeploymentId();
    const request = accepted(deploymentId, { artifacts: { server: DIGEST, extra: DIGEST } });
    expect(await service.deployRequested(request)).toEqual({ outcome: "REJECTED", reason: "CONSISTENCY_MISMATCH" });
    expect(await rejections.get({ deploymentId, requestId: request.request.requestId })).toMatchObject({ reason: "CONSISTENCY_MISMATCH", senderRef: "AROA1234", deploymentId });
    expect(await sequenceValue(deploymentId)).toBeUndefined();
    expect(await dedupe.get(deploymentId, request.request.requestId)).toBeUndefined();
    expect(await executions.get(`${deploymentId}-1`)).toBeUndefined();
  });

  test("a router rejection with unusable ids is keyed by the SQS message id", async () => {
    const sqsMessageId = `msg-${randomUUID()}`;
    await service.rejected({ transitionId: "X2", reason: "SCHEMA_INVALID", details: [], senderRef: "AROA1234", sqsMessageId });
    expect(await rejections.get({ sqsMessageId })).toMatchObject({ reason: "SCHEMA_INVALID", senderRef: "AROA1234" });
    expect(rejectionKey({ sqsMessageId }).pk).toBe(`REJECT#MSG#${sqsMessageId}`);
  });

  test("S1: an older request is superseded by X3 and leaves the sparse index (the real conditional write)", async () => {
    const deploymentId = uniqueDeploymentId();
    target.seed(infoFor(deploymentId).lockKey, { highestAccepted: { sourceRef: SOURCE_REF, runNumber: 10 } });
    const request = accepted(deploymentId, { runNumber: 5 });
    const outcome = await service.deployRequested(request);
    expect(outcome).toMatchObject({ outcome: "CREATED", status: "SUPERSEDED" });
    const stored = await executions.get(`${deploymentId}-1`);
    expect(stored).toMatchObject({ status: "SUPERSEDED", version: 2, error: { code: "SUPERSEDED" } });
    expect(stored).not.toHaveProperty("activeStatus");
    expect(stored).not.toHaveProperty("deadlineAt");
    // The dedupe record is BOUND, so a redelivery stays a no-op.
    expect(await service.deployRequested(request)).toMatchObject({ outcome: "DUPLICATE" });
  });
});
