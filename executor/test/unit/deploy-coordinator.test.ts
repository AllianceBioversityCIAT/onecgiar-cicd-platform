// @akili-spec changes/cicd-executor-poc design §7.3 (X4-X16, CS-2, CW-1, CW-2), §7.5, §7.6, DD-27, DD-28; requirements FR-11, FR-12, FR-16, FR-23, FR-24, RL-4, RL-7
// Unit tests of the deploy coordinator over in-memory fakes with the real
// conditional semantics. Every exit asserts RESOURCE RELEASE (lock, semaphore
// slot, session), not just the final state. The atomicity of the real X9
// transaction is covered against DynamoDB Local in
// test/integration/deploy-transactions.int.test.ts.
import { afterEach, describe, expect, test } from "vitest";
import { applyTransition } from "../../src/domain/state-machine/index.js";
import {
  createDeployCoordinator,
  DEFAULT_SSH_CONCURRENCY,
  Semaphore,
  toExecutionSnapshot,
  type DeployCoordinatorDeps,
} from "../../src/application/deploy-coordinator/index.js";
import type { ExecutionItem } from "../../src/adapters/dynamodb-state-store/types.js";
import {
  FakeExecutions,
  FakeLocks,
  FakeQueue,
  FakeTarget,
  FakeTransactions,
  FakeTransport,
  FakeWindows,
  TEST_LOCK_KEY,
  TEST_SNAPSHOT,
  TEST_SOURCE_REF,
  waitingExecution,
  World,
} from "../support/deploy-coordinator-fakes.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Ctx {
  world: World;
  transport: FakeTransport;
  windows: FakeWindows;
  semaphore: Semaphore;
  coordinator: ReturnType<typeof createDeployCoordinator>;
}

const pending: Array<() => void> = [];
afterEach(() => {
  for (const release of pending.splice(0)) release();
});

function setup(over: Partial<DeployCoordinatorDeps> = {}): Ctx {
  const world = new World();
  const transport = new FakeTransport(world);
  const windows = new FakeWindows();
  const semaphore = new Semaphore(2);
  let tokens = 0;
  const coordinator = createDeployCoordinator({
    executions: new FakeExecutions(world),
    transactions: new FakeTransactions(world),
    locks: new FakeLocks(world),
    target: new FakeTarget(world),
    windows,
    transport,
    queue: new FakeQueue(world),
    clock: world.clock,
    semaphore,
    renewalIntervalMs: 5,
    newDispatchToken: () => `token-${String((tokens += 1))}`,
    newEventId: () => "00000000-0000-4000-8000-000000000000",
    ...over,
  });
  pending.push(() => transport.releaseHangs());
  return { world, transport, windows, semaphore, coordinator };
}

const retry = (attempt = 1, executionId = "exec-1"): { executionId: string; attempt: number } => ({ executionId, attempt });

/** Every resource of the attempt is back: session closed, slot returned, lock released. */
function expectAllReleased(ctx: Ctx): void {
  expect(ctx.transport.openSessions).toBe(0);
  expect(ctx.semaphore.inUse).toBe(0);
  expect(ctx.world.lockIsReleased()).toBe(true);
}

function queuedExecution(): ExecutionItem {
  const rest: Record<string, unknown> = { ...waitingExecution(), status: "QUEUED" };
  for (const field of ["lockWaitStartedAt", "lockWaitAttempts", "nextAttemptAt"]) delete rest[field];
  return rest as unknown as ExecutionItem;
}

