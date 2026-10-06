// @akili-spec changes/cicd-executor-poc design §5.1, §7 (execution-service row), §7.3 (X1, X2, X3), DD-20, DD-27; requirements FR-03, FR-07, FR-21, FR-23
// One test per branch of the execution-service against in-memory fakes of its
// ports (the race itself is proven on DynamoDB Local in the integration suite).
import { describe, expect, it } from "vitest";
import {
  buildSourceRef,
  ClaimInProgressError,
  createExecutionService,
  DEDUPE_CLAIM_LEASE_MS,
  OrderingSourceMismatchError,
  QUEUED_DEADLINE_MS,
  type AcceptedDeployRequest,
  type DeploymentInfo,
} from "../../src/application/execution-service/index.js";
import {
  FakeCatalog,
  FakeClock,
  FakeDedupe,
  FakeExecutions,
  FakeRejections,
  FakeSequence,
  FakeTarget,
} from "../support/execution-service-fakes.js";

const DEPLOYMENT_ID = "example-app-dev";
const LOCK_KEY = "deployment#<EXAMPLE_TARGET>#example-app-dev-unit";
const DIGEST = `sha256:${"b".repeat(64)}`;
const SOURCE = { repository: "example-org/example-app", workflow: "example-org/platform/.github/workflows/deploy.yml@refs/heads/main", environment: "dev" };
const INFO: DeploymentInfo = { definitionRef: "<DEFINITION_REF>", lockKey: LOCK_KEY, units: ["server", "client"], source: SOURCE };
const SOURCE_REF = buildSourceRef(SOURCE);

function accepted(over: { runId?: string; runAttempt?: number; runNumber?: number; artifacts?: Record<string, string>; deploymentId?: string } = {}): AcceptedDeployRequest {
  const runId = over.runId ?? "9876543210";
  const runAttempt = over.runAttempt ?? 1;
  return {
    senderRef: "AROA1234",
    source: { repository: SOURCE.repository, workflowRef: SOURCE.workflow },
    checks: { senderAuthorized: true, schemaValid: true, requestIdMatches: true, deploymentKnown: true, consistencyOk: true },
    request: {
      specVersion: 1,
      eventType: "DEPLOY_REQUESTED",
      requestId: `${runId}-${String(runAttempt)}`,
      deploymentId: over.deploymentId ?? DEPLOYMENT_ID,
      commitSha: "a".repeat(40),
      artifacts: over.artifacts ?? { server: DIGEST, client: DIGEST },
      ci: { repository: SOURCE.repository, workflowRef: SOURCE.workflow, runId, runAttempt, runNumber: over.runNumber ?? 42 },
    },
  };
}

