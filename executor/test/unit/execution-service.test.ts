// @akili-spec changes/cicd-executor-poc design §1.2, §5.1, §6.3, §7 (execution-service row), §7.3 (X1, X2, X3), DD-20, DD-27; requirements FR-02, FR-03, FR-07, FR-21, FR-23; tasks R-4 (AC-02 V1)
// One test per branch of the execution-service against in-memory fakes of its
// ports (the race itself is proven on DynamoDB Local in the integration suite).
// AC-02 V1: no Deployment Definitions; the request names a targetId, the router
// hands over the validated target record, and the execution stores its snapshot.
import { describe, expect, it } from "vitest";
import {
  buildSourceRef,
  ClaimInProgressError,
  createExecutionService,
  DEDUPE_CLAIM_LEASE_MS,
  OrderingSourceMismatchError,
  QUEUED_DEADLINE_MS,
  type AcceptedDeployRequest,
} from "../../src/application/execution-service/index.js";
import type { TargetRecord } from "../../src/ports/target-registry.js";
import {
  FakeClock,
  FakeDedupe,
  FakeExecutions,
  FakeRejections,
  FakeSequence,
  FakeTarget,
} from "../support/execution-service-fakes.js";

const TARGET_ID = "example-app-dev";
const LOCK_KEY = TARGET_ID; // V1: the lock key is the targetId (design §1.2)
const DIGEST = `sha256:${"b".repeat(64)}`;
const SOURCE = { repository: "example-org/example-app", workflow: "example-org/example-app/.github/workflows/deploy.yml@refs/heads/main" };
const SOURCE_REF = buildSourceRef(SOURCE);

const TARGET: TargetRecord = {
  targetId: TARGET_ID,
  project: "example",
  environment: "dev",
  host: "target.example.internal",
  port: 2222,
  user: "deploy",
  hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
  credentialRef: "cicd-poc/dev/example-app-dev/ssh",
  deployScript: "/opt/cicd/example-app/deploy.sh",
  deployWindowPolicy: "required",
  sourceRepositoryId: "123456789",
  schemaVersion: 1,
  version: 4,
  updatedAt: "2026-10-07T12:00:00Z",
  updatedBy: "platform-admin",
};

function accepted(over: { runId?: string; runAttempt?: number; runNumber?: number; artifacts?: Record<string, string>; targetId?: string; workflowRef?: string } = {}): AcceptedDeployRequest {
  const runId = over.runId ?? "9876543210";
  const runAttempt = over.runAttempt ?? 1;
  const targetId = over.targetId ?? TARGET_ID;
  return {
    senderRef: "AROA1234",
    target: { ...TARGET, targetId },
    checks: { senderAuthorized: true, schemaValid: true, requestIdMatches: true, targetKnown: true, targetValid: true, sourceAuthorized: true },
    request: {
      specVersion: 1,
      eventType: "DEPLOY_REQUESTED",
      requestId: `${runId}-${String(runAttempt)}`,
      targetId,
      commitSha: "a".repeat(40),
      artifacts: over.artifacts ?? { server: DIGEST, client: DIGEST },
      ci: { repository: SOURCE.repository, workflowRef: over.workflowRef ?? SOURCE.workflow, runId, runAttempt, runNumber: over.runNumber ?? 42 },
    },
  };
}

function setup() {
  const clock = new FakeClock();
  const dedupe = new FakeDedupe();
  const sequences = new FakeSequence();
  const executions = new FakeExecutions();
  const rejections = new FakeRejections();
  const target = new FakeTarget();
  let tokenCounter = 0;
  const service = createExecutionService({
    dedupe,
    sequences,
    executions,
    rejections,
    target,
    clock,
    newClaimToken: () => `token-${String(++tokenCounter)}`,
  });
  return { service, clock, dedupe, sequences, executions, rejections, target };
}

