// @akili-spec changes/cicd-executor-poc design §5.1 (GSI2: Query only), §7 (reconciler row), §7.3 (X7 canonical, X11, X16, CW-2), §7.7; requirements FR-15, FR-17
// The reconciler against REAL DynamoDB Local. Every store it touches receives
// the scan-forbidding client, so the two GSI2 queries per tick are PROVEN to be
// Queries. The X7 race runs the real lock-retry handler and the real reconciler
// over the same item: exactly one conditional write wins, with an identical
// result.
//
// Isolation: the fake clock sits in 1970 (T), so only items seeded here (with
// deadlines just below T) are overdue; items other test files create live at
// real-now deadlines and are never found by this clock.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeployWindowRepository } from "../../src/adapters/dynamodb-state-store/deploy-window-repository.js";
import { DeployTransactions } from "../../src/adapters/dynamodb-state-store/deploy-transactions.js";
import { ExecutionRepository } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import { DynamoDbStateStore } from "../../src/adapters/dynamodb-state-store/state-store.js";
import { TargetStateRepository } from "../../src/adapters/dynamodb-state-store/target-state-repository.js";
import { createDeployCoordinator, Semaphore } from "../../src/application/deploy-coordinator/index.js";
import { createReconciler, type Reconciler } from "../../src/application/reconciler/index.js";
import { createMetrics } from "../../src/observability/metrics/index.js";
import type { ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";
import {
  FakeLocks,
  FakePlans,
  FakeQueue,
  FakeTarget,
  FakeTransactions,
  FakeTransport,
  FakeWindows,
  World,
} from "../support/deploy-coordinator-fakes.js";
import { createScanForbiddingClient } from "../support/scan-forbidding-client.js";
import { executionFixture } from "./execution-fixture.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

/** Fake "now": 1970, far below any real deadline other test files write. */
const T = 3_000_000_000;

describe.skipIf(!dynamoDbLocalAvailable())("reconciler (DynamoDB Local)", () => {
  let realClient: DynamoDBDocumentClient;
  let client: DynamoDBDocumentClient;
  let executions: ExecutionRepository;
  let targets: TargetStateRepository;
  let windows: DeployWindowRepository;
  let world: World;
  let metricLines: string[];
  let reconciler: Reconciler;
  let coordinator: ReturnType<typeof createDeployCoordinator>;

  beforeAll(async () => {
    await ensureTestTable();
    realClient = createTestDocumentClient();
    client = createScanForbiddingClient(realClient);
    executions = new ExecutionRepository(client, testTableName());
    targets = new TargetStateRepository(client, testTableName());
    windows = new DeployWindowRepository(client, testTableName());
  });

  afterAll(() => {
    realClient?.destroy();
  });

  /** Fresh fakes for the ports the tested paths do not reach, and a fresh reconciler, per test. */
  function build(): void {
    world = new World();
    world.clock.nowMs = T;
    metricLines = [];
    const queue = new FakeQueue(world);
    coordinator = createDeployCoordinator({
      executions,
      transactions: new FakeTransactions(world),
      locks: new FakeLocks(world),
      target: new FakeTarget(world),
      windows: new FakeWindows(),
      plans: new FakePlans(),
      transport: new FakeTransport(world),
      queue,
      clock: world.clock,
      semaphore: new Semaphore(1),
    });
    reconciler = createReconciler({
      index: new DynamoDbStateStore(client, testTableName()),
      executions,
      transactions: new DeployTransactions(client, executions, targets),
      windows,
      target: targets,
      coordinator,
      queue,
      metrics: createMetrics({ sink: { write: (line) => metricLines.push(line) }, clock: world.clock }),
      clock: world.clock,
    });
  }

  const seed = async (over: Partial<ExecutionItem>): Promise<ExecutionItem> => {
    const item = executionFixture({ deadlineAt: T - 1_000, ...over });
    expect(await executions.create(item)).toBe(true);
    return item;
  };

  /** The fields an X7 write determines (identity and seed-time fields differ between two seeded items). */
  const outcomeOf = (item: ExecutionItem | undefined): Record<string, unknown> => ({
    status: item?.status,
    error: item?.error,
    attempt: item?.attempt,
    contentionCount: item?.contentionCount,
    version: item?.version,
    activeStatus: item?.activeStatus,
    deadlineAt: item?.deadlineAt,
    lockWaitStartedAt: item?.lockWaitStartedAt,
    lockWaitAttempts: item?.lockWaitAttempts,
    nextAttemptAt: item?.nextAttemptAt,
    dispatchToken: item?.dispatchToken,
    finishedAt: item?.finishedAt,
  });

  test("X7 race: the real handler and the real reconciler write exactly once, with the identical canonical result", async () => {
    for (let trial = 0; trial < 8; trial += 1) {
      build();
      const item = await seed({ lockWaitStartedAt: T - 1_900_000 });
      const [handled, reconciled] = await Promise.all([
        coordinator.handleLockRetry({ executionId: item.executionId, attempt: 1 }),
        reconciler.reconcile(),
      ]);
      const mine = reconciled.actions.find((a) => a.executionId === item.executionId);
      const stored = await executions.get(item.executionId);

      expect(stored?.status).toBe("FAILED");
      expect(stored?.error).toEqual({ code: "LOCK_TIMEOUT" });
      expect(stored?.version).toBe(2); // exactly one write
      expect(stored?.activeStatus).toBeUndefined();
      expect(stored?.deadlineAt).toBeUndefined();
      const handlerWon = handled.outcome === "TRANSITIONED";
      const reconcilerWon = mine?.action === "LOCK_TIMEOUT";
      expect(handlerWon !== reconcilerWon).toBe(true); // one wins, the other is a conflict/skip
    }
  });

  test("the reconciler's X7 item equals the handler's (same fields, never TIMED_OUT)", async () => {
    build();
    const byHandler = await seed({ lockWaitStartedAt: T - 1_900_000, deadlineAt: T + 60_000 }); // not overdue: only the handler acts
    const byReconciler = await seed({ lockWaitStartedAt: T - 1_900_000 });
    expect((await coordinator.handleLockRetry({ executionId: byHandler.executionId, attempt: 1 })).outcome).toBe("TRANSITIONED");
    await reconciler.reconcile();
    const a = await executions.get(byHandler.executionId);
    const b = await executions.get(byReconciler.executionId);
    expect(b?.status).toBe("FAILED");
    expect(b?.error).toEqual({ code: "LOCK_TIMEOUT" });
    expect(outcomeOf(b)).toEqual(outcomeOf(a));
  });

  test("crash after X5 with no retry message: a fresh LOCK_RETRY_REQUESTED (attempt + 1), not LOCK_TIMEOUT (CW-2)", async () => {
    build();
    const item = await seed({ attempt: 2, contentionCount: 2, lockWaitStartedAt: T - 150_000, lockWaitAttempts: 3 });
    const summary = await reconciler.reconcile();
    expect(summary.actions).toContainEqual({ executionId: item.executionId, action: "LOCK_RETRY_REDRIVEN" });
    const stored = await executions.get(item.executionId);
    expect(stored?.status).toBe("WAITING_LOCK");
    expect(stored?.version).toBe(1);
    // Park it (not overdue) so later ticks of this file do not re-drive it again.
    expect(await executions.update(item.executionId, { status: "WAITING_LOCK", version: 1 }, { activeStatus: "EXECUTION", deadlineAt: T + 1_000_000_000 })).toBe(true);
    expect(world.published.map((m) => m.body)).toContainEqual(
      expect.objectContaining({ eventType: "LOCK_RETRY_REQUESTED", executionId: item.executionId, attempt: 3 }),
    );
  });

  test("overdue QUEUED is re-evaluated: WAITING_LOCK and the first retry message", async () => {
    build();
    const item = await seed({ status: "QUEUED", lockWaitAttempts: undefined });
    const summary = await reconciler.reconcile();
    expect(summary.actions).toContainEqual({ executionId: item.executionId, action: "QUEUED_REEVALUATED" });
    expect((await executions.get(item.executionId))?.status).toBe("WAITING_LOCK");
    expect(world.published.map((m) => m.body)).toContainEqual(
      expect.objectContaining({ eventType: "LOCK_RETRY_REQUESTED", executionId: item.executionId, attempt: 1 }),
    );
  });

  test("overdue QUEUED, S1: a newer highestAccepted gives X3 SUPERSEDED and publishes nothing", async () => {
    build();
    const item = await seed({ status: "QUEUED", lockWaitAttempts: undefined });
    expect(await targets.raiseHighestAccepted(item.lockKey, { sourceRef: item.order.sourceRef, runNumber: item.order.runNumber + 1, executionId: "exec-newer" }, T)).toMatchObject({ raised: true });
    const summary = await reconciler.reconcile();
    expect(summary.actions).toContainEqual({ executionId: item.executionId, action: "SUPERSEDED" });
    const stored = await executions.get(item.executionId);
    expect(stored?.status).toBe("SUPERSEDED");
    expect(stored?.error).toEqual({ code: "SUPERSEDED" });
    expect(stored?.activeStatus).toBeUndefined();
    expect(stored?.deadlineAt).toBeUndefined();
    expect(world.published.map((m) => m.body)).not.toContainEqual(expect.objectContaining({ executionId: item.executionId }));
  });

  test.each([0, -1])("overdue QUEUED, S1: highestAccepted at runNumber offset %i proceeds to evaluateQueued", async (offset) => {
    build();
    const item = await seed({ status: "QUEUED", lockWaitAttempts: undefined, order: { sourceRef: "refs/heads/main", runNumber: 5, runAttempt: 1 } });
    await targets.raiseHighestAccepted(item.lockKey, { sourceRef: item.order.sourceRef, runNumber: item.order.runNumber + offset, executionId: "exec-other" }, T);
    const summary = await reconciler.reconcile();
    expect(summary.actions).toContainEqual({ executionId: item.executionId, action: "QUEUED_REEVALUATED" });
    expect((await executions.get(item.executionId))?.status).toBe("WAITING_LOCK");
    expect(world.published.map((m) => m.body)).toContainEqual(expect.objectContaining({ executionId: item.executionId, attempt: 1 }));
  });

  test("overdue DEPLOYING with execStartedAt: X16 in one transaction with the unresolved[] append", async () => {
    build();
    const item = await seed({ status: "DEPLOYING", attempt: 1, dispatchToken: "token-1", fencingToken: 1, execStartedAt: T - 400_000 });
    const summary = await reconciler.reconcile();
    expect(summary.actions).toContainEqual({ executionId: item.executionId, action: "UNKNOWN_TARGET_STATE" });
    const stored = await executions.get(item.executionId);
    expect(stored?.status).toBe("UNKNOWN_TARGET_STATE");
    expect(stored?.error).toEqual({ code: "UNKNOWN_TARGET_STATE" });
    expect(stored?.activeStatus).toBeUndefined();
    expect((await targets.get(item.lockKey))?.unresolved).toEqual([{ executionId: item.executionId, since: T }]);
  });

  test("overdue DEPLOYING without execStartedAt: X11 DISPATCH_INTERRUPTED, no unresolved entry, nothing published", async () => {
    build();
    const item = await seed({ status: "DEPLOYING", attempt: 1, dispatchToken: "token-1", fencingToken: 1 });
    const summary = await reconciler.reconcile();
    expect(summary.actions).toContainEqual({ executionId: item.executionId, action: "DISPATCH_INTERRUPTED" });
    const stored = await executions.get(item.executionId);
    expect(stored?.status).toBe("FAILED");
    expect(stored?.error).toEqual({ code: "DISPATCH_INTERRUPTED" });
    expect((await targets.get(item.lockKey))?.unresolved).toBeUndefined();
    expect(world.published).toHaveLength(0);
  });

  test("an expired OPEN window is closed EXPIRED and leaves GSI2; ExecutionsPastDeadline is emitted per tick", async () => {
    build();
    const lockKey = `window-${randomUUID()}`;
    const closesAt = T - 500;
    expect(
      await windows.createOpen({
        lockKey,
        state: "OPEN",
        openedBy: "<OPERATOR_REF>",
        openedAt: T - 3_600_000,
        closesAt,
        externalJobsDisabled: [],
        version: 1,
        activeStatus: "WINDOW",
        deadlineAt: closesAt,
      }),
    ).toBe(true);
    const item = await seed({ lockWaitStartedAt: T - 1_900_000 });

    const summary = await reconciler.reconcile();
    expect(summary.windowsClosed).toBeGreaterThanOrEqual(1);
    const closed = await windows.get(lockKey);
    expect(closed).toMatchObject({ state: "CLOSED", closedReason: "EXPIRED", closedAt: T, version: 2 });
    expect(closed?.activeStatus).toBeUndefined();
    expect(closed?.deadlineAt).toBeUndefined();

    // A second tick finds neither the window nor the (now terminal) execution again.
    const again = await reconciler.reconcile();
    expect(again.overdueExecutions).toBe(0);
    expect(again.windowsClosed).toBe(0);
    expect((await executions.get(item.executionId))?.version).toBe(2);

    const counts = metricLines.map((line) => (JSON.parse(line) as { ExecutionsPastDeadline: number }).ExecutionsPastDeadline);
    expect(counts[0]).toBeGreaterThanOrEqual(1);
    expect(counts[1]).toBe(0);
  });
});