function setup(catalog: Record<string, DeploymentInfo> = { [DEPLOYMENT_ID]: INFO }) {
  const clock = new FakeClock();
  const dedupe = new FakeDedupe();
  const sequences = new FakeSequence();
  const executions = new FakeExecutions();
  const rejections = new FakeRejections();
  const target = new FakeTarget();
  let tokenCounter = 0;
  const service = createExecutionService({
    catalog: new FakeCatalog(catalog),
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
  it("creates a QUEUED execution with identity, order, sender and GSI2 attributes (FR-03)", async () => {
    const { service, clock, executions, dedupe, sequences } = setup();
    const outcome = await service.deployRequested(accepted());
    expect(outcome).toEqual({ outcome: "CREATED", executionId: `${DEPLOYMENT_ID}-1`, sequence: 1, status: "QUEUED" });

    const item = executions.items.get(`${DEPLOYMENT_ID}-1`);
    expect(item).toMatchObject({
      deploymentId: DEPLOYMENT_ID,
      definitionRef: "<DEFINITION_REF>",
      requestId: "9876543210-1",
      commitSha: "a".repeat(40),
      artifacts: { server: DIGEST, client: DIGEST },
      order: { sourceRef: SOURCE_REF, runNumber: 42, runAttempt: 1 },
      ci: { repository: SOURCE.repository, runId: "9876543210", workflowRef: SOURCE.workflow },
      senderRef: "AROA1234",
      lockKey: LOCK_KEY,
      sequence: 1,
      status: "QUEUED",
      version: 1,
      attempt: 0,
      contentionCount: 0,
      activeStatus: "EXECUTION",
      startedAt: clock.nowMs,
      deadlineAt: clock.nowMs + QUEUED_DEADLINE_MS,
    });
    expect(dedupe.items.get(`${DEPLOYMENT_ID}#9876543210-1`)).toMatchObject({ state: "BOUND", sequence: 1, executionId: `${DEPLOYMENT_ID}-1` });
    expect(sequences.counters.get(DEPLOYMENT_ID)).toBe(1);
  });

  it("gives distinct requests monotonic sequences and executionIds", async () => {
    const { service } = setup();
    const a = await service.deployRequested(accepted({ runId: "100", runNumber: 1 }));
    const b = await service.deployRequested(accepted({ runId: "101", runNumber: 2 }));
    expect([a, b]).toMatchObject([{ sequence: 1 }, { sequence: 2, executionId: `${DEPLOYMENT_ID}-2` }]);
  });

  it("raises highestAccepted after X1 as a separate write (E2)", async () => {
    const { service, target } = setup();
    await service.deployRequested(accepted({ runNumber: 7 }));
    expect(target.raises).toHaveLength(1);
    expect(target.raises[0]).toMatchObject({ lockKey: LOCK_KEY, value: { sourceRef: SOURCE_REF, runNumber: 7, executionId: `${DEPLOYMENT_ID}-1` }, decision: { accepted: true, reason: "ABSENT" } });
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
    expect(second).toEqual({ outcome: "DUPLICATE", executionId: `${DEPLOYMENT_ID}-1` });
    expect(sequences.counters.get(DEPLOYMENT_ID)).toBe(1);
    expect(executions.items.size).toBe(1);
    expect(target.raises).toHaveLength(1);
  });

  it("a live claim owned by another processing is not acknowledged and consumes no sequence", async () => {
    const { service, dedupe, sequences, clock, executions } = setup();
    await dedupe.claim(DEPLOYMENT_ID, "9876543210-1", "foreign", clock.nowMs + DEDUPE_CLAIM_LEASE_MS, 0);
    await expect(service.deployRequested(accepted())).rejects.toBeInstanceOf(ClaimInProgressError);
    expect(sequences.counters.size).toBe(0);
    expect(executions.items.size).toBe(0);
  });

  it("an expired claim is taken over: stored sequence reused, no new number consumed, claim bound", async () => {
    const { service, dedupe, sequences, clock, executions } = setup();
    // The dead owner recorded sequence 7 and created the execution, but never bound.
    await dedupe.claim(DEPLOYMENT_ID, "9876543210-1", "dead-owner", clock.nowMs - 1, 0);
    await dedupe.recordSequence(DEPLOYMENT_ID, "9876543210-1", "dead-owner", 7);
    const first = await service.deployRequested(accepted()); // creates over the same executionId after takeover
    expect(first).toMatchObject({ outcome: "CREATED", sequence: 7, executionId: `${DEPLOYMENT_ID}-7` });
    expect(sequences.counters.size).toBe(0); // no new number consumed
    expect(executions.items.size).toBe(1);
    expect(dedupe.items.get(`${DEPLOYMENT_ID}#9876543210-1`)).toMatchObject({ state: "BOUND", claimToken: "token-1" });
  });

  it("a takeover finding the execution already created leaves it untouched (idempotent create) and binds the claim", async () => {
    const { service, dedupe, executions } = setup();
    await service.deployRequested(accepted());
    const before = executions.items.get(`${DEPLOYMENT_ID}-1`);
    // Simulate a crash between create and bind: the dedupe record is CLAIMED, expired, with the sequence stored.
    dedupe.items.set(`${DEPLOYMENT_ID}#9876543210-1`, { deploymentId: DEPLOYMENT_ID, requestId: "9876543210-1", state: "CLAIMED", claimToken: "dead-owner", claimLeaseExpiresAt: 0, sequence: 1, expiresAt: 0 });
    expect(await service.deployRequested(accepted())).toMatchObject({ outcome: "CREATED", sequence: 1 });
    expect(executions.items.size).toBe(1);
    expect(executions.items.get(`${DEPLOYMENT_ID}-1`)).toEqual(before);
    expect(dedupe.items.get(`${DEPLOYMENT_ID}#9876543210-1`)?.state).toBe("BOUND");
  });

  it("an expired claim whose takeover is lost to another processing is not acknowledged", async () => {
    const { service, dedupe, clock, sequences } = setup();
    await dedupe.claim(DEPLOYMENT_ID, "9876543210-1", "dead-owner", clock.nowMs - 1, 0);
    dedupe.takeOverExpiredClaim = async () => false;
    await expect(service.deployRequested(accepted())).rejects.toBeInstanceOf(ClaimInProgressError);
    expect(sequences.counters.size).toBe(0);
  });

  it("losing the claim before bind (taken over) yields a no-op DUPLICATE, not a second binding", async () => {
    const { service, dedupe, target } = setup();
    dedupe.bind = async () => false;
    const outcome = await service.deployRequested(accepted());
    expect(outcome).toMatchObject({ outcome: "DUPLICATE", executionId: `${DEPLOYMENT_ID}-1` });
    expect(target.raises).toHaveLength(0);
  });
});

describe("execution-service: rejections (X2, no sequence)", () => {
  it.each([
    ["missing unit", { server: DIGEST }],
    ["extra unit", { server: DIGEST, client: DIGEST, worker: DIGEST }],
    ["wrong unit name", { server: DIGEST, other: DIGEST }],
  ])("unit-set mismatch (%s) -> X2 CONSISTENCY_MISMATCH, rejection record, no claim, no sequence, no execution (FR-03)", async (_label, artifacts) => {
    const { service, rejections, dedupe, sequences, executions } = setup();
    const outcome = await service.deployRequested(accepted({ artifacts }));
    expect(outcome).toEqual({ outcome: "REJECTED", reason: "CONSISTENCY_MISMATCH" });
    expect(rejections.items.get(`REJECT#${DEPLOYMENT_ID}#9876543210-1`)).toMatchObject({
      reason: "CONSISTENCY_MISMATCH",
      senderRef: "AROA1234",
      deploymentId: DEPLOYMENT_ID,
    });
    expect(dedupe.items.size).toBe(0);
    expect(sequences.counters.size).toBe(0);
    expect(executions.items.size).toBe(0);
  });

  it("a deployment the catalog does not know -> X2 UNKNOWN_DEPLOYMENT (defensive), no sequence", async () => {
    const { service, rejections, sequences } = setup({});
    expect(await service.deployRequested(accepted())).toEqual({ outcome: "REJECTED", reason: "UNKNOWN_DEPLOYMENT" });
    expect(rejections.items.size).toBe(1);
    expect(sequences.counters.size).toBe(0);
  });

  it("a router rejection with usable ids is stored under REJECT#{deploymentId}#{requestId} with the sender reference; a replay keeps the first", async () => {
    const { service, rejections } = setup();
    const input = { transitionId: "X2" as const, reason: "SCHEMA_INVALID" as const, details: ["x"], deploymentId: DEPLOYMENT_ID, requestId: "123-1", senderRef: "AROA1234" };
    expect(await service.rejected(input)).toBe(true);
    expect(await service.rejected({ ...input, reason: "UNAUTHORIZED_SENDER" })).toBe(false);
    expect(rejections.items.get(`REJECT#${DEPLOYMENT_ID}#123-1`)).toMatchObject({ reason: "SCHEMA_INVALID", senderRef: "AROA1234" });
  });

  it.each([
    ["no ids", {}],
    ["no requestId", { deploymentId: DEPLOYMENT_ID }],
    ["unusable requestId", { deploymentId: DEPLOYMENT_ID, requestId: "not a request id" }],
    ["unusable deploymentId", { deploymentId: "Bad Id!", requestId: "123-1" }],
  ])("a rejection with %s is stored under REJECT#MSG#{sqsMessageId}", async (_label, ids) => {
    const { service, rejections } = setup();
    await service.rejected({ transitionId: "X2", reason: "SCHEMA_INVALID", details: [], senderRef: "AROA1234", sqsMessageId: "msg-1", ...ids });
    expect([...rejections.items.keys()]).toEqual(["REJECT#MSG#msg-1"]);
  });

  it("a rejection with unusable ids and no SQS message id cannot be keyed: throws (no ack)", async () => {
    const { service } = setup();
    await expect(service.rejected({ transitionId: "X2", reason: "SCHEMA_INVALID", details: [], senderRef: "AROA1234" })).rejects.toThrow(/SQS message id/);
  });
});

describe("execution-service: S1 supersede at creation (X3, FR-23)", () => {
  it("an older request is superseded: highestAccepted raise refused (expected, error-free), X3 applied, left GSI2", async () => {
    const { service, target, executions, clock } = setup();
    target.seed(LOCK_KEY, { highestAccepted: { sourceRef: SOURCE_REF, runNumber: 10 } });
    const outcome = await service.deployRequested(accepted({ runNumber: 5 }));
    expect(outcome).toEqual({ outcome: "CREATED", executionId: `${DEPLOYMENT_ID}-1`, sequence: 1, status: "SUPERSEDED" });
    expect(target.raises[0]?.decision).toEqual({ accepted: false, reason: "STORED_IS_NEWER" });
    const item = executions.items.get(`${DEPLOYMENT_ID}-1`);
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

  it("an ordering value of another source fails safe (throws, nothing compared, execution left QUEUED)", async () => {
    const { service, target, executions } = setup();
    target.seed(LOCK_KEY, { highestAccepted: { sourceRef: "other-source", runNumber: 1 } });
    await expect(service.deployRequested(accepted())).rejects.toBeInstanceOf(OrderingSourceMismatchError);
    expect(executions.items.get(`${DEPLOYMENT_ID}-1`)?.status).toBe("QUEUED");
  });
});

describe("buildSourceRef (DD-27)", () => {
  it("is deterministic and distinguishes repository, workflow and environment", () => {
    expect(buildSourceRef(SOURCE)).toBe(buildSourceRef({ ...SOURCE }));
    expect(buildSourceRef(SOURCE)).not.toBe(buildSourceRef({ ...SOURCE, environment: "prod" }));
    expect(buildSourceRef(SOURCE)).not.toBe(buildSourceRef({ ...SOURCE, workflow: "other" }));
    expect(buildSourceRef(SOURCE)).not.toBe(buildSourceRef({ ...SOURCE, repository: "other" }));
  });

  it("is injective: separators inside values cannot make two triples collide", () => {
    const a = buildSourceRef({ repository: "a;workflow=b", workflow: "c", environment: "d" });
    const b = buildSourceRef({ repository: "a", workflow: "b;workflow=c", environment: "d" });
    expect(a).not.toBe(b);
  });
});
