// @akili-spec changes/cicd-executor-poc design §5.1, §7.3, §7.5, DD-28
// In-memory fakes of the deploy-coordinator ports. The storage fakes reproduce
// the conditional-write semantics of the DynamoDB repositories (status +
// version + dispatchToken on the Execution item; monotonic max on
// highestDispatched; owner on the lock), and `FakeTransactions` is ATOMIC like
// the real TransactWriteItems. The real conditions are exercised against
// DynamoDB Local in test/integration.
import { evaluateLockAcquisition } from "../../src/domain/lock-policy/index.js";
import { decideRaiseMax, type TargetOrderingState } from "../../src/domain/supersede-policy/index.js";
import type { ExecutionItem, LockItem, TargetStateItem } from "../../src/adapters/dynamodb-state-store/types.js";
import type { LockAcquireOutcome } from "../../src/adapters/dynamodb-state-store/lock-repository.js";
import type { ExecutionTransitionExpected, ExecutionUpdatePatch } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import type {
  BeginDispatchInput,
  BeginDispatchOutcome,
  MarkUnknownInput,
  MarkUnknownOutcome,
} from "../../src/adapters/dynamodb-state-store/deploy-transactions.js";
import type {
  RecordDeployedInput,
  RecordDeployedOutcome,
} from "../../src/adapters/dynamodb-state-store/target-state-repository.js";
import type {
  DeployExecutionStore,
  DeployLockPort,
  DeployPlan,
  DeployPlanResolver,
  DeployTargetPort,
  DeployTransactionPort,
  WindowRevalidator,
} from "../../src/application/deploy-coordinator/index.js";
import { buildSourceRef } from "../../src/application/execution-service/index.js";
import type { Revalidation, RevalidationPoint } from "../../src/application/deploy-window-service/index.js";
import {
  DeployTransportError,
  type DeploySession,
  type DeployTransport,
  type ScriptExecOutcome,
  type ScriptExecRequest,
} from "../../src/ports/deploy-transport.js";
import type { QueueMessage, QueuePublisher } from "../../src/ports/queue-publisher.js";
import { FakeClock } from "./execution-service-fakes.js";

export const TEST_SOURCE_REF = buildSourceRef({ repository: "<REPOSITORY_REF>", workflow: "<WORKFLOW_REF>", environment: "<ENVIRONMENT_REF>" });
export const TEST_LOCK_KEY = "<LOGICAL_LOCK_KEY>";

export function waitingExecution(over: Partial<ExecutionItem> = {}): ExecutionItem {
  const now = 1_800_000_000_000;
  return {
    executionId: "exec-1",
    deploymentId: "<LOGICAL_DEPLOYMENT>",
    definitionRef: "<DEFINITION_REF>",
    requestId: "100-1",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    artifacts: { app: "sha256:<DIGEST>" },
    order: { sourceRef: TEST_SOURCE_REF, runNumber: 5, runAttempt: 1 },
    ci: { repository: "<REPOSITORY_REF>", runId: "100", workflowRef: "<WORKFLOW_REF>" },
    senderRef: "<SENDER_REF>",
    lockKey: TEST_LOCK_KEY,
    sequence: 1,
    status: "WAITING_LOCK",
    version: 1,
    attempt: 0,
    contentionCount: 0,
    lockWaitStartedAt: now,
    lockWaitAttempts: 0,
    nextAttemptAt: now,
    startedAt: now,
    deadlineAt: now + 120_000,
    activeStatus: "EXECUTION",
    expiresAt: Math.floor(now / 1000) + 1000,
    ...over,
  };
}

/** All fakes share one world so the event log shows the real order of effects across ports. */
export class World {
  public readonly clock = new FakeClock();
  public readonly events: string[] = [];
  public readonly executions = new Map<string, ExecutionItem>();
  public target: TargetStateItem = { lockKey: TEST_LOCK_KEY };
  public lock: LockItem | undefined;
  public lockReleases = 0;
  public renewals = 0;
  /** When set, `renew` refuses (the lease was lost). */
  public renewRefused = false;
  public readonly published: QueueMessage[] = [];

  public add(item: ExecutionItem): ExecutionItem {
    this.executions.set(item.executionId, item);
    return item;
  }

  public item(executionId = "exec-1"): ExecutionItem {
    const item = this.executions.get(executionId);
    if (item === undefined) throw new Error(`no execution ${executionId}`);
    return item;
  }

  public lockIsReleased(): boolean {
    return this.lock !== undefined && this.lock.leaseExpiresAt < this.clock.nowMs;
  }