describe("evaluateQueued (X4, X5)", () => {
  test("V1 fails: X4 FAILED (DEPLOY_WINDOW_CLOSED), nothing published", async () => {
    const ctx = setup();
    ctx.world.add(queuedExecution());
    ctx.windows.deny.add("V1");
    const out = await ctx.coordinator.evaluateQueued("exec-1");
    expect(out).toMatchObject({ outcome: "TRANSITIONED", transitionId: "X4", status: "FAILED" });
    expect(ctx.world.item().error?.code).toBe("DEPLOY_WINDOW_CLOSED");
    expect(ctx.world.item().activeStatus).toBeUndefined();
    expect(ctx.world.published).toHaveLength(0);
  });

  test("V1 ok: X5 persists nextAttemptAt BEFORE publishing the first retry (CW-2)", async () => {
    const ctx = setup();
    ctx.world.add(queuedExecution());
    const out = await ctx.coordinator.evaluateQueued("exec-1");
    expect(out).toMatchObject({ outcome: "TRANSITIONED", transitionId: "X5", status: "WAITING_LOCK" });
    const item = ctx.world.item();
    expect(item.lockWaitAttempts).toBe(0);
    expect(item.nextAttemptAt).toBe(ctx.world.clock.nowMs);
    expect(item.deadlineAt).toBe(ctx.world.clock.nowMs + 120_000);
    // The persisted WAITING_LOCK state was visible when the message left.
    expect(ctx.world.events).toEqual(["update:WAITING_LOCK", "publish:WAITING_LOCK"]);
    expect(ctx.world.published[0]).toMatchObject({
      delaySeconds: 0,
      body: { eventType: "LOCK_RETRY_REQUESTED", source: "executor", executionId: "exec-1", attempt: 1 },
    });
  });

  test("an execution that is no longer QUEUED is a no-op", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    expect(await ctx.coordinator.evaluateQueued("exec-1")).toEqual({ outcome: "NOOP", reason: "STALE" });
    expect(await ctx.coordinator.evaluateQueued("missing")).toEqual({ outcome: "NOOP", reason: "NOT_FOUND" });
  });
});

describe("handleLockRetry: stale and early exits", () => {
  test("a stale attempt or a non-WAITING_LOCK execution is a no-op with no effect", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution({ attempt: 2 }));
    expect(await ctx.coordinator.handleLockRetry(retry(1))).toEqual({ outcome: "NOOP", reason: "STALE" });
    ctx.world.add(waitingExecution({ status: "DEPLOYING", dispatchToken: "t" }));
    expect(await ctx.coordinator.handleLockRetry(retry(1))).toEqual({ outcome: "NOOP", reason: "STALE" });
    expect(ctx.world.events).toEqual([]);
    expect(ctx.world.lock).toBeUndefined();
  });

  test("V2 fails on a retry: X8 FAILED (DEPLOY_WINDOW_CLOSED), the lock is never taken", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.windows.deny.add("V2");
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X8", status: "FAILED" });
    expect(ctx.world.lock).toBeUndefined();
    expect(ctx.transport.connects).toBe(0);
  });
});

describe("lock wait (design §7.6)", () => {
  function busyCtx(over: Partial<ExecutionItem> = {}): Ctx {
    const ctx = setup();
    ctx.world.add(waitingExecution(over));
    ctx.world.stealLock();
    ctx.world.lock = { ...ctx.world.lock!, leaseExpiresAt: Number.MAX_SAFE_INTEGER };
    return ctx;
  }

  test("busy lock: lockWaitAttempts is incremented and nextAttemptAt persisted BEFORE the message is sent (CW-2)", async () => {
    const ctx = busyCtx();
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toEqual({ outcome: "RETRY_SCHEDULED", delaySeconds: 30, lockWaitAttempts: 1 });
    const item = ctx.world.item();
    expect(item.lockWaitAttempts).toBe(1);
    expect(item.nextAttemptAt).toBe(ctx.world.clock.nowMs + 30_000);
    expect(item.deadlineAt).toBe(ctx.world.clock.nowMs + 30_000 + 120_000);
    expect(item.status).toBe("WAITING_LOCK");
    expect(ctx.world.events).toEqual(["update:WAITING_LOCK", "publish:WAITING_LOCK"]);
    expect(ctx.world.published[0]).toMatchObject({ delaySeconds: 30, body: { attempt: 1 } });
    expect(ctx.world.lockReleases).toBe(0); // never ours
  });

  test("schedule 30/60/120/240/480/870 with integer delays, then X7 LOCK_TIMEOUT at 1,800 s", async () => {
    const ctx = busyCtx();
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const out = await ctx.coordinator.handleLockRetry(retry());
      if (out.outcome !== "RETRY_SCHEDULED") throw new Error(`unexpected ${JSON.stringify(out)}`);
      delays.push(out.delaySeconds);
      ctx.world.clock.nowMs += out.delaySeconds * 1000;
    }
    expect(delays).toEqual([30, 60, 120, 240, 480, 870]);
    expect(delays.every((d) => Number.isInteger(d) && d <= 900)).toBe(true);
    const last = await ctx.coordinator.handleLockRetry(retry());
    expect(last).toMatchObject({ transitionId: "X7", status: "FAILED" });
    expect(ctx.world.item().error?.code).toBe("LOCK_TIMEOUT");
    expect(ctx.world.published).toHaveLength(6);
  });

  test("the 10-attempt cap ends the wait with X7 even with budget left", async () => {
    const ctx = busyCtx({ lockWaitAttempts: 9 });
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X7", status: "FAILED" });
    expect(ctx.world.item().lockWaitAttempts).toBe(10);
    expect(ctx.world.item().error?.code).toBe("LOCK_TIMEOUT");
    expect(ctx.world.published).toHaveLength(0);
  });
});