describe("execution-service: creation (X1)", () => {
  it("creates a QUEUED execution with identity, snapshot, order, sender and GSI2 attributes (FR-03, design §5.1)", async () => {
    const { service, clock, executions, dedupe, sequences } = setup();
    const outcome = await service.deployRequested(accepted());
    expect(outcome).toEqual({ outcome: "CREATED", executionId: `${TARGET_ID}-1`, sequence: 1, status: "QUEUED" });

    const item = executions.items.get(`${TARGET_ID}-1`);
    expect(item).toMatchObject({
      targetId: TARGET_ID,
      targetSnapshot: {
        version: 4,
        project: "example",
        environment: "dev",
        host: "target.example.internal",
        port: 2222,
        user: "deploy",
        hostKey: TARGET.hostKey,
        credentialRef: "cicd-poc/dev/example-app-dev/ssh",
        deployScript: "/opt/cicd/example-app/deploy.sh",
        deployWindowPolicy: "required",
        sourceRepositoryId: "123456789",
      },
      requestId: "9876543210-1",
      commitSha: "a".repeat(40),
      artifacts: { server: DIGEST, client: DIGEST },
      order: { sourceRef: SOURCE_REF, runNumber: 42, runAttempt: 1 },
      ci: { repository: SOURCE.repository, runId: "9876543210", workflowRef: SOURCE.workflow },
      senderRef: "AROA1234",
      sequence: 1,
      status: "QUEUED",
      version: 1,
      attempt: 0,
      contentionCount: 0,
      activeStatus: "EXECUTION",
      startedAt: clock.nowMs,
      deadlineAt: clock.nowMs + QUEUED_DEADLINE_MS,
    });
    expect(item).not.toHaveProperty("deploymentId");
    expect(item).not.toHaveProperty("definitionRef");
    expect(item).not.toHaveProperty("lockKey");
    expect(JSON.stringify(item)).not.toContain("updatedBy");
    expect(dedupe.items.get(`${TARGET_ID}#9876543210-1`)).toMatchObject({ state: "BOUND", sequence: 1, executionId: `${TARGET_ID}-1` });
    expect(sequences.counters.get(TARGET_ID)).toBe(1);
  });

  it("the snapshot is a copy: changing the record object afterwards never changes the stored execution", async () => {
    const { service, executions } = setup();
    const input = accepted();
    const target = { ...input.target, hostKey: [...input.target.hostKey] };
    const before = [...target.hostKey];
    await service.deployRequested({ ...input, target });
    target.hostKey.push("tampered");
    expect(executions.items.get(`${TARGET_ID}-1`)?.targetSnapshot.hostKey).toEqual(before);
  });

  it("an absent port stays absent in the snapshot (22 is applied by the transport)", async () => {
    const { service, executions } = setup();
    const input = accepted();
    const noPort = Object.fromEntries(Object.entries(input.target).filter(([key]) => key !== "port")) as unknown as TargetRecord;
    await service.deployRequested({ ...input, target: noPort });
    expect(executions.items.get(`${TARGET_ID}-1`)?.targetSnapshot).not.toHaveProperty("port");
  });

  it("dedupe and sequence are scoped by targetId: the same requestId on two targets is two executions", async () => {
    const { service } = setup();
    const a = await service.deployRequested(accepted());
    const b = await service.deployRequested(accepted({ targetId: "other-app-dev" }));
    expect([a, b]).toMatchObject([{ outcome: "CREATED", executionId: `${TARGET_ID}-1` }, { outcome: "CREATED", executionId: "other-app-dev-1" }]);
  });

  it("gives distinct requests monotonic sequences and executionIds", async () => {
    const { service } = setup();
    const a = await service.deployRequested(accepted({ runId: "100", runNumber: 1 }));
    const b = await service.deployRequested(accepted({ runId: "101", runNumber: 2 }));
    expect([a, b]).toMatchObject([{ sequence: 1 }, { sequence: 2, executionId: `${TARGET_ID}-2` }]);
  });

  it("raises highestAccepted after X1 as a separate write (E2)", async () => {
    const { service, target } = setup();
    await service.deployRequested(accepted({ runNumber: 7 }));
    expect(target.raises).toHaveLength(1);
    expect(target.raises[0]).toMatchObject({ lockKey: LOCK_KEY, value: { sourceRef: SOURCE_REF, runNumber: 7, executionId: `${TARGET_ID}-1` }, decision: { accepted: true, reason: "ABSENT" } });
  });

  it("an equal runNumber (re-run of the same run) is not older: stays QUEUED", async () => {
    const { service, target } = setup();
    target.seed(LOCK_KEY, { highestAccepted: { sourceRef: SOURCE_REF, runNumber: 42 }, lastDeployed: { sourceRef: SOURCE_REF, runNumber: 42 } });
    const outcome = await service.deployRequested(accepted({ runNumber: 42, runAttempt: 2 }));
    expect(outcome).toMatchObject({ outcome: "CREATED", status: "QUEUED" });
  });
});

