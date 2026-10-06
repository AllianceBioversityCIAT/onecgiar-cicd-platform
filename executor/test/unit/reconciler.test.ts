// @akili-spec changes/cicd-executor-poc design §7 (reconciler row), §7.1, §7.3 (X7, X11, X16, CW-2), §7.7, DD-13; requirements FR-15, FR-17
// Unit tests of the reconciler over in-memory fakes with the real conditional
// semantics (test/support/deploy-coordinator-fakes.ts). The same logic against
// DynamoDB Local (scan-forbidding client, X7 race) is in
// test/integration/reconciler.int.test.ts.
import { describe, expect, test } from "vitest";
import { createReconciler, type DeadlineIndex, type ReconcilerDeps } from "../../src/application/reconciler/index.js";
import { createDeployCoordinator, Semaphore } from "../../src/application/deploy-coordinator/index.js";
import { createMetrics } from "../../src/observability/metrics/index.js";
import type { DeployWindowItem, ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";
import {
  FakeExecutions,
  FakeLocks,
  FakePlans,
  FakeQueue,
  FakeTarget,
  FakeTransactions,
  FakeTransport,
  FakeWindows,
  TEST_LOCK_KEY,
  TEST_SOURCE_REF,
  waitingExecution,
  World,
} from "../support/deploy-coordinator-fakes.js";

/** GSI2 stand-in: `Query` semantics only (there is deliberately no scan method). */
class FakeIndex implements DeadlineIndex {
  public readonly queries: Array<{ index: string; partition: string; before: string | number | undefined }> = [];
  public readonly openWindows = new Map<string, DeployWindowItem>();
  public constructor(private readonly world: World) {}
  public async queryIndex<TItem>(index: string, partition: string, options?: { readonly sortKeyBefore?: string | number }): Promise<TItem[]> {
    this.queries.push({ index, partition, before: options?.sortKeyBefore });
    const before = Number(options?.sortKeyBefore);
    if (partition === "EXECUTION") {
      return [...this.world.executions.values()].filter((e) => e.activeStatus === "EXECUTION" && e.deadlineAt !== undefined && e.deadlineAt < before) as TItem[];
    }
    return [...this.openWindows.values()].filter((w) => w.activeStatus === "WINDOW" && w.deadlineAt !== undefined && w.deadlineAt < before) as TItem[];
  }
}

function setup() {
  const world = new World();
  const index = new FakeIndex(world);
  const windowCloses: Array<{ lockKey: string; version: number; reason: string }> = [];
  const metricLines: string[] = [];
  const queue = new FakeQueue(world);
  const executions = new FakeExecutions(world);
  const transactions = new FakeTransactions(world);
  const coordinator = createDeployCoordinator({
    executions,
    transactions,
    locks: new FakeLocks(world),
    target: new FakeTarget(world),
    windows: new FakeWindows(),
    plans: new FakePlans(),
    transport: new FakeTransport(world),
    queue,
    clock: world.clock,
    semaphore: new Semaphore(2),
    newEventId: () => "00000000-0000-4000-8000-000000000001",
  });
  const metrics = createMetrics({ sink: { write: (line) => metricLines.push(line) }, clock: world.clock });
  const transitions: string[] = [];
  const deps: ReconcilerDeps = {
    index,
    executions,
    transactions,
    windows: {
      close: async (lockKey, version, patch) => {
        windowCloses.push({ lockKey, version, reason: patch.closedReason });
        const w = index.openWindows.get(lockKey);
        if (w === undefined || w.version !== version || w.state !== "OPEN") return false;
        index.openWindows.delete(lockKey);
        return true;
      },
    },
    target: new FakeTarget(world),
    coordinator,
    queue,
    metrics,
    clock: world.clock,
    newEventId: () => "00000000-0000-4000-8000-000000000002",
    onTransitioned: (info) => transitions.push(`${info.transitionId}:${info.status}`),
  };
  return { world, index, windowCloses, metricLines, transitions, reconciler: createReconciler(deps), deps };
}

const T0 = 1_800_000_000_000;

/** An execution whose deadline passed `ago` ms before the (fake) now. */
function overdue(over: Partial<ExecutionItem>): ExecutionItem {
  return waitingExecution({ deadlineAt: T0 - 1_000, ...over });
}

function withoutKeys(item: ExecutionItem, keys: string[]): ExecutionItem {
  const rest: Record<string, unknown> = { ...item };
  for (const k of keys) delete rest[k];
  return rest as unknown as ExecutionItem;
}

describe("reconciler: tick shape (FR-15, design §5.1)", () => {
  test("a tick issues exactly two GSI2 queries, EXECUTION then WINDOW, both with deadlineAt < now", async () => {
    const { reconciler, index } = setup();
    await reconciler.reconcile();
    expect(index.queries).toEqual([
      { index: "GSI2", partition: "EXECUTION", before: T0 },
      { index: "GSI2", partition: "WINDOW", before: T0 },
    ]);
  });

  test("executions that are not overdue are left alone", async () => {
    const { reconciler, world } = setup();
    world.add(waitingExecution({ deadlineAt: T0 + 60_000 }));
    const summary = await reconciler.reconcile();
    expect(summary.overdueExecutions).toBe(0);
    expect(world.item().version).toBe(1);
    expect(world.published).toHaveLength(0);
  });
});

describe("reconciler: overdue QUEUED (X3-X5 re-evaluation, CW-2)", () => {
  test("is re-evaluated: X5 to WAITING_LOCK, then the first LOCK_RETRY_REQUESTED with attempt = execution.attempt + 1", async () => {
    const { reconciler, world } = setup();
    world.add(withoutKeys(overdue({ status: "QUEUED" }), ["lockWaitStartedAt", "lockWaitAttempts", "nextAttemptAt"]));
    const summary = await reconciler.reconcile();
    expect(summary.actions).toEqual([{ executionId: "exec-1", action: "QUEUED_REEVALUATED" }]);
    expect(world.item().status).toBe("WAITING_LOCK");
    expect(world.published).toHaveLength(1);
    expect(world.published[0]?.body).toMatchObject({ eventType: "LOCK_RETRY_REQUESTED", executionId: "exec-1", attempt: 1 });
    // persist, then publish (CW-2)
    expect(world.events).toEqual(["update:WAITING_LOCK", "publish:WAITING_LOCK"]);
  });
});

describe("reconciler: overdue QUEUED, S1 (X3)", () => {
  const queued = (): ExecutionItem => withoutKeys(overdue({ status: "QUEUED" }), ["lockWaitStartedAt", "lockWaitAttempts", "nextAttemptAt"]);
  const accepted = (runNumber: number, sourceRef = TEST_SOURCE_REF) => ({ sourceRef, runNumber, executionId: "exec-9" });

  test("a newer highestAccepted: X3 SUPERSEDED (terminal, leaves GSI2), nothing published, evaluateQueued not run", async () => {
    const { reconciler, world, transitions } = setup();
    world.add(queued());
    world.target = { ...world.target, highestAccepted: accepted(6) };
    const summary = await reconciler.reconcile();
    expect(summary.actions).toEqual([{ executionId: "exec-1", action: "SUPERSEDED" }]);
    const item = world.item();
    expect(item.status).toBe("SUPERSEDED");
    expect(item.error).toEqual({ code: "SUPERSEDED" });
    expect(item.activeStatus).toBeUndefined();
    expect(item.deadlineAt).toBeUndefined();
    expect(world.published).toHaveLength(0);
    expect(transitions).toEqual(["X3:SUPERSEDED"]);
  });

  test.each([5, 4])("highestAccepted %i (equal or older than this run, 5): proceeds to evaluateQueued", async (runNumber) => {
    const { reconciler, world } = setup();
    world.add(queued());
    world.target = { ...world.target, highestAccepted: accepted(runNumber) };
    const summary = await reconciler.reconcile();
    expect(summary.actions).toEqual([{ executionId: "exec-1", action: "QUEUED_REEVALUATED" }]);
    expect(world.item().status).toBe("WAITING_LOCK");
    expect(world.published).toHaveLength(1);
  });

  test("lastDeployed / highestDispatched newer also supersede (S1 inputs)", async () => {
    const { reconciler, world } = setup();
    world.add(queued());
    world.target = { ...world.target, highestDispatched: accepted(7) };
    await reconciler.reconcile();
    expect(world.item().status).toBe("SUPERSEDED");
  });

  test("a value of another source throws like execution-service (OrderingSourceMismatchError); nothing is written", async () => {
    const { reconciler, world } = setup();
    world.add(queued());
    world.target = { ...world.target, highestAccepted: accepted(9, "<OTHER_SOURCE_REF>") };
    await expect(reconciler.reconcile()).rejects.toMatchObject({ errors: [expect.objectContaining({ name: "OrderingSourceMismatchError" })] });
    expect(world.item().status).toBe("QUEUED");
    expect(world.published).toHaveLength(0);
  });

  test("uses the persisted order.sourceRef, not a rebuilt one", async () => {
    const { reconciler, world } = setup();
    world.add({ ...queued(), order: { sourceRef: "<PERSISTED_SOURCE_REF>", runNumber: 5, runAttempt: 1 } });
    world.target = { ...world.target, highestAccepted: accepted(6, "<PERSISTED_SOURCE_REF>") };
    await reconciler.reconcile();
    expect(world.item().status).toBe("SUPERSEDED");
  });
});

describe("reconciler: overdue WAITING_LOCK (CW-2, X7)", () => {
  test("crash after X5 with no retry message and budget left: a fresh LOCK_RETRY_REQUESTED, NOT LOCK_TIMEOUT (CW-2)", async () => {
    const { reconciler, world, transitions } = setup();
    world.add(overdue({ lockWaitStartedAt: T0 - 150_000, lockWaitAttempts: 0, attempt: 0 }));
    const summary = await reconciler.reconcile();
    expect(summary.actions).toEqual([{ executionId: "exec-1", action: "LOCK_RETRY_REDRIVEN" }]);
    expect(world.item().status).toBe("WAITING_LOCK");
    expect(world.item().version).toBe(1); // no state change
    expect(world.published).toHaveLength(1);
    expect(world.published[0]).toMatchObject({ delaySeconds: 0 });
    expect(world.published[0]?.body).toMatchObject({ eventType: "LOCK_RETRY_REQUESTED", executionId: "exec-1", attempt: 1 });
    expect(transitions).toEqual([]);
  });

  test("the re-drive attempt is execution.attempt + 1 (pinned by the N-12 review), also after an X14 back-edge", async () => {
    const { reconciler, world } = setup();
    world.add(overdue({ attempt: 2, contentionCount: 2, lockWaitStartedAt: T0 - 150_000, lockWaitAttempts: 3 }));
    await reconciler.reconcile();
    expect(world.published[0]?.body).toMatchObject({ attempt: 3 });
  });

  test("the re-driven message is accepted by the real coordinator handler (attempt matches), a stale one is not", async () => {
    const ctx = setup();
    ctx.world.add(overdue({ attempt: 2, contentionCount: 2, lockWaitStartedAt: T0 - 150_000, lockWaitAttempts: 3 }));
    await ctx.reconciler.reconcile();
    const attempt = (ctx.world.published[0]?.body as { attempt: number }).attempt;
    const coordinator = createDeployCoordinator({
      executions: new FakeExecutions(ctx.world),
      transactions: new FakeTransactions(ctx.world),
      locks: new FakeLocks(ctx.world),
      target: new FakeTarget(ctx.world),
      windows: new FakeWindows(),
      plans: new FakePlans(),
      transport: new FakeTransport(ctx.world),
      queue: new FakeQueue(ctx.world),
      clock: ctx.world.clock,
      semaphore: new Semaphore(1),
    });
    expect(await coordinator.handleLockRetry({ executionId: "exec-1", attempt: attempt - 1 })).toEqual({ outcome: "NOOP", reason: "STALE" });
    expect((await coordinator.handleLockRetry({ executionId: "exec-1", attempt })).outcome).not.toBe("NOOP");
  });

  test("budget exhausted by time: X7 FAILED (LOCK_TIMEOUT), canonical, leaves GSI2", async () => {
    const { reconciler, world, transitions } = setup();
    world.add(overdue({ lockWaitStartedAt: T0 - 1_900_000 }));
    const summary = await reconciler.reconcile();
    expect(summary.actions).toEqual([{ executionId: "exec-1", action: "LOCK_TIMEOUT" }]);
    const item = world.item();
    expect(item.status).toBe("FAILED");
    expect(item.error).toEqual({ code: "LOCK_TIMEOUT" });
    expect(item.activeStatus).toBeUndefined();
    expect(item.deadlineAt).toBeUndefined();
    expect(item.finishedAt).toBe(T0);
    expect(world.published).toHaveLength(0);
    expect(transitions).toEqual(["X7:FAILED"]);
  });

  test("budget exhausted by the 10-attempt cap: X7 LOCK_TIMEOUT even inside the 1,800 s window", async () => {
    const { reconciler, world } = setup();
    world.add(overdue({ lockWaitStartedAt: T0 - 600_000, lockWaitAttempts: 10 }));
    await reconciler.reconcile();
    expect(world.item().error).toEqual({ code: "LOCK_TIMEOUT" });
  });

  test("the reconciler's X7 write is identical to the handler's (same result, never TIMED_OUT)", async () => {
    const a = setup();
    const b = setup();
    const base = { lockWaitStartedAt: T0 - 1_900_000 };
    a.world.add(overdue(base));
    b.world.add(overdue(base));
    await a.reconciler.reconcile();
    const handler = createDeployCoordinator({
      executions: new FakeExecutions(b.world),
      transactions: new FakeTransactions(b.world),
      locks: new FakeLocks(b.world),
      target: new FakeTarget(b.world),
      windows: new FakeWindows(),
      plans: new FakePlans(),
      transport: new FakeTransport(b.world),
      queue: new FakeQueue(b.world),
      clock: b.world.clock,
      semaphore: new Semaphore(1),
    });
    expect((await handler.handleLockRetry({ executionId: "exec-1", attempt: 1 })).outcome).toBe("TRANSITIONED");
    expect(a.world.item()).toEqual(b.world.item());
  });

  test("a lost conditional write (the handler won first) is a SKIPPED no-op", async () => {
    const { world, deps } = setup();
    world.add(overdue({ lockWaitStartedAt: T0 - 1_900_000 }));
    const racing = createReconciler({
      ...deps,
      executions: {
        get: async (id) => world.executions.get(id),
        // The handler's write lands between the reconciler's read and its conditional write.
        update: async (id, expected, patch) => {
          await new FakeExecutions(world).update(id, expected, patch);
          return new FakeExecutions(world).update(id, expected, patch);
        },
      },
    });
    const summary = await racing.reconcile();
    expect(summary.actions).toEqual([{ executionId: "exec-1", action: "SKIPPED" }]);
    expect(world.item().version).toBe(2); // exactly one write
  });
});

describe("reconciler: overdue DEPLOYING (X11 / X16, never a re-run)", () => {
  const deploying = (over: Partial<ExecutionItem> = {}): ExecutionItem =>
    overdue({ status: "DEPLOYING", attempt: 1, dispatchToken: "token-1", fencingToken: 7, ...over });

  test("execStartedAt set for the current attempt: X16 UNKNOWN_TARGET_STATE with the unresolved[] append in the same transaction", async () => {
    const { reconciler, world, transitions } = setup();
    world.add(deploying({ execStartedAt: T0 - 500_000 }));
    const summary = await reconciler.reconcile();
    expect(summary.actions).toEqual([{ executionId: "exec-1", action: "UNKNOWN_TARGET_STATE" }]);
    const item = world.item();
    expect(item.status).toBe("UNKNOWN_TARGET_STATE");
    expect(item.error).toEqual({ code: "UNKNOWN_TARGET_STATE" });
    expect(item.activeStatus).toBeUndefined();
    expect(world.target.unresolved).toEqual([{ executionId: "exec-1", since: T0 }]);
    expect(world.events).toEqual(["tx:X16"]);
    expect(transitions).toEqual(["X16:UNKNOWN_TARGET_STATE"]);
  });

  test("no execStartedAt: X11 FAILED (DISPATCH_INTERRUPTED), no unresolved entry", async () => {
    const { reconciler, world, transitions } = setup();
    world.add(deploying());
    const summary = await reconciler.reconcile();
    expect(summary.actions).toEqual([{ executionId: "exec-1", action: "DISPATCH_INTERRUPTED" }]);
    expect(world.item().status).toBe("FAILED");
    expect(world.item().error).toEqual({ code: "DISPATCH_INTERRUPTED" });
    expect(world.target.unresolved).toBeUndefined();
    expect(transitions).toEqual(["X11:FAILED"]);
  });

  test("never publishes anything and never touches the lock or the transport", async () => {
    const { reconciler, world } = setup();
    world.add(deploying({ execStartedAt: T0 - 500_000 }));
    world.add(deploying({ executionId: "exec-2" }));
    await reconciler.reconcile();
    expect(world.published).toHaveLength(0);
    expect(world.lockReleases).toBe(0);
    expect(world.events.filter((e) => e === "exec" || e.startsWith("lock:"))).toEqual([]);
  });

  test("a DEPLOYING execution that is not yet past its deadline is left alone", async () => {
    const { reconciler, world } = setup();
    world.add(deploying({ deadlineAt: T0 + 1 }));
    await reconciler.reconcile();
    expect(world.item().status).toBe("DEPLOYING");
  });
});

describe("reconciler: expired deploy windows (design §7.7, FR-24)", () => {
  const openWindow = (lockKey: string, closesAt: number, version = 3): DeployWindowItem => ({
    lockKey,
    state: "OPEN",
    openedBy: "<OPERATOR_REF>",
    openedAt: closesAt - 3_600_000,
    closesAt,
    externalJobsDisabled: [],
    version,
    activeStatus: "WINDOW",
    deadlineAt: closesAt,
  });

  test("an expired OPEN window is closed EXPIRED conditional on its version; a live one is not touched", async () => {
    const { reconciler, index, windowCloses } = setup();
    index.openWindows.set(TEST_LOCK_KEY, openWindow(TEST_LOCK_KEY, T0 - 1));
    index.openWindows.set("<OTHER_LOCK_KEY>", openWindow("<OTHER_LOCK_KEY>", T0 + 3_600_000));
    const summary = await reconciler.reconcile();
    expect(summary.windowsClosed).toBe(1);
    expect(windowCloses).toEqual([{ lockKey: TEST_LOCK_KEY, version: 3, reason: "EXPIRED" }]);
  });

  test("a window someone else closed first (conditional write lost) is not counted", async () => {
    const { index, deps } = setup();
    index.openWindows.set(TEST_LOCK_KEY, openWindow(TEST_LOCK_KEY, T0 - 1));
    const lost = createReconciler({ ...deps, windows: { close: async () => false } });
    expect((await lost.reconcile()).windowsClosed).toBe(0);
  });
});

describe("reconciler: ExecutionsPastDeadline metric (FR-17)", () => {
  test("emits the count of overdue executions found, as an EMF line with no dimensions", async () => {
    const { reconciler, world, metricLines } = setup();
    world.add(overdue({ lockWaitStartedAt: T0 - 150_000 }));
    world.add(overdue({ executionId: "exec-2", lockWaitStartedAt: T0 - 1_900_000 }));
    world.add(waitingExecution({ executionId: "exec-3", deadlineAt: T0 + 60_000 }));
    await reconciler.reconcile();
    expect(metricLines).toHaveLength(1);
    const doc = JSON.parse(metricLines[0] ?? "{}") as Record<string, unknown>;
    expect(doc.ExecutionsPastDeadline).toBe(2);
    expect(doc._aws).toMatchObject({ CloudWatchMetrics: [{ Namespace: "CicdExecutor", Dimensions: [[]], Metrics: [{ Name: "ExecutionsPastDeadline", Unit: "Count" }] }] });
  });

  test("emits 0 on a clean tick so the alarm always has data", async () => {
    const { reconciler, metricLines } = setup();
    await reconciler.reconcile();
    expect(JSON.parse(metricLines[0] ?? "{}")).toMatchObject({ ExecutionsPastDeadline: 0 });
  });
});

describe("reconciler: failure isolation", () => {
  test("one failing item does not stop the others; the tick then fails so the message is redelivered", async () => {
    const { world, deps } = setup();
    world.add(overdue({ executionId: "exec-1", lockWaitStartedAt: T0 - 1_900_000 }));
    world.add(overdue({ executionId: "exec-2", lockWaitStartedAt: T0 - 1_900_000 }));
    const flaky = createReconciler({
      ...deps,
      executions: {
        get: async (id) => {
          if (id === "exec-1") throw new Error("store unavailable");
          return world.executions.get(id);
        },
        update: new FakeExecutions(world).update.bind(new FakeExecutions(world)),
      },
    });
    await expect(flaky.reconcile()).rejects.toBeInstanceOf(AggregateError);
    expect(world.item("exec-2").status).toBe("FAILED");
  });
});