describe("successful deploy (X9, X12) and §7.5 resource release", () => {
  test("exit 0: intent, then execStartedAt BEFORE exec, then the fenced lastDeployed, then SUCCEEDED; everything released", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    let atExec: ExecutionItem | undefined;
    ctx.transport.atExec = () => {
      atExec = ctx.world.item();
      expect(ctx.semaphore.inUse).toBe(1); // slot held while the script runs
    };
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 0, cicdResult: { status: "OK", deployedImages: { app: "<REPOSITORY_REF>@sha256:<DIGEST>" } } }];

    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X12", status: "SUCCEEDED" });

    // DD-28: at the moment of exec, the intent AND execStartedAt for the current token were persisted.
    expect(atExec?.status).toBe("DEPLOYING");
    expect(atExec?.dispatchToken).toBe("token-1");
    expect(atExec?.execStartedAt).toBeTypeOf("number");
    expect(atExec?.fencingToken).toBe(1);
    expect(atExec?.attempt).toBe(1);
    const e = ctx.world.events;
    const order = ["lock:acquired", "tx:X9", "update:DEPLOYING:execStartedAt", "exec", "target:lastDeployed", "update:SUCCEEDED", "lock:released"].map((x) => e.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Design §6.5: the fixed argument vector, the script installed on the target, the platform timeout.
    expect(ctx.transport.lastExec).toEqual({
      executionId: "exec-1",
      scriptPath: "/opt/cicd/example-app/deploy.sh",
      args: [
        "--target-id", TEST_LOCK_KEY,
        "--execution-id", "exec-1",
        "--fencing-token", "1",
        "--commit-sha", "0123456789abcdef0123456789abcdef01234567",
        "--artifact", "app=sha256:<DIGEST>",
      ],
      timeoutMs: 20 * 60_000,
    });
    // The SSH target comes from the snapshot (host, port, user, host key, credential REFERENCE), never from the request.
    expect(ctx.transport.targets).toEqual([
      {
        targetId: TEST_LOCK_KEY,
        host: "target.example.internal",
        port: 2222,
        user: "deploy",
        hostKey: TEST_SNAPSHOT.hostKey,
        credentialRef: "cicd-poc/dev/example-app-dev/ssh",
      },
    ]);
    // Every revalidation carries the snapshot's window policy.
    expect(new Set(ctx.windows.targets.map((t) => JSON.stringify(t)))).toEqual(new Set([JSON.stringify({ targetId: TEST_LOCK_KEY, deployWindowPolicy: "required" })]));
    expect(ctx.world.target.lastDeployed).toMatchObject({ sourceRef: TEST_SOURCE_REF, runNumber: 5, executionId: "exec-1" });
    expect(ctx.world.target.highestDispatched).toMatchObject({ runNumber: 5, executionId: "exec-1" });
    const done = ctx.world.item();
    expect(done.activeStatus).toBeUndefined();
    expect(done.deadlineAt).toBeUndefined();
    expect(done.finishedAt).toBeTypeOf("number");
    expect(done.targetWriteRejected).toBeUndefined();
    expectAllReleased(ctx);
    expect(ctx.transport.execs).toBe(1);
  });

  test("the lock lease is renewed while the script runs and renewal stops afterwards", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.duringExec = () => sleep(60);
    await ctx.coordinator.handleLockRetry(retry());
    const renewals = ctx.world.renewals;
    expect(renewals).toBeGreaterThanOrEqual(2);
    await sleep(40);
    expect(ctx.world.renewals).toBe(renewals);
  });

  test("exit 0 while the lease was lost: SUCCEEDED with lockLostDuringRun and targetWriteRejected; the stale target write is NOT issued and the new owner's lock is untouched", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.duringExec = async () => {
      ctx.world.stealLock("exec-newer");
      await sleep(30);
    };
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X12", status: "SUCCEEDED" });
    const done = ctx.world.item();
    expect(done.lockLostDuringRun).toBe(true);
    expect(done.targetWriteRejected).toBe(true);
    expect(ctx.world.target.lastDeployed).toBeUndefined();
    expect(ctx.world.lock?.owner).toBe("exec-newer");
    expect(ctx.world.lockReleases).toBe(0);
    expect(ctx.transport.openSessions).toBe(0);
    expect(ctx.semaphore.inUse).toBe(0);
  });

  test("exit 0 with a stale fencing token at the store: SUCCEEDED with targetWriteRejected", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.world.target = { ...ctx.world.target, fencingToken: 99 };
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X12", status: "SUCCEEDED" });
    expect(ctx.world.item().targetWriteRejected).toBe(true);
    expect(ctx.world.item().lockLostDuringRun).toBeUndefined();
    expectAllReleased(ctx);
  });
});