describe("execution-service: duplicates (FR-07, DD-20)", () => {
  it("a redelivered request (dedupe BOUND) is a no-op: no sequence, no second execution, no writes", async () => {
    const { service, sequences, executions, target } = setup();
    await service.deployRequested(accepted());
    const second = await service.deployRequested(accepted());
    expect(second).toEqual({ outcome: "DUPLICATE", executionId: `${TARGET_ID}-1` });
    expect(sequences.counters.get(TARGET_ID)).toBe(1);
    expect(executions.items.size).toBe(1);
    expect(target.raises).toHaveLength(1);
  });

  it("a live claim owned by another processing is not acknowledged and consumes no sequence", async () => {
    const { service, dedupe, sequences, clock, executions } = setup();
    await dedupe.claim(TARGET_ID, "9876543210-1", "foreign", clock.nowMs + DEDUPE_CLAIM_LEASE_MS, 0);
    await expect(service.deployRequested(accepted())).rejects.toBeInstanceOf(ClaimInProgressError);
    expect(sequences.counters.size).toBe(0);
    expect(executions.items.size).toBe(0);
  });

  it("an expired claim is taken over: stored sequence reused, no new number consumed, claim bound", async () => {
    const { service, dedupe, sequences, clock, executions } = setup();
    // The dead owner recorded sequence 7 and created the execution, but never bound.
    await dedupe.claim(TARGET_ID, "9876543210-1", "dead-owner", clock.nowMs - 1, 0);
    await dedupe.recordSequence(TARGET_ID, "9876543210-1", "dead-owner", 7);
    const first = await service.deployRequested(accepted()); // creates over the same executionId after takeover
    expect(first).toMatchObject({ outcome: "CREATED", sequence: 7, executionId: `${TARGET_ID}-7` });
    expect(sequences.counters.size).toBe(0); // no new number consumed
    expect(executions.items.size).toBe(1);
    expect(dedupe.items.get(`${TARGET_ID}#9876543210-1`)).toMatchObject({ state: "BOUND", claimToken: "token-1" });
  });

  it("a takeover finding the execution already created leaves it untouched (idempotent create) and binds the claim", async () => {
    const { service, dedupe, executions } = setup();
    await service.deployRequested(accepted());
    const before = executions.items.get(`${TARGET_ID}-1`);
    // Simulate a crash between create and bind: the dedupe record is CLAIMED, expired, with the sequence stored.
    dedupe.items.set(`${TARGET_ID}#9876543210-1`, { targetId: TARGET_ID, requestId: "9876543210-1", state: "CLAIMED", claimToken: "dead-owner", claimLeaseExpiresAt: 0, sequence: 1, expiresAt: 0 });
    expect(await service.deployRequested(accepted())).toMatchObject({ outcome: "CREATED", sequence: 1 });
    expect(executions.items.size).toBe(1);
    expect(executions.items.get(`${TARGET_ID}-1`)).toEqual(before);
    expect(dedupe.items.get(`${TARGET_ID}#9876543210-1`)?.state).toBe("BOUND");
  });

  it("an expired claim whose takeover is lost to another processing is not acknowledged", async () => {
    const { service, dedupe, clock, sequences } = setup();
    await dedupe.claim(TARGET_ID, "9876543210-1", "dead-owner", clock.nowMs - 1, 0);
    dedupe.takeOverExpiredClaim = async () => false;
    await expect(service.deployRequested(accepted())).rejects.toBeInstanceOf(ClaimInProgressError);
    expect(sequences.counters.size).toBe(0);
  });

  it("losing the claim before bind (taken over) yields a no-op DUPLICATE, not a second binding", async () => {
    const { service, dedupe, target } = setup();
    dedupe.bind = async () => false;
    const outcome = await service.deployRequested(accepted());
    expect(outcome).toMatchObject({ outcome: "DUPLICATE", executionId: `${TARGET_ID}-1` });
    expect(target.raises).toHaveLength(0);
  });
});