  /** Another owner takes the lock over (lease lost, a newer fencing token). */
  public stealLock(owner = "exec-other"): void {
    this.lock = {
      lockKey: TEST_LOCK_KEY,
      owner,
      fencingToken: (this.lock?.fencingToken ?? 0) + 1,
      leaseExpiresAt: this.clock.nowMs + 600_000,
      acquiredAt: this.clock.nowMs,
      expiresAt: 0,
    };
  }
}

function applyPatch(item: ExecutionItem, patch: ExecutionUpdatePatch): ExecutionItem {
  const next: Record<string, unknown> = { ...item };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  next.version = item.version + 1;
  return next as unknown as ExecutionItem;
}

function matches(item: ExecutionItem | undefined, expected: ExecutionTransitionExpected): item is ExecutionItem {
  return (
    item !== undefined &&
    item.status === expected.status &&
    item.version === expected.version &&
    (expected.dispatchToken === undefined || item.dispatchToken === expected.dispatchToken)
  );
}

export class FakeExecutions implements DeployExecutionStore {
  public constructor(private readonly world: World) {}
  public async get(executionId: string): Promise<ExecutionItem | undefined> {
    return this.world.executions.get(executionId);
  }
  public async update(executionId: string, expected: ExecutionTransitionExpected, patch: ExecutionUpdatePatch): Promise<boolean> {
    const item = this.world.executions.get(executionId);
    if (!matches(item, expected)) return false;
    const next = applyPatch(item, patch);
    this.world.executions.set(executionId, next);
    this.world.events.push(`update:${next.status}${"execStartedAt" in patch && patch.execStartedAt !== undefined ? ":execStartedAt" : ""}`);
    return true;
  }
}

export class FakeTransactions implements DeployTransactionPort {
  public constructor(private readonly world: World) {}

  public async beginDispatch(input: BeginDispatchInput): Promise<BeginDispatchOutcome> {
    const item = this.world.executions.get(input.executionId);
    const stored = this.world.target.highestDispatched;
    if (!decideRaiseMax(stored, input.dispatched).accepted) return { outcome: "TARGET_CONDITION_FAILED" };
    if (!matches(item, input.expected)) return { outcome: "EXECUTION_CONFLICT" };
    // Both or none.
    this.world.executions.set(input.executionId, applyPatch(item, input.patch));
    this.world.target = { ...this.world.target, highestDispatched: input.dispatched };
    this.world.events.push("tx:X9");
    return { outcome: "COMMITTED" };
  }

  public async markUnknownTargetState(input: MarkUnknownInput): Promise<MarkUnknownOutcome> {
    const item = this.world.executions.get(input.executionId);
    if (!matches(item, input.expected)) return { outcome: "EXECUTION_CONFLICT" };
    this.world.executions.set(input.executionId, applyPatch(item, input.patch));
    this.world.target = { ...this.world.target, unresolved: [...(this.world.target.unresolved ?? []), input.entry] };
    this.world.events.push("tx:X16");
    return { outcome: "COMMITTED" };
  }
}

export class FakeLocks implements DeployLockPort {
  public constructor(private readonly world: World) {}
  public async get(): Promise<LockItem | undefined> {
    return this.world.lock;
  }
  public async acquire(lockKey: string, me: string, now: number, leaseSeconds: number): Promise<LockAcquireOutcome> {
    const current = this.world.lock;
    const decision = evaluateLockAcquisition(
      current === undefined ? undefined : { owner: current.owner, fencingToken: current.fencingToken, leaseExpiresAt: current.leaseExpiresAt },
      me,
      now,
      leaseSeconds,
    );
    if (decision.outcome === "BUSY") return { outcome: "BUSY", owner: decision.owner, leaseExpiresAt: decision.leaseExpiresAt };
    this.world.lock = { lockKey, owner: me, fencingToken: decision.fencingToken, leaseExpiresAt: decision.leaseExpiresAt, acquiredAt: now, expiresAt: 0 };
    this.world.events.push("lock:acquired");
    const alreadyHeld = decision.reason === "REENTRANT" && current !== undefined && current.leaseExpiresAt >= now;
    return { outcome: "ACQUIRED", fencingToken: decision.fencingToken, leaseExpiresAt: decision.leaseExpiresAt, alreadyHeld };
  }
  public async renew(_lockKey: string, owner: string, now: number, leaseSeconds: number): Promise<boolean> {
    if (this.world.renewRefused || this.world.lock?.owner !== owner) return false;
    this.world.renewals += 1;
    this.world.lock = { ...this.world.lock, leaseExpiresAt: now + leaseSeconds * 1000 };
    return true;
  }
  public async release(_lockKey: string, owner: string, now: number): Promise<boolean> {
    if (this.world.lock?.owner !== owner) return false;
    this.world.lock = { ...this.world.lock, leaseExpiresAt: now - 1 };
    this.world.lockReleases += 1;
    this.world.events.push("lock:released");
    return true;
  }
}