describe("duplicate concurrent attempts (DD-09 re-entrancy, DD-22, design §7.5)", () => {
  test("a handler that loses the X9 race keeps the lock; the winner releases it exactly once at its exit", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    ctx.transport.duringExec = () => gate; // the winner's script keeps running until the test lets it go

    const a = ctx.coordinator.handleLockRetry(retry()).then((out) => ({ who: "a", out }));
    const b = ctx.coordinator.handleLockRetry(retry()).then((out) => ({ who: "b", out }));
    // The winner cannot finish before the gate opens, so the first to settle is the loser.
    const loser = await Promise.race([a, b]);
    expect(loser.out).toEqual({ outcome: "NOOP", reason: "CONFLICT" });
    await until(() => ctx.transport.execs === 1, "the winner's exec");

    // The sibling's script is running: the lock must still be held and must not have been released by the loser.
    expect(ctx.world.lockReleases).toBe(0);
    expect(ctx.world.lockIsReleased()).toBe(false);
    expect(ctx.world.lock?.owner).toBe("exec-1");
    expect(ctx.semaphore.inUse).toBe(1);

    openGate();
    const results = await Promise.all([a, b]);
    const winner = results.find((r) => r.who !== loser.who);
    expect(winner?.out).toMatchObject({ transitionId: "X12", status: "SUCCEEDED" });
    expect(ctx.transport.execs).toBe(1);
    expect(ctx.world.lockReleases).toBe(1); // released by the winner at its exit, once
    expectAllReleased(ctx);
  });

  test("a lock re-acquired after our own release (X14 retry) is a fresh hold, so it is released at exit", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 50 }, { kind: "EXIT", exitCode: 0 }];
    await ctx.coordinator.handleLockRetry(retry(1));
    expect(await ctx.coordinator.handleLockRetry(retry(2))).toMatchObject({ transitionId: "X12" });
    expect(ctx.world.lockReleases).toBe(2);
    expectAllReleased(ctx);
  });
});