describe("execution-service: rejections (X2, REJECT#MSG#, no sequence)", () => {
  it("a router rejection is stored under REJECT#MSG#{sqsMessageId} with the audit ids and sender; a replay keeps the first", async () => {
    const { service, rejections, dedupe, sequences } = setup();
    const input = { transitionId: "X2" as const, reason: "TARGET_NOT_AUTHORIZED" as const, details: ["x"], targetId: TARGET_ID, requestId: "123-1", senderRef: "AROA1234", sqsMessageId: "msg-1" };
    expect(await service.rejected(input)).toBe(true);
    expect(await service.rejected({ ...input, reason: "UNAUTHORIZED_SENDER" })).toBe(false);
    expect([...rejections.items.keys()]).toEqual(["REJECT#MSG#msg-1"]);
    expect(rejections.items.get("REJECT#MSG#msg-1")).toMatchObject({ reason: "TARGET_NOT_AUTHORIZED", senderRef: "AROA1234", targetId: TARGET_ID, requestId: "123-1" });
    expect(dedupe.items.size).toBe(0);
    expect(sequences.counters.size).toBe(0);
  });

  it.each(["TARGET_UNKNOWN", "TARGET_INVALID", "TARGET_NOT_AUTHORIZED", "SCHEMA_INVALID", "UNAUTHORIZED_SENDER", "REQUEST_ID_MISMATCH"] as const)(
    "a %s rejection never writes an item keyed by the target or its requestId",
    async (reason) => {
      const { service, rejections } = setup();
      await service.rejected({ transitionId: "X2", reason, details: [], targetId: TARGET_ID, requestId: "123-1", senderRef: "AROA1234", sqsMessageId: "msg-9" });
      expect([...rejections.items.keys()]).toEqual(["REJECT#MSG#msg-9"]);
    },
  );
});

describe("execution-service: S1 supersede at creation (X3, FR-23)", () => {
  it("an older request is superseded: highestAccepted raise refused (expected, error-free), X3 applied, left GSI2", async () => {
    const { service, target, executions, clock } = setup();
    target.seed(LOCK_KEY, { highestAccepted: { sourceRef: SOURCE_REF, runNumber: 10 } });
    const outcome = await service.deployRequested(accepted({ runNumber: 5 }));
    expect(outcome).toEqual({ outcome: "CREATED", executionId: `${TARGET_ID}-1`, sequence: 1, status: "SUPERSEDED" });
    expect(target.raises[0]?.decision).toEqual({ accepted: false, reason: "STORED_IS_NEWER" });
    const item = executions.items.get(`${TARGET_ID}-1`);
    expect(item).toMatchObject({ status: "SUPERSEDED", version: 2, error: { code: "SUPERSEDED" }, finishedAt: clock.nowMs });
    expect(item).not.toHaveProperty("activeStatus");
    expect(item).not.toHaveProperty("deadlineAt");
    expect(target.states.get(LOCK_KEY)?.highestAccepted?.runNumber).toBe(10); // not lowered
  });

  it.each(["lastDeployed", "highestDispatched"] as const)("a request older than %s is superseded even when highestAccepted accepts it", async (attribute) => {
    const { service, target } = setup();
    target.seed(LOCK_KEY, { [attribute]: { sourceRef: SOURCE_REF, runNumber: 50 } });
    expect(await service.deployRequested(accepted({ runNumber: 49 }))).toMatchObject({ status: "SUPERSEDED" });
  });

  it("a newer request raises highestAccepted and stays QUEUED", async () => {
    const { service, target } = setup();
    target.seed(LOCK_KEY, { highestAccepted: { sourceRef: SOURCE_REF, runNumber: 10 } });
    expect(await service.deployRequested(accepted({ runNumber: 11 }))).toMatchObject({ status: "QUEUED" });
    expect(target.states.get(LOCK_KEY)?.highestAccepted?.runNumber).toBe(11);
  });

  it("the ordering source is the request's ci.repository + ci.workflowRef (audit, V1-R2)", async () => {
    const { service, target } = setup();
    await service.deployRequested(accepted({ runNumber: 3 }));
    expect(target.raises[0]?.value.sourceRef).toBe(SOURCE_REF);
  });

  it("an ordering value of another source fails safe (throws, nothing compared, execution left QUEUED)", async () => {
    const { service, target, executions } = setup();
    target.seed(LOCK_KEY, { highestAccepted: { sourceRef: "other-source", runNumber: 1 } });
    await expect(service.deployRequested(accepted())).rejects.toBeInstanceOf(OrderingSourceMismatchError);
    expect(executions.items.get(`${TARGET_ID}-1`)?.status).toBe("QUEUED");
  });
});

describe("buildSourceRef (DD-27, V1)", () => {
  it("is deterministic and distinguishes repository and workflow", () => {
    expect(buildSourceRef(SOURCE)).toBe(buildSourceRef({ ...SOURCE }));
    expect(buildSourceRef(SOURCE)).not.toBe(buildSourceRef({ ...SOURCE, workflow: "other" }));
    expect(buildSourceRef(SOURCE)).not.toBe(buildSourceRef({ ...SOURCE, repository: "other" }));
  });

  it("is injective: separators inside values cannot make two pairs collide", () => {
    const a = buildSourceRef({ repository: "a;workflow=b", workflow: "c" });
    const b = buildSourceRef({ repository: "a", workflow: "b;workflow=c" });
    expect(a).not.toBe(b);
  });
});