export class FakeTarget implements DeployTargetPort {
  public constructor(private readonly world: World) {}
  public async get(): Promise<TargetOrderingState | undefined> {
    return this.world.target;
  }
  public async recordDeployed(input: RecordDeployedInput): Promise<RecordDeployedOutcome> {
    const stored = this.world.target.fencingToken;
    if (stored !== undefined && stored > input.fencingToken) return { written: false, reason: "STALE_FENCING_TOKEN" };
    this.world.target = {
      ...this.world.target,
      lastDeployed: input.lastDeployed,
      ...(input.currentImages === undefined ? {} : { currentImages: { ...input.currentImages } }),
      fencingToken: input.fencingToken,
    };
    this.world.events.push("target:lastDeployed");
    return { written: true };
  }
}

export class FakeWindows implements WindowRevalidator {
  public readonly points: RevalidationPoint[] = [];
  /** Points that fail from now on. */
  public readonly deny = new Set<RevalidationPoint>();
  public async revalidate(point: RevalidationPoint): Promise<Revalidation> {
    this.points.push(point);
    if (!this.deny.has(point)) return { ok: true, point };
    return {
      ok: false,
      point,
      failureCode: "DEPLOY_WINDOW_CLOSED",
      transition: { V1: "X4", V2: "X8", V3: "X15", V4: "X10" }[point] as "X4" | "X8" | "X15" | "X10",
      reason: "WINDOW_CLOSED",
    };
  }
}

export class FakePlans implements DeployPlanResolver {
  public readonly plan: DeployPlan = {
    targetRef: "<TARGET_REF>",
    timeoutMinutes: 10,
    scriptArgs: (fencingToken) => ["--lock-key", TEST_LOCK_KEY, "--fencing-token", String(fencingToken)],
  };
  public async resolve(): Promise<DeployPlan> {
    return this.plan;
  }
}

export class FakeQueue implements QueuePublisher {
  public constructor(private readonly world: World) {}
  public async publish(message: QueueMessage): Promise<{ messageId: string }> {
    this.world.published.push(message);
    // Snapshot of the persisted state AT publication time: CW-2 (persist, then publish).
    this.world.events.push(`publish:${String(this.world.executions.get("exec-1")?.status)}`);
    return { messageId: `m-${String(this.world.published.length)}` };
  }
}

export type ExecScript = ScriptExecOutcome | "HANG" | "THROW";

/** Scripted transport: one `connect` behaviour list, one `exec` behaviour list. */
export class FakeTransport implements DeployTransport {
  public connectScript: Array<"OK" | "SSH_CONNECT" | "HOST_KEY_MISMATCH" | "HANG"> = ["OK"];
  public execScript: ExecScript[] = [{ kind: "EXIT", exitCode: 0 }];
  public connects = 0;
  public delivers = 0;
  public execs = 0;
  public opened = 0;
  public closed = 0;
  public lastExec: ScriptExecRequest | undefined;
  /** Runs inside `exec`, while the script "runs". */
  public duringExec: (() => Promise<void>) | undefined;
  /** Item snapshot at the moment `exec` was entered (DD-28: execStartedAt must already be persisted). */
  public atExec: (() => void) | undefined;
  private readonly hangs: Array<() => void> = [];

  public constructor(private readonly world: World) {}

  public get openSessions(): number {
    return this.opened - this.closed;
  }

  /** Resolves every hung call (a "crashed" worker is let go at the end of a test). */
  public releaseHangs(): void {
    for (const release of this.hangs.splice(0)) release();
  }

  public async connect(): Promise<DeploySession> {
    this.connects += 1;
    const behaviour = this.connectScript.shift() ?? "OK";
    if (behaviour === "HANG") await new Promise<void>((resolve) => this.hangs.push(resolve));
    if (behaviour === "SSH_CONNECT" || behaviour === "HANG") throw new DeployTransportError("SSH_CONNECT", "connect failed");
    if (behaviour === "HOST_KEY_MISMATCH") throw new DeployTransportError("HOST_KEY_MISMATCH", "host key");
    this.opened += 1;
    let closed = false;
    return {
      deliverScript: async () => {
        this.delivers += 1;
      },
      exec: async (request) => {
        this.execs += 1;
        this.lastExec = request;
        this.world.events.push("exec");
        this.atExec?.();
        const behaviourExec = this.execScript.shift() ?? { kind: "EXIT", exitCode: 0 };
        if (this.duringExec !== undefined) await this.duringExec();
        if (behaviourExec === "HANG") {
          await new Promise<void>((resolve) => this.hangs.push(resolve));
          return { kind: "SESSION_LOST" };
        }
        if (behaviourExec === "THROW") throw new Error("connection reset");
        return behaviourExec;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.closed += 1;
      },
    };
  }
}