describe("FR-24: window closed during the run, and a missing CICD_RESULT", () => {
  test("a window that closed while the script ran is recorded; the script is not aborted and the outcome is unchanged", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.duringExec = async () => {
      ctx.windows.deny.add("V3"); // the window closes while the script runs
    };
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X12", status: "SUCCEEDED" });
    expect(ctx.world.item().windowClosedDuringRun).toBe(true);
    expect(ctx.world.target.lastDeployed).toBeDefined();
    expectAllReleased(ctx);
  });

  test("a window still valid at exit leaves windowClosedDuringRun unset", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    await ctx.coordinator.handleLockRetry(retry());
    expect(ctx.world.item().windowClosedDuringRun).toBeUndefined();
  });

  test("windowClosedDuringRun is also recorded on a failed deploy (exit 30)", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 30, cicdResult: { status: "START_FAILED" } }];
    ctx.transport.duringExec = async () => {
      ctx.windows.deny.add("V3");
    };
    expect(await ctx.coordinator.handleLockRetry(retry())).toMatchObject({ transitionId: "X13" });
    expect(ctx.world.item()).toMatchObject({ status: "FAILED", windowClosedDuringRun: true });
    expect(ctx.world.item().cicdResultMissing).toBeUndefined();
  });

  test("exit 0 without CICD_RESULT: lastDeployed is recorded, stored images are NOT fabricated, and the execution is flagged", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.world.target = { lockKey: TEST_LOCK_KEY, currentImages: { app: "<REPOSITORY_REF>@sha256:<OLD_DIGEST>" } };
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 0 }];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X12", status: "SUCCEEDED" });
    expect(ctx.world.item().cicdResultMissing).toBe(true);
    expect(ctx.world.target.currentImages).toEqual({ app: "<REPOSITORY_REF>@sha256:<OLD_DIGEST>" });
    expect(ctx.world.target.lastDeployed).toMatchObject({ runNumber: 5 });
  });

  test("AC-03 G-D7: a success records the version check; a MISMATCH keeps SUCCEEDED and the fenced lastDeployed", async () => {
    const verified = setup();
    verified.world.add(waitingExecution());
    verified.transport.execScript = [{ kind: "EXIT", exitCode: 0, cicdResult: { status: "SUCCESS", deployedImages: { app: "<REPOSITORY_REF>@sha256:<DIGEST>" } } }];
    await verified.coordinator.handleLockRetry(retry());
    expect(verified.world.item()).toMatchObject({ status: "SUCCEEDED", versionCheck: "VERIFIED", versionGuaranteed: true });

    const mismatch = setup();
    mismatch.world.add(waitingExecution());
    mismatch.transport.execScript = [{ kind: "EXIT", exitCode: 0, cicdResult: { status: "SUCCESS", deployedCommit: "f".repeat(40) } }];
    expect(await mismatch.coordinator.handleLockRetry(retry())).toMatchObject({ transitionId: "X12", status: "SUCCEEDED" });
    expect(mismatch.world.item()).toMatchObject({ versionCheck: "MISMATCH", versionGuaranteed: true });
    expect(mismatch.world.target.lastDeployed).toMatchObject({ runNumber: 5 });

    const none = setup();
    none.world.add(waitingExecution({ targetSnapshot: { ...TEST_SNAPSHOT, hostKey: [...TEST_SNAPSHOT.hostKey], scriptArguments: "none" } }));
    none.transport.execScript = [{ kind: "EXIT", exitCode: 0 }];
    await none.coordinator.handleLockRetry(retry());
    expect(none.world.item()).toMatchObject({ status: "SUCCEEDED", versionCheck: "NOT_REPORTED", versionGuaranteed: false });
    expect(none.transport.lastExec?.args).toEqual([]);
  });

  test("AC-03 G-D7: a failed run records no version check", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 10, cicdResult: { status: "PULL_FAILED" } }];
    await ctx.coordinator.handleLockRetry(retry());
    expect(ctx.world.item().versionCheck).toBeUndefined();
  });

  test("a present CICD_RESULT is not flagged", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 0, cicdResult: { status: "OK", deployedImages: { app: "<IMG>" } } }];
    await ctx.coordinator.handleLockRetry(retry());
    expect(ctx.world.item().cicdResultMissing).toBeUndefined();
    expect(ctx.world.target.currentImages).toEqual({ app: "<IMG>" });
  });
});

