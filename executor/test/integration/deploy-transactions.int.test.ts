// @akili-spec changes/cicd-executor-poc design §5.1, §7.3 (X9, X16), DD-27, DD-28; requirements FR-23
// Atomicity of the deploy coordinator's two TransactWriteItems against REAL
// DynamoDB Local: a cancelled X9 leaves NO intent behind (the Execution item
// is untouched when `highestDispatched` is refused), and X16 appends
// `unresolved[]` only together with the status change. Plus the coordinator
// end to end over the real repositories (CS-2 path a).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { LockRepository } from "../../src/adapters/dynamodb-state-store/lock-repository.js";
import { TargetStateRepository } from "../../src/adapters/dynamodb-state-store/target-state-repository.js";
import { DeployTransactions } from "../../src/adapters/dynamodb-state-store/deploy-transactions.js";
import { createDeployCoordinator, Semaphore } from "../../src/application/deploy-coordinator/index.js";
import { FakeQueue, FakeTransport, FakeWindows, TEST_SOURCE_REF, World } from "../support/deploy-coordinator-fakes.js";
import { executionFixture } from "./execution-fixture.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

describe.skipIf(!dynamoDbLocalAvailable())("deploy coordinator transactions (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;
  let executions: ExecutionRepository;
  let targets: TargetStateRepository;
  let locks: LockRepository;
  let tx: DeployTransactions;

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
    executions = new ExecutionRepository(client, testTableName());
    targets = new TargetStateRepository(client, testTableName());
    locks = new LockRepository(client, testTableName());
    tx = new DeployTransactions(client, executions, targets);
  });

  afterAll(() => {
    client?.destroy();
  });

  const stamp = (executionId: string, runNumber: number) => ({ sourceRef: TEST_SOURCE_REF, runNumber, executionId });
  const x9Patch = (deadlineAt: number) =>
    ({
      status: "DEPLOYING",
      attempt: 1,
      dispatchToken: "token-1",
      fencingToken: 1,
      execStartedAt: undefined,
      activeStatus: "EXECUTION",
      deadlineAt,
    }) as const;

  test("X9 commits the intent and highestDispatched together", async () => {
    const seed = executionFixture({ order: { sourceRef: TEST_SOURCE_REF, runNumber: 5, runAttempt: 1 } });
    await executions.create(seed);
    const out = await tx.beginDispatch({
      executionId: seed.executionId,
      expected: { status: "WAITING_LOCK", version: 1 },
      patch: x9Patch(Date.now() + 60_000),
      lockKey: seed.targetId,
      dispatched: stamp(seed.executionId, 5),
      now: Date.now(),
    });
    expect(out).toEqual({ outcome: "COMMITTED" });
    expect(await executions.get(seed.executionId)).toMatchObject({ status: "DEPLOYING", version: 2, dispatchToken: "token-1", attempt: 1 });
    expect((await targets.get(seed.targetId))?.highestDispatched).toEqual(stamp(seed.executionId, 5));
  });

  test("a refused highestDispatched cancels the WHOLE transaction: the Execution item keeps no intent (CS-2)", async () => {
    const seed = executionFixture({ order: { sourceRef: TEST_SOURCE_REF, runNumber: 5, runAttempt: 1 } });
    await executions.create(seed);
    await targets.raiseHighestDispatched(seed.targetId, stamp("exec-newer", 9), Date.now());

    const out = await tx.beginDispatch({
      executionId: seed.executionId,
      expected: { status: "WAITING_LOCK", version: 1 },
      patch: x9Patch(Date.now() + 60_000),
      lockKey: seed.targetId,
      dispatched: stamp(seed.executionId, 5),
      now: Date.now(),
    });
    expect(out).toEqual({ outcome: "TARGET_CONDITION_FAILED" });
    const after = await executions.get(seed.executionId);
    expect(after).toMatchObject({ status: "WAITING_LOCK", version: 1, attempt: 0 });
    expect(after?.dispatchToken).toBeUndefined();
    expect(after?.fencingToken).toBeUndefined();
    expect((await targets.get(seed.targetId))?.highestDispatched).toEqual(stamp("exec-newer", 9));
  });

  test("a stale Execution version cancels the transaction: highestDispatched is NOT raised", async () => {
    const seed = executionFixture();
    await executions.create(seed);
    const out = await tx.beginDispatch({
      executionId: seed.executionId,
      expected: { status: "WAITING_LOCK", version: 7 },
      patch: x9Patch(Date.now() + 60_000),
      lockKey: seed.targetId,
      dispatched: stamp(seed.executionId, 3),
      now: Date.now(),
    });
    expect(out).toEqual({ outcome: "EXECUTION_CONFLICT" });
    expect(await targets.get(seed.targetId)).toBeUndefined();
    expect(await executions.get(seed.executionId)).toMatchObject({ status: "WAITING_LOCK", version: 1 });
  });

  test("an equal run number is accepted (same execution re-entering X9 after exit 50)", async () => {
    const seed = executionFixture();
    await executions.create(seed);
    await targets.raiseHighestDispatched(seed.targetId, stamp(seed.executionId, 5), Date.now());
    const out = await tx.beginDispatch({
      executionId: seed.executionId,
      expected: { status: "WAITING_LOCK", version: 1 },
      patch: x9Patch(Date.now() + 60_000),
      lockKey: seed.targetId,
      dispatched: stamp(seed.executionId, 5),
      now: Date.now(),
    });
    expect(out).toEqual({ outcome: "COMMITTED" });
  });

  test("X16 commits UNKNOWN_TARGET_STATE and the unresolved[] append together; a conflict appends nothing", async () => {
    const seed = executionFixture({ status: "DEPLOYING", dispatchToken: "token-1", attempt: 1, execStartedAt: Date.now() });
    await executions.create(seed);
    const patch = { status: "UNKNOWN_TARGET_STATE", error: { code: "UNKNOWN_TARGET_STATE" }, activeStatus: undefined, deadlineAt: undefined, finishedAt: Date.now() } as const;

    const stale = await tx.markUnknownTargetState({
      executionId: seed.executionId,
      expected: { status: "DEPLOYING", version: 1, dispatchToken: "token-OTHER" },
      patch,
      lockKey: seed.targetId,
      entry: { executionId: seed.executionId, since: 1 },
      now: Date.now(),
    });
    expect(stale).toEqual({ outcome: "EXECUTION_CONFLICT" });
    expect((await targets.get(seed.targetId))?.unresolved).toBeUndefined();
    expect((await executions.get(seed.executionId))?.status).toBe("DEPLOYING");

    const ok = await tx.markUnknownTargetState({
      executionId: seed.executionId,
      expected: { status: "DEPLOYING", version: 1, dispatchToken: "token-1" },
      patch,
      lockKey: seed.targetId,
      entry: { executionId: seed.executionId, since: 42 },
      now: Date.now(),
    });
    expect(ok).toEqual({ outcome: "COMMITTED" });
    expect((await executions.get(seed.executionId))?.status).toBe("UNKNOWN_TARGET_STATE");
    expect((await targets.get(seed.targetId))?.unresolved).toEqual([{ executionId: seed.executionId, since: 42 }]);
  });

  test("LockRepository.acquire reports alreadyHeld: fresh and post-release acquisitions are not, a live re-entrant one is", async () => {
    const lockKey = `<LOGICAL_LOCK_KEY>-held-${String(Date.now())}`;
    const now = Date.now();
    expect(await locks.acquire(lockKey, "exec-a", now, 180)).toMatchObject({ outcome: "ACQUIRED", alreadyHeld: false });
    expect(await locks.acquire(lockKey, "exec-a", now + 1, 180)).toMatchObject({ outcome: "ACQUIRED", alreadyHeld: true, fencingToken: 1 });
    await locks.release(lockKey, "exec-a", now + 2);
    expect(await locks.acquire(lockKey, "exec-a", now + 3, 180)).toMatchObject({ outcome: "ACQUIRED", alreadyHeld: false, fencingToken: 1 });
  });

  test("coordinator over the real repositories, CS-2 (a): newer run ends UNKNOWN_TARGET_STATE, the older run is superseded at S2", async () => {
    const lockKey = `<LOGICAL_LOCK_KEY>-${String(Date.now())}`;
    const base = { targetId: lockKey, lockWaitStartedAt: Date.now(), lockWaitAttempts: 0 };
    const newer = executionFixture({ ...base, order: { sourceRef: TEST_SOURCE_REF, runNumber: 8, runAttempt: 1 } });
    const older = executionFixture({ ...base, order: { sourceRef: TEST_SOURCE_REF, runNumber: 7, runAttempt: 1 } });
    await executions.create(newer);
    await executions.create(older);

    const world = new World();
    const transport = new FakeTransport(world);
    transport.execScript = [{ kind: "EXIT", exitCode: 2 }];
    const semaphore = new Semaphore(2);
    const coordinator = createDeployCoordinator({
      executions,
      transactions: tx,
      locks,
      target: targets,
      windows: new FakeWindows(),
      transport,
      queue: new FakeQueue(world),
      clock: { now: () => new Date() },
      semaphore,
    });

    const first = await coordinator.handleLockRetry({ executionId: newer.executionId, attempt: 1 });
    expect(first).toMatchObject({ transitionId: "X16", status: "UNKNOWN_TARGET_STATE" });
    const state = await targets.get(lockKey);
    expect(state?.highestDispatched).toMatchObject({ runNumber: 8, executionId: newer.executionId });
    expect(state?.unresolved).toHaveLength(1);
    expect(state?.lastDeployed).toBeUndefined();

    // The newer run was UNKNOWN: its lock is kept until the lease expires (script may run). Expire it to let the older run reach S2.
    await locks.release(lockKey, newer.executionId, Date.now());

    const second = await coordinator.handleLockRetry({ executionId: older.executionId, attempt: 1 });
    expect(second).toMatchObject({ transitionId: "X6", status: "SUPERSEDED" });
    expect(await executions.get(older.executionId)).toMatchObject({ status: "SUPERSEDED", attempt: 0 });
    expect((await executions.get(older.executionId))?.dispatchToken).toBeUndefined();
    expect(transport.opened).toBe(1);
    expect(transport.openSessions).toBe(0);
    expect(semaphore.inUse).toBe(0);
    expect((await locks.get(lockKey))!.leaseExpiresAt).toBeLessThan(Date.now());
  });

  test("coordinator over the real repositories: exit 0 writes the fenced lastDeployed and ends SUCCEEDED", async () => {
    const lockKey = `<LOGICAL_LOCK_KEY>-ok-${String(Date.now())}`;
    const item = executionFixture({ targetId: lockKey, lockWaitStartedAt: Date.now(), lockWaitAttempts: 0, order: { sourceRef: TEST_SOURCE_REF, runNumber: 3, runAttempt: 1 } });
    await executions.create(item);
    const world = new World();
    const transport = new FakeTransport(world);
    transport.execScript = [{ kind: "EXIT", exitCode: 0, cicdResult: { status: "OK", deployedImages: { app: "<REPOSITORY_REF>@sha256:<DIGEST>" } } }];
    const semaphore = new Semaphore(2);
    const coordinator = createDeployCoordinator({
      executions,
      transactions: tx,
      locks,
      target: targets,
      windows: new FakeWindows(),
      transport,
      queue: new FakeQueue(world),
      clock: { now: () => new Date() },
      semaphore,
    });
    const out = await coordinator.handleLockRetry({ executionId: item.executionId, attempt: 1 });
    expect(out).toMatchObject({ transitionId: "X12", status: "SUCCEEDED" });
    const done = await executions.get(item.executionId);
    expect(done).toMatchObject({ status: "SUCCEEDED", attempt: 1, fencingToken: 1 });
    expect(done?.execStartedAt).toBeTypeOf("number");
    expect(done?.activeStatus).toBeUndefined();
    const state = await targets.get(lockKey);
    expect(state?.lastDeployed).toMatchObject({ runNumber: 3, executionId: item.executionId });
    expect(state?.highestDispatched).toMatchObject({ runNumber: 3 });
    expect(state?.currentImages).toEqual({ app: "<REPOSITORY_REF>@sha256:<DIGEST>" });
    expect(semaphore.inUse).toBe(0);
    expect((await locks.get(lockKey))!.leaseExpiresAt).toBeLessThan(Date.now());
  });
});