describe("exit mapping", () => {
  test.each([
    [10, "PULL"],
    [20, "MIGRATION"],
    [30, "START"],
    [40, "HEALTH"],
  ])("exit %i: X13 FAILED (%s), no lastDeployed, everything released", async (exitCode, code) => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode, logTail: "tail" }];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X13", status: "FAILED" });
    const item = ctx.world.item();
    expect(item.error?.code).toBe(code);
    expect(item.result?.code).toBe(exitCode);
    expect(ctx.world.target.lastDeployed).toBeUndefined();
    expect(ctx.world.target.unresolved).toBeUndefined();
    expectAllReleased(ctx);
  });

  test.each([2, 1, 137, 255])("exit %i (outside 0/10/20/30/40/50): X16 with the unresolved[] append, everything released", async (exitCode) => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode }];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X16", status: "UNKNOWN_TARGET_STATE" });
    expect(ctx.world.item().error?.code).toBe("UNKNOWN_TARGET_STATE");
    expect(ctx.world.target.unresolved).toEqual([{ executionId: "exec-1", since: ctx.world.clock.nowMs }]);
    expect(ctx.world.target.lastDeployed).toBeUndefined();
    expect(ctx.world.events).toContain("tx:X16");
    expectAllReleased(ctx);
  });

  test("exit 50 with budget left and V3 ok: X14 back to WAITING_LOCK; resources released, per-attempt fields cleared, retry published after the write (CW-1, CW-2)", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 50 }];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X14", status: "WAITING_LOCK" });
    const item = ctx.world.item();
    expect(item).toMatchObject({ status: "WAITING_LOCK", attempt: 1, contentionCount: 1, lockWaitAttempts: 1 });
    expect(item.execStartedAt).toBeUndefined();
    expect(item.result).toBeUndefined();
    expect(item.nextAttemptAt).toBe(ctx.world.clock.nowMs + 30_000);
    expect(item.deadlineAt).toBe(ctx.world.clock.nowMs + 30_000 + 120_000);
    expect(ctx.world.published).toHaveLength(1);
    expect(ctx.world.published[0]).toMatchObject({ delaySeconds: 30, body: { attempt: 2 } });
    const e = ctx.world.events;
    expect(e.indexOf("update:WAITING_LOCK")).toBeLessThan(e.indexOf("publish:WAITING_LOCK"));
    // Waiting holds no slot, no session and no lock.
    expectAllReleased(ctx);
    expect(ctx.world.target.unresolved).toBeUndefined();
  });

  test("exit 50 with V3 failing: X15 FAILED (DEPLOY_WINDOW_CLOSED)", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 50 }];
    ctx.transport.atExec = () => ctx.windows.deny.add("V3");
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X15", status: "FAILED" });
    expect(ctx.world.item().error?.code).toBe("DEPLOY_WINDOW_CLOSED");
    expect(ctx.world.published).toHaveLength(0);
    expectAllReleased(ctx);
  });

  test("exit 50 with the 10-attempt cap reached: X15 FAILED (LOCK_TIMEOUT), nothing published", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution({ lockWaitAttempts: 9 }));
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 50 }];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X15", status: "FAILED" });
    expect(ctx.world.item().error?.code).toBe("LOCK_TIMEOUT");
    expect(ctx.world.published).toHaveLength(0);
    expectAllReleased(ctx);
  });

  test("timeout with the script running: X16, session closed and slot returned, but the lock is NOT released (renewal stops)", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "TIMEOUT" }];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X16", status: "UNKNOWN_TARGET_STATE" });
    expect(ctx.world.target.unresolved).toHaveLength(1);
    expect(ctx.transport.openSessions).toBe(0);
    expect(ctx.semaphore.inUse).toBe(0);
    expect(ctx.world.lockReleases).toBe(0);
    expect(ctx.world.lockIsReleased()).toBe(false);
    const renewals = ctx.world.renewals;
    await sleep(30);
    expect(ctx.world.renewals).toBe(renewals);
  });

  test("session lost after execStartedAt (exec throws): X16, never re-run", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = ["THROW", { kind: "EXIT", exitCode: 0 }];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X16", status: "UNKNOWN_TARGET_STATE" });
    expect(ctx.transport.execs).toBe(1);
    expect(ctx.transport.openSessions).toBe(0);
    expect(ctx.semaphore.inUse).toBe(0);
    expect(ctx.world.lockReleases).toBe(0);
  });
});

describe("failures before exec (X10, X11)", () => {
  test("connect failure: 3 tries, then X11 SSH_CONNECT; never exec; slot and lock released; no execStartedAt", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.connectScript = ["SSH_CONNECT", "SSH_CONNECT", "SSH_CONNECT"];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X11", status: "FAILED" });
    expect(ctx.transport.connects).toBe(3);
    expect(ctx.transport.execs).toBe(0);
    expect(ctx.world.item().error?.code).toBe("SSH_CONNECT");
    expect(ctx.world.item().execStartedAt).toBeUndefined();
    expectAllReleased(ctx);
  });

  test("a connect that succeeds on the retry proceeds to exec", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.connectScript = ["SSH_CONNECT", "OK"];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X12" });
    expect(ctx.transport.connects).toBe(2);
    expectAllReleased(ctx);
  });

  test("host key mismatch: X11 HOST_KEY_MISMATCH after exactly one try", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.connectScript = ["HOST_KEY_MISMATCH", "OK"];
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X11", status: "FAILED" });
    expect(ctx.transport.connects).toBe(1);
    expect(ctx.world.item().error?.code).toBe("HOST_KEY_MISMATCH");
    expectAllReleased(ctx);
  });

  test("V4 fails right before exec: X10, session closed, no execStartedAt, never exec", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.windows.deny.add("V4");
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X10", status: "FAILED" });
    expect(ctx.world.item().error?.code).toBe("DEPLOY_WINDOW_CLOSED");
    expect(ctx.world.item().execStartedAt).toBeUndefined();
    expect(ctx.transport.connects).toBe(1);
    expect(ctx.transport.execs).toBe(0);
    expectAllReleased(ctx);
  });

  test("CW-1: exit 50 -> X14 -> retry -> V4 fails -> X10 (execStartedAt was cleared by X14, so X10 is legal)", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 50 }];
    expect(await ctx.coordinator.handleLockRetry(retry(1))).toMatchObject({ transitionId: "X14" });
    expect(ctx.world.item().execStartedAt).toBeUndefined();

    ctx.windows.deny.add("V4");
    const out = await ctx.coordinator.handleLockRetry(retry(2));
    expect(out).toMatchObject({ transitionId: "X10", status: "FAILED" });
    expect(ctx.world.item()).toMatchObject({ attempt: 2, status: "FAILED" });
    expect(ctx.world.item().execStartedAt).toBeUndefined();
    expect(ctx.transport.execs).toBe(1);
    expectAllReleased(ctx);
  });
});

describe("supersede under the lock (S2, X6) and CS-2", () => {
  const older = (): ExecutionItem =>
    waitingExecution({ executionId: "exec-2", order: { sourceRef: TEST_SOURCE_REF, runNumber: 4, runAttempt: 1 } });

  test("CS-2 (a): a newer run dispatched and ended UNKNOWN_TARGET_STATE still blocks the older request at S2", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution()); // run 5
    ctx.world.add(older()); // run 4
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 2 }];
    expect(await ctx.coordinator.handleLockRetry(retry(1, "exec-1"))).toMatchObject({ transitionId: "X16" });
    expect(ctx.world.target.lastDeployed).toBeUndefined();
    expect(ctx.world.target.highestDispatched).toMatchObject({ runNumber: 5 });

    const out = await ctx.coordinator.handleLockRetry(retry(1, "exec-2"));
    expect(out).toMatchObject({ transitionId: "X6", status: "SUPERSEDED" });
    expect(ctx.world.item("exec-2").dispatchToken).toBeUndefined();
    expect(ctx.world.item("exec-2").attempt).toBe(0);
    expect(ctx.transport.connects).toBe(1); // only the newer run ever connected
    expect(ctx.world.target.highestDispatched).toMatchObject({ runNumber: 5, executionId: "exec-1" });
    expectAllReleased(ctx);
  });

  test("CS-2 (b): the older run backs off with exit 50, a newer run deploys in between, the older run is then superseded at S2", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution()); // run 5
    ctx.world.add(waitingExecution({ executionId: "exec-3", order: { sourceRef: TEST_SOURCE_REF, runNumber: 6, runAttempt: 1 } }));
    ctx.transport.execScript = [{ kind: "EXIT", exitCode: 50 }, { kind: "EXIT", exitCode: 0 }];
    expect(await ctx.coordinator.handleLockRetry(retry(1, "exec-1"))).toMatchObject({ transitionId: "X14" });
    expect(await ctx.coordinator.handleLockRetry(retry(1, "exec-3"))).toMatchObject({ transitionId: "X12" });
    expect(ctx.world.target.lastDeployed).toMatchObject({ runNumber: 6 });

    const out = await ctx.coordinator.handleLockRetry(retry(2, "exec-1"));
    expect(out).toMatchObject({ transitionId: "X6", status: "SUPERSEDED" });
    expect(ctx.transport.execs).toBe(2);
    expect(ctx.world.target.lastDeployed).toMatchObject({ runNumber: 6 });
    expectAllReleased(ctx);
  });

  test("CS-2 race: S2 reads a stale ordering but the X9 transaction is cancelled by a newer highestDispatched: X6, NO intent written", async () => {
    const ctx = setup({ target: { get: async () => ({}), recordDeployed: async () => ({ written: false, reason: "STALE_FENCING_TOKEN" }) } });
    ctx.world.add(waitingExecution());
    ctx.world.target = { lockKey: TEST_LOCK_KEY, highestDispatched: { sourceRef: TEST_SOURCE_REF, runNumber: 9, executionId: "exec-x" } };
    const out = await ctx.coordinator.handleLockRetry(retry());
    expect(out).toMatchObject({ transitionId: "X6", status: "SUPERSEDED" });
    const item = ctx.world.item();
    expect(item.dispatchToken).toBeUndefined();
    expect(item.attempt).toBe(0);
    expect(ctx.world.events).not.toContain("tx:X9");
    expect(ctx.world.target.highestDispatched?.runNumber).toBe(9);
    expect(ctx.transport.connects).toBe(0);
    expectAllReleased(ctx);
  });
});

describe("crash recovery (DD-28): execStartedAt is the dividing line", () => {
  /** What the reconciler (N-14) would do with an overdue DEPLOYING item. */
  function reconcile(ctx: Ctx): ReturnType<typeof applyTransition> {
    const item = { ...ctx.world.item(), deadlineAt: ctx.world.clock.nowMs - 1 };
    return applyTransition(toExecutionSnapshot(item), { kind: "RECONCILE_OVERDUE_DEPLOYING", now: ctx.world.clock.nowMs });
  }

  test("crash after the intent but BEFORE execStartedAt: DISPATCH_INTERRUPTED (X11), the script provably never started", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.connectScript = ["HANG"];
    const running = ctx.coordinator.handleLockRetry(retry());
    await until(() => ctx.transport.connects === 1, "connect");
    expect(ctx.world.item()).toMatchObject({ status: "DEPLOYING", dispatchToken: "token-1" });
    expect(ctx.world.item().execStartedAt).toBeUndefined();
    const t = reconcile(ctx);
    expect(t).toMatchObject({ accepted: true, transitionId: "X11" });
    expect(t.accepted && t.next.error?.code).toBe("DISPATCH_INTERRUPTED");
    ctx.transport.releaseHangs();
    await running;
  });

  test("crash AFTER execStartedAt, with the script running: UNKNOWN_TARGET_STATE (X16), never DISPATCH_INTERRUPTED", async () => {
    const ctx = setup();
    ctx.world.add(waitingExecution());
    ctx.transport.execScript = ["HANG"];
    const running = ctx.coordinator.handleLockRetry(retry());
    await until(() => ctx.transport.execs === 1, "exec");
    const t = reconcile(ctx);
    expect(t).toMatchObject({ accepted: true, transitionId: "X16" });
    expect(t.accepted && t.effects.appendTargetUnresolved).toBe(true);
    expect(ctx.world.item().execStartedAt).toBeTypeOf("number");
    ctx.transport.releaseHangs();
    await running;
  });
});

describe("Semaphore (design §7.5: bounded SSH concurrency, default 4)", () => {
  test("defaults to 4 and never grants more than its capacity; waiters are served in order; release is idempotent", async () => {
    expect(new Semaphore().capacity).toBe(DEFAULT_SSH_CONCURRENCY);
    expect(DEFAULT_SSH_CONCURRENCY).toBe(4);
    const s = new Semaphore(1);
    const first = await s.acquire();
    const order: string[] = [];
    const second = s.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = s.acquire().then((release) => {
      order.push("third");
      return release;
    });
    await sleep(5);
    expect(s.inUse).toBe(1);
    expect(s.waiting).toBe(2);
    expect(order).toEqual([]);
    first();
    first(); // idempotent: must not free a slot that now belongs to `second`
    const secondRelease = await second;
    expect(order).toEqual(["second"]);
    expect(s.inUse).toBe(1);
    secondRelease();
    (await third)();
    expect(s.inUse).toBe(0);
    expect(order).toEqual(["second", "third"]);
  });
});

describe("deploy-coordinator: platform deploy timeout (design §1.2, AC-02 V1)", () => {
  test.each([0, 61, 1.5, Number.NaN])("refuses deployTimeoutMinutes %s (integer in [1, 60])", (minutes) => {
    expect(() => setup({ deployTimeoutMinutes: minutes })).toThrow(/deployTimeoutMinutes/);
  });

  test("a configured timeout bounds the exec and the DEPLOYING deadline", async () => {
    const ctx = setup({ deployTimeoutMinutes: 30 });
    ctx.world.add(waitingExecution());
    await ctx.coordinator.handleLockRetry({ executionId: "exec-1", attempt: 1 });
    expect(ctx.transport.lastExec?.timeoutMs).toBe(30 * 60_000);
  });
});
