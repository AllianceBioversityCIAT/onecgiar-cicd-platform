// @akili-spec changes/cicd-executor-poc design §1.2, §6.5, §7 (deploy-coordinator row), §7.1, §7.2, §7.3 (X4-X16), §7.5, §7.6, DD-04, DD-09, DD-22, DD-27, DD-28; requirements FR-11, FR-12, FR-13, FR-16, FR-23, FR-24, RL-1, RL-4, RL-7; tasks R-5 (AC-02 V1)
// Deploy coordinator (N-12). Drives an execution from QUEUED to a terminal
// state through X4-X16 of the closed state machine (every decision is
// `applyTransition`; this module supplies the facts and performs the writes).
// It COORDINATES: it never builds, never connects to application databases,
// never reads application secrets, never aborts a running script and never
// re-runs one (design §7 Forbidden).
//
// Two entry points, both safe to redeliver (every write is conditional):
//   - evaluateQueued(executionId): V1, then X4 (window closed) or X5 (enter the
//     lock wait) followed by the first LOCK_RETRY_REQUESTED.
//   - handleLockRetry(event): one lock attempt. Order of §7.5:
//       window (V2) -> distributed lock -> S2 -> intent (X9) -> SSH semaphore ->
//       session -> V4 -> execStartedAt -> exec of the target's deployScript ->
//       (target mutex: the script)
//     and everything is released in reverse on EVERY exit path.
//
// AC-02 V1: everything about the target comes from the execution's snapshot
// (design §5.1, §6.3): host, port, user, host key, credential reference, script
// path and window policy. The lock key is the `targetId` (design §1.2). The
// script lives on the target; nothing is delivered (no SFTP, no checksum), and
// it runs with the fixed argument vector of design §6.5.
//
// Crash safety (DD-28): X9 writes the intent and `highestDispatched`
// atomically; `execStartedAt` is written for the current dispatchToken
// IMMEDIATELY before exec. A crash before it is provably "script not started"
// (X11 DISPATCH_INTERRUPTED, by the reconciler); after it, X16. There is no
// blind retry after `execStartedAt`.
//
// Lock-wait persistence order (CW-2): persist `nextAttemptAt`, THEN publish
// LOCK_RETRY_REQUESTED, THEN let the caller acknowledge.
//
// Event `attempt` convention: a LOCK_RETRY_REQUESTED carries the dispatch
// attempt it may start, i.e. `execution.attempt + 1` at publication time (the
// schema requires >= 1). A message whose `attempt` differs from the execution's
// current `attempt + 1` is stale and is a no-op (design §7.3).
import { randomUUID } from "node:crypto";
import {
  applyTransition,
  type ExecutionSnapshot,
  type ExecutionStatus,
  type TransitionId,
  type TransitionResult,
} from "../../domain/state-machine/index.js";
import { classifyExitCode } from "../../domain/errors/index.js";
import { LOCK_RENEWAL_INTERVAL_SECONDS, nextLockRetry } from "../../domain/lock-policy/index.js";
import { evaluateS2, type OrderingValue } from "../../domain/supersede-policy/index.js";
import type { LockRetryRequestedEvent } from "../../domain/request-contract/index.js";
import {
  DeployTransportError,
  type DeploySession,
  type DeployTransport,
  type ScriptExecOutcome,
} from "../../ports/deploy-transport.js";
import type { QueuePublisher } from "../../ports/queue-publisher.js";
import type { Clock } from "../../ports/clock.js";
import type { ExecutionUpdatePatch } from "../../adapters/dynamodb-state-store/execution-repository.js";
import type { ExecutionItem } from "../../adapters/dynamodb-state-store/types.js";
import type { SshTarget } from "../../ports/deploy-transport.js";
import type { WindowTarget } from "../deploy-window-service/index.js";
import { OrderingSourceMismatchError } from "../execution-service/index.js";
import type {
  DeployExecutionStore,
  DeployLockPort,
  DeployTargetPort,
  DeployTransactionPort,
  WindowRevalidator,
} from "./ports.js";
import type { Semaphore } from "./semaphore.js";
import { toExecutionSnapshot } from "./snapshot.js";

export { Semaphore, DEFAULT_SSH_CONCURRENCY } from "./semaphore.js";
export { toExecutionSnapshot } from "./snapshot.js";
export type {
  DeployExecutionStore,
  DeployLockPort,
  DeployTargetPort,
  DeployTransactionPort,
  WindowRevalidator,
} from "./ports.js";

/** Lease of the distributed lock, three renewal intervals (DD-09): one missed renewal never loses the lock. */
export const LOCK_LEASE_SECONDS = 3 * LOCK_RENEWAL_INTERVAL_SECONDS;
/** `WAITING_LOCK` deadline grace after `nextAttemptAt` (design §7.1). */
export const WAITING_LOCK_GRACE_MS = 2 * 60 * 1000;
/** `DEPLOYING` deadline grace after intent + timeout (design §7.1). */
export const DEPLOYING_GRACE_MS = 5 * 60 * 1000;
/** Connection retries before exec (design §7.2: `SSH_CONNECT` after 2 retries). */
export const SSH_CONNECT_RETRIES = 2;
/** Largest `logTail` persisted (the transport is expected to redact; this only bounds the item size). */
export const LOG_TAIL_MAX_CHARS = 4096;
/** Platform deploy timeout (design §1.2: `deployTimeoutMinutes` = 20, at most 60). */
export const DEFAULT_DEPLOY_TIMEOUT_MINUTES = 20;
export const MAX_DEPLOY_TIMEOUT_MINUTES = 60;

/** What the coordinator needs to run one deployment, built from the execution's snapshot (design §6.5). */
export interface DeployPlan {
  readonly target: SshTarget;
  readonly window: WindowTarget;
  readonly scriptPath: string;
  readonly timeoutMinutes: number;
  /** Script arguments (design §6.5), one element per argument; the fencing token is the lock's. */
  scriptArgs(fencingToken: number): readonly string[];
}

/**
 * The deploy plan of an execution (design §6.5): the fixed argument vector
 * `--target-id --execution-id --fencing-token --commit-sha` and one
 * `--artifact <unit>=sha256:<64-hex>` per request artifact (sorted by unit, so the
 * vector is deterministic). Every value was validated by the request schema or
 * is Executor-generated; the transport also refuses line breaks and quotes every
 * element. Nothing application-specific is added here.
 */
export function deployPlanOf(item: ExecutionItem, timeoutMinutes: number = DEFAULT_DEPLOY_TIMEOUT_MINUTES): DeployPlan {
  const s = item.targetSnapshot;
  const artifacts = Object.keys(item.artifacts)
    .sort()
    .flatMap((unit) => ["--artifact", `${unit}=${item.artifacts[unit] as string}`]);
  return {
    target: {
      targetId: item.targetId,
      host: s.host,
      ...(s.port === undefined ? {} : { port: s.port }),
      user: s.user,
      hostKey: s.hostKey,
      credentialRef: s.credentialRef,
    },
    window: { targetId: item.targetId, deployWindowPolicy: s.deployWindowPolicy },
    scriptPath: s.deployScript,
    timeoutMinutes,
    scriptArgs: (fencingToken) => [
      "--target-id",
      item.targetId,
      "--execution-id",
      item.executionId,
      "--fencing-token",
      String(fencingToken),
      "--commit-sha",
      item.commitSha,
      ...artifacts,
    ],
  };
}

export type DeployOutcome =
  | { readonly outcome: "NOOP"; readonly reason: "NOT_FOUND" | "STALE" | "CONFLICT" }
  | { readonly outcome: "RETRY_SCHEDULED"; readonly delaySeconds: number; readonly lockWaitAttempts: number }
  | { readonly outcome: "TRANSITIONED"; readonly transitionId: TransitionId; readonly status: ExecutionStatus };

export interface DeployCoordinatorDeps {
  readonly executions: DeployExecutionStore;
  readonly transactions: DeployTransactionPort;
  readonly locks: DeployLockPort;
  readonly target: DeployTargetPort;
  readonly windows: WindowRevalidator;
  readonly transport: DeployTransport;
  /** Platform `deployTimeoutMinutes` (design §1.2); default 20, at most 60. */
  readonly deployTimeoutMinutes?: number;
  readonly queue: QueuePublisher;
  readonly clock: Clock;
  readonly semaphore: Semaphore;
  /** Dispatch-token generator (DD-28); defaults to a random UUID. */
  readonly newDispatchToken?: () => string;
  readonly newEventId?: () => string;
  /** Lease renewal cadence in ms; defaults to LOCK_RENEWAL_INTERVAL_SECONDS. Injectable for tests. */
  readonly renewalIntervalMs?: number;
  /** Called when releasing a resource fails; the failure never masks the outcome (a lock lease expires by itself). */
  readonly onCleanupError?: (error: unknown, resource: "session" | "lock" | "renewal" | "window") => void;
}

export interface DeployCoordinator {
  evaluateQueued(executionId: string): Promise<DeployOutcome>;
  handleLockRetry(event: Pick<LockRetryRequestedEvent, "executionId" | "attempt">): Promise<DeployOutcome>;
}

type Accepted = Extract<TransitionResult, { accepted: true }>;

function accept(t: TransitionResult): Accepted {
  if (!t.accepted) {
    throw new Error("deploy-coordinator: the state machine refused a transition the coordinator derived itself (INVALID_TRANSITION)");
  }
  return t;
}

/** Turns an accepted transition into the persisted patch: cleared fields are removed, terminal states leave GSI2 (sparse). Exported for the reconciler, which must write the same canonical results (X7, X11, X16, X3). */
export function buildPatch(
  t: Accepted,
  now: number,
  opts: { deadlineAt?: number; extra?: Record<string, unknown> } = {},
): ExecutionUpdatePatch {
  const n = t.next;
  const patch: Record<string, unknown> = {};
  for (const field of t.effects.clear) patch[field] = undefined;
  patch.status = n.status;
  patch.attempt = n.attempt;
  patch.contentionCount = n.contentionCount;
  if (n.dispatchToken !== undefined) patch.dispatchToken = n.dispatchToken;
  if (n.lockWaitStartedAt !== undefined) patch.lockWaitStartedAt = n.lockWaitStartedAt;
  if (n.lockWaitAttempts !== undefined) patch.lockWaitAttempts = n.lockWaitAttempts;
  if (n.nextAttemptAt !== undefined) patch.nextAttemptAt = n.nextAttemptAt;
  if (n.error !== undefined && !t.effects.clear.includes("error")) patch.error = { code: n.error.code };
  if (t.effects.terminal) {
    patch.activeStatus = undefined;
    patch.deadlineAt = undefined;
    patch.finishedAt = now;
  } else {
    if (opts.deadlineAt === undefined) {
      throw new Error("deploy-coordinator: a non-terminal transition needs a deadlineAt (GSI2)");
    }
    patch.activeStatus = "EXECUTION";
    patch.deadlineAt = opts.deadlineAt;
  }
  Object.assign(patch, opts.extra ?? {});
  return patch as unknown as ExecutionUpdatePatch;
}

/** Resources of one lock attempt, released in reverse order of acquisition on every exit (design §7.5). */
interface Resources {
  lockHeld: boolean;
  /** Timeout / lost session: the script may still hold the target mutex, so the lock is NOT released (lease expires, runbook §12.1). */
  keepLock: boolean;
  releaseSlot?: () => void;
  session?: DeploySession;
  stopRenewal?: () => Promise<{ readonly lost: boolean }>;
  renewalLost?: boolean;
}

interface Attempt {
  readonly item: ExecutionItem;
  readonly plan: DeployPlan;
  readonly fencingToken: number;
  readonly token: string;
  version: number;
  readonly deadlineAt: number;
  /** Snapshot as persisted by X9 (plus `execStartedAt` once phase 2 is written). */
  current: ExecutionSnapshot;
  readonly res: Resources;
}

export function createDeployCoordinator(deps: DeployCoordinatorDeps): DeployCoordinator {
  const newDispatchToken = deps.newDispatchToken ?? randomUUID;
  const newEventId = deps.newEventId ?? randomUUID;
  const renewalIntervalMs = deps.renewalIntervalMs ?? LOCK_RENEWAL_INTERVAL_SECONDS * 1000;
  const timeoutMinutes = deps.deployTimeoutMinutes ?? DEFAULT_DEPLOY_TIMEOUT_MINUTES;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > MAX_DEPLOY_TIMEOUT_MINUTES) {
    throw new Error(`deploy-coordinator: deployTimeoutMinutes must be an integer in [1, ${String(MAX_DEPLOY_TIMEOUT_MINUTES)}]`);
  }
  const planFor = (item: ExecutionItem): DeployPlan => deployPlanOf(item, timeoutMinutes);
  const nowMs = (): number => deps.clock.now().getTime();

  const transitioned = (t: Accepted): DeployOutcome => ({
    outcome: "TRANSITIONED",
    transitionId: t.transitionId,
    status: t.next.status,
  });
  const conflict: DeployOutcome = { outcome: "NOOP", reason: "CONFLICT" };

  /** Publish half of CW-2: the caller has ALREADY persisted `nextAttemptAt`. */
  async function publishRetry(executionId: string, attempt: number, delaySeconds: number): Promise<void> {
    const event: LockRetryRequestedEvent = {
      specVersion: 1,
      eventId: newEventId(),
      eventType: "LOCK_RETRY_REQUESTED",
      timestamp: deps.clock.now().toISOString(),
      source: "executor",
      executionId,
      attempt,
    };
    await deps.queue.publish({ body: { ...event }, delaySeconds });
  }

  // -------------------------------------------------------------------
  // X4 / X5
  // -------------------------------------------------------------------
  async function evaluateQueued(executionId: string): Promise<DeployOutcome> {
    const item = await deps.executions.get(executionId);
    if (item === undefined) return { outcome: "NOOP", reason: "NOT_FOUND" };
    if (item.status !== "QUEUED") return { outcome: "NOOP", reason: "STALE" };
    const plan = planFor(item);
    const now = nowMs();
    const v1 = await deps.windows.revalidate("V1", plan.window, now + plan.timeoutMinutes * 60_000);
    const t = accept(applyTransition(toExecutionSnapshot(item), { kind: "EVALUATE_QUEUED", v1Valid: v1.ok, now }));
    const patch = buildPatch(t, now, {
      deadlineAt: now + WAITING_LOCK_GRACE_MS,
      extra: t.transitionId === "X5" ? { lockWaitAttempts: 0 } : {},
    });
    if (!(await deps.executions.update(executionId, { status: "QUEUED", version: item.version }, patch))) return conflict;
    if (t.transitionId === "X5") await publishRetry(executionId, item.attempt + 1, 0);
    return transitioned(t);
  }

  // -------------------------------------------------------------------
  // One lock attempt
  // -------------------------------------------------------------------
  async function handleLockRetry(event: Pick<LockRetryRequestedEvent, "executionId" | "attempt">): Promise<DeployOutcome> {
    const item = await deps.executions.get(event.executionId);
    if (item === undefined) return { outcome: "NOOP", reason: "NOT_FOUND" };
    // A redelivered or duplicated message with a stale attempt, or an execution that moved on, is a no-op (design §7.3).
    if (item.status !== "WAITING_LOCK" || event.attempt !== item.attempt + 1) return { outcome: "NOOP", reason: "STALE" };

    const plan = planFor(item);
    const now = nowMs();
    const snapshot = toExecutionSnapshot(item);
    const waitingExpected = { status: "WAITING_LOCK", version: item.version } as const;

    // X7 first: an exhausted budget never tries the lock again (canonical LOCK_TIMEOUT).
    const x7 = applyTransition(snapshot, { kind: "LOCK_WAIT_TIMEOUT", now });
    if (x7.accepted) {
      const done = await deps.executions.update(item.executionId, waitingExpected, buildPatch(x7, now));
      return done ? transitioned(x7) : conflict;
    }

    // V2 on every lock attempt (X8).
    const v2 = await deps.windows.revalidate("V2", plan.window, now + plan.timeoutMinutes * 60_000);
    if (!v2.ok) {
      const x8 = accept(applyTransition(snapshot, { kind: "WAITING_WINDOW_CLOSED", v2Valid: false }));
      const done = await deps.executions.update(item.executionId, waitingExpected, buildPatch(x8, now));
      return done ? transitioned(x8) : conflict;
    }

    const lock = await deps.locks.acquire(item.targetId, item.executionId, now, LOCK_LEASE_SECONDS);
    if (lock.outcome !== "ACQUIRED") return failedLockAttempt(item, now);

    // A re-entrant acquisition (a duplicate or concurrent attempt of this same execution) did not take the lock
    // fresh: it must not release it unless it goes on to own the attempt by committing X9 (design §7.5, DD-09/DD-22).
    const res: Resources = { lockHeld: true, keepLock: lock.alreadyHeld };
    res.stopRenewal = startRenewal(item);
    try {
      return await underLock(item, plan, lock.fencingToken, res);
    } finally {
      await cleanup(item, res);
    }
  }

  /** Busy lock (or a lost race): bump `lockWaitAttempts`, persist `nextAttemptAt`, THEN publish (CW-2). */
  async function failedLockAttempt(item: ExecutionItem, now: number): Promise<DeployOutcome> {
    const attempts = item.lockWaitAttempts ?? 0;
    const newAttempts = attempts + 1;
    const decision = nextLockRetry({ lockWaitStartedAt: item.lockWaitStartedAt ?? now, lockWaitAttempts: attempts, now });
    const expected = { status: "WAITING_LOCK", version: item.version } as const;
    if (decision.action === "LOCK_TIMEOUT") {
      // The failed attempt counts: the 10-attempt cap is reached by this one (design §7.6).
      const x7 = accept(
        applyTransition({ ...toExecutionSnapshot(item), lockWaitAttempts: newAttempts }, { kind: "LOCK_WAIT_TIMEOUT", now }),
      );
      const done = await deps.executions.update(item.executionId, expected, buildPatch(x7, now, { extra: { lockWaitAttempts: newAttempts } }));
      return done ? transitioned(x7) : conflict;
    }
    const nextAttemptAt = now + decision.delaySeconds * 1000;
    const done = await deps.executions.update(item.executionId, expected, {
      lockWaitAttempts: newAttempts,
      nextAttemptAt,
      activeStatus: "EXECUTION",
      deadlineAt: nextAttemptAt + WAITING_LOCK_GRACE_MS,
    });
    if (!done) return conflict;
    await publishRetry(item.executionId, item.attempt + 1, decision.delaySeconds);
    return { outcome: "RETRY_SCHEDULED", delaySeconds: decision.delaySeconds, lockWaitAttempts: newAttempts };
  }

  // -------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------
  async function stopRenewal(res: Resources): Promise<boolean> {
    if (res.stopRenewal !== undefined) {
      const stop = res.stopRenewal;
      res.stopRenewal = undefined;
      res.renewalLost = (await stop()).lost;
    }
    return res.renewalLost === true;
  }

  /** Idempotent: safe to call from the busy path and again from `finally`. */
  async function cleanup(item: ExecutionItem, res: Resources): Promise<void> {
    try {
      await stopRenewal(res);
    } catch (error) {
      deps.onCleanupError?.(error, "renewal");
    }
    if (res.session !== undefined) {
      const session = res.session;
      res.session = undefined;
      try {
        await session.close();
      } catch (error) {
        deps.onCleanupError?.(error, "session");
      }
    }
    if (res.releaseSlot !== undefined) {
      res.releaseSlot();
      res.releaseSlot = undefined;
    }
    if (res.lockHeld && !res.keepLock) {
      res.lockHeld = false;
      try {
        await deps.locks.release(item.targetId, item.executionId, nowMs());
      } catch (error) {
        deps.onCleanupError?.(error, "lock");
      }
    }
  }

  /** Renews the lease every interval while the lock is held; reports whether a renewal was ever refused. */
  function startRenewal(item: ExecutionItem): () => Promise<{ readonly lost: boolean }> {
    let lost = false;
    let inflight: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      inflight = inflight.then(async () => {
        if (lost) return;
        try {
          if (!(await deps.locks.renew(item.targetId, item.executionId, nowMs(), LOCK_LEASE_SECONDS))) {
            lost = true;
            clearInterval(timer);
          }
        } catch (error) {
          // A transient store error is not a verdict: the next tick retries (the lease has slack for it).
          deps.onCleanupError?.(error, "renewal");
        }
      });
    }, renewalIntervalMs);
    return async () => {
      clearInterval(timer);
      await inflight;
      return { lost };
    };
  }

  /**
   * Re-checks the window once the script has exited (design §7.7). Uses the V3 revalidation with `needUntil = now`:
   * the question is only "is a window still valid at this moment". Best effort: a failed check must not lose the
   * script's real result, so it is reported and treated as "not closed".
   */
  async function windowClosedDuringRun(item: ExecutionItem): Promise<boolean> {
    try {
      return !(await deps.windows.revalidate("V3", planFor(item).window, nowMs())).ok;
    } catch (error) {
      deps.onCleanupError?.(error, "window");
      return false;
    }
  }

  /** Coordinator half of the §5.1 condition on `lastDeployed`: we still own the lock with the fencing token we hold. */
  async function ownsLock(item: ExecutionItem, fencingToken: number): Promise<boolean> {
    const lock = await deps.locks.get(item.targetId);
    return lock !== undefined && lock.owner === item.executionId && lock.fencingToken === fencingToken;
  }

  // -------------------------------------------------------------------
  // Under the lock: S2, X9, then the attempt
  // -------------------------------------------------------------------
  async function underLock(item: ExecutionItem, plan: DeployPlan, fencingToken: number, res: Resources): Promise<DeployOutcome> {
    const snapshot = toExecutionSnapshot(item);
    const ordering: OrderingValue = { sourceRef: item.order.sourceRef, runNumber: item.order.runNumber };

    // S2 (authoritative): against max(lastDeployed, highestDispatched).
    const s2 = evaluateS2(ordering, (await deps.target.get(item.targetId)) ?? {});
    if (s2.decision === "REJECTED_SOURCE_MISMATCH") throw new OrderingSourceMismatchError(item.executionId);
    if (s2.decision === "SUPERSEDED") return supersedeUnderLock(item, res);

    // X9: intent + highestDispatched in ONE transaction.
    const now = nowMs();
    const token = newDispatchToken();
    const x9 = accept(
      applyTransition(snapshot, { kind: "BEGIN_DISPATCH", v2Valid: true, lockAcquired: true, superseded: false, newDispatchToken: token }),
    );
    const deadlineAt = now + plan.timeoutMinutes * 60_000 + DEPLOYING_GRACE_MS;
    const begun = await deps.transactions.beginDispatch({
      executionId: item.executionId,
      expected: { status: "WAITING_LOCK", version: item.version },
      patch: buildPatch(x9, now, { deadlineAt, extra: { fencingToken } }),
      lockKey: item.targetId,
      dispatched: { ...ordering, executionId: item.executionId },
      now,
    });
    // A cancelled transaction wrote NOTHING: a newer dispatch won the race after S2 read, so this one is superseded (CS-2).
    if (begun.outcome === "TARGET_CONDITION_FAILED") return supersedeUnderLock(item, res);
    if (begun.outcome === "EXECUTION_CONFLICT") {
      await keepLockIfSiblingDispatched(item, res);
      return conflict;
    }
    // This handler committed the intent: it owns the attempt and releases the lock at its exit.
    res.keepLock = false;

    return runAttempt({ item, plan, fencingToken, token, version: item.version + 1, deadlineAt, current: x9.next, res });
  }

  async function supersedeUnderLock(item: ExecutionItem, res: Resources): Promise<DeployOutcome> {
    const x6 = accept(applyTransition(toExecutionSnapshot(item), { kind: "SUPERSEDE_UNDER_LOCK", superseded: true, lockHeld: true }));
    const done = await deps.executions.update(item.executionId, { status: "WAITING_LOCK", version: item.version }, buildPatch(x6, nowMs()));
    if (!done) {
      await keepLockIfSiblingDispatched(item, res);
      return conflict;
    }
    // The execution is terminal: no script will run for it, so the lock is released by whoever finishes this.
    res.keepLock = false;
    return transitioned(x6);
  }

  /**
   * Lost an X9/X6 race. If a sibling attempt of the SAME execution dispatched (it is DEPLOYING), the lock is
   * its to release: keep it here. A stale keep only lasts until the lease expires, which is safe (DD-09).
   */
  async function keepLockIfSiblingDispatched(item: ExecutionItem, res: Resources): Promise<void> {
    const fresh = await deps.executions.get(item.executionId);
    if (fresh?.status === "DEPLOYING") res.keepLock = true;
  }

  /** Conditional write of a DEPLOYING-row transition (X10-X15): status + version + dispatchToken. */
  async function commitDeploying(
    a: Attempt,
    t: Accepted,
    now: number,
    extra?: Record<string, unknown>,
    deadlineAt?: number,
  ): Promise<DeployOutcome> {
    const patch = buildPatch(t, now, {
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(extra === undefined ? {} : { extra }),
    });
    const done = await deps.executions.update(
      a.item.executionId,
      { status: "DEPLOYING", version: a.version, dispatchToken: a.token },
      patch,
    );
    return done ? transitioned(t) : conflict;
  }

  async function runAttempt(a: Attempt): Promise<DeployOutcome> {
    const { item, plan, res } = a;

    // SSH semaphore, then session (waiting for a slot holds none of the later resources).
    res.releaseSlot = await deps.semaphore.acquire();

    let connectError: DeployTransportError | undefined;
    for (let tries = 0; tries <= SSH_CONNECT_RETRIES; tries += 1) {
      try {
        res.session = await deps.transport.connect(plan.target);
        connectError = undefined;
        break;
      } catch (error) {
        if (!(error instanceof DeployTransportError)) throw error;
        connectError = error;
        if (error.code === "HOST_KEY_MISMATCH") break; // never retried
      }
    }
    if (res.session === undefined) {
      const code = connectError?.code ?? "SSH_CONNECT";
      const x11 = accept(applyTransition(a.current, { kind: "FAIL_BEFORE_EXEC", dispatchToken: a.token, code }));
      return commitDeploying(a, x11, nowMs());
    }
    // V4 immediately before exec (X10).
    const v4 = await deps.windows.revalidate("V4", plan.window, nowMs() + plan.timeoutMinutes * 60_000);
    if (!v4.ok) {
      const x10 = accept(applyTransition(a.current, { kind: "WINDOW_CLOSED_BEFORE_EXEC", dispatchToken: a.token, v4Valid: false }));
      return commitDeploying(a, x10, nowMs());
    }

    // DD-28 phase 2: `execStartedAt` for THIS dispatchToken, immediately BEFORE exec.
    const startedAt = nowMs();
    const marked = await deps.executions.update(
      item.executionId,
      { status: "DEPLOYING", version: a.version, dispatchToken: a.token },
      { execStartedAt: startedAt, activeStatus: "EXECUTION", deadlineAt: a.deadlineAt },
    );
    if (!marked) return conflict; // the attempt was taken over: do NOT exec
    a.version += 1;
    a.current = { ...a.current, execStartedAt: startedAt };

    let outcome: ScriptExecOutcome;
    try {
      outcome = await res.session.exec({
        executionId: item.executionId,
        scriptPath: plan.scriptPath,
        args: plan.scriptArgs(a.fencingToken),
        timeoutMs: plan.timeoutMinutes * 60_000,
      });
    } catch {
      outcome = { kind: "SESSION_LOST" }; // never re-run: the script may have started
    }
    return mapOutcome(a, outcome);
  }

  // -------------------------------------------------------------------
  // Exit mapping (X12-X16)
  // -------------------------------------------------------------------
  async function mapOutcome(a: Attempt, outcome: ScriptExecOutcome): Promise<DeployOutcome> {
    const { item, res } = a;
    const now = nowMs();

    if (outcome.kind !== "EXIT") {
      // Timeout with the script running, or a lost session: the script may still hold the target mutex (it ignores HUP).
      // Renewal stops, the lock is NOT released, the lease expires (design §7.5, runbook §12.1).
      res.keepLock = true;
      const lost = await stopRenewal(res);
      const x16 = accept(applyTransition(a.current, { kind: "SESSION_LOST", dispatchToken: a.token }));
      return commitUnknown(a, x16, now, lost ? { lockLostDuringRun: true } : {});
    }

    const exit = classifyExitCode(outcome.exitCode);
    const logTail = outcome.logTail?.slice(-LOG_TAIL_MAX_CHARS);
    const result = {
      code: outcome.exitCode,
      ...(outcome.cicdResult === undefined ? {} : { cicdResult: JSON.stringify(outcome.cicdResult) }),
      ...(logTail === undefined ? {} : { logTail }),
    };

    if (exit.kind === "TARGET_BUSY") return handleBusy(a, result);

    const renewalLost = await stopRenewal(res);
    const ownershipLost = renewalLost || !(await ownsLock(item, a.fencingToken));
    const lostFlag = {
      ...(ownershipLost ? { lockLostDuringRun: true } : {}),
      // FR-24 / design §7.7: the script is never aborted; a window that closed during the run is recorded (and notified by N-16).
      ...((await windowClosedDuringRun(item)) ? { windowClosedDuringRun: true } : {}),
      // Exits 0/10/20/30/40 guarantee CICD_RESULT (design §6.5): flag its absence instead of inventing data.
      ...(exit.kind !== "UNKNOWN" && outcome.cicdResult === undefined ? { cicdResultMissing: true } : {}),
    };
    const t = accept(
      applyTransition(a.current, {
        kind: "SCRIPT_EXITED",
        dispatchToken: a.token,
        exitCode: outcome.exitCode,
        v3Valid: true,
        now,
        nextAttemptAt: now,
      }),
    );

    if (exit.kind === "UNKNOWN") return commitUnknown(a, t, now, { ...lostFlag, result });
    if (exit.kind === "FAILED") return commitDeploying(a, t, now, { ...lostFlag, result });

    // X12: `lastDeployed` only while we are the lock owner, and fenced by the store as well.
    let targetWriteRejected = ownershipLost;
    if (!ownershipLost) {
      const written = await deps.target.recordDeployed({
        lockKey: item.targetId,
        fencingToken: a.fencingToken,
        lastDeployed: {
          sourceRef: item.order.sourceRef,
          runNumber: item.order.runNumber,
          executionId: item.executionId,
          commitSha: item.commitSha,
        },
        // Never fabricated: without a CICD_RESULT the stored images stay untouched (the execution is flagged cicdResultMissing).
        ...(outcome.cicdResult?.deployedImages === undefined ? {} : { currentImages: outcome.cicdResult.deployedImages }),
        ...(outcome.cicdResult?.previousImages === undefined ? {} : { previousImages: outcome.cicdResult.previousImages }),
        updatedAt: now,
      });
      targetWriteRejected = !written.written;
    }
    return commitDeploying(a, t, now, {
      ...lostFlag,
      result,
      ...(targetWriteRejected ? { targetWriteRejected: true } : {}),
    });
  }

  /** Exit 50: the target mutex was held and nothing was done. X14 (budget left, V3 OK) or X15; resources are released BEFORE the write. */
  async function handleBusy(a: Attempt, result: Record<string, unknown>): Promise<DeployOutcome> {
    const { item, plan, res } = a;
    const now = nowMs();
    const attempts = (item.lockWaitAttempts ?? 0) + 1;
    const v3 = await deps.windows.revalidate("V3", plan.window, now + plan.timeoutMinutes * 60_000);
    const retry = nextLockRetry({
      lockWaitStartedAt: a.current.lockWaitStartedAt ?? now,
      lockWaitAttempts: attempts - 1,
      now,
    });
    const delaySeconds = retry.action === "RETRY" ? retry.delaySeconds : 0;
    const nextAttemptAt = now + delaySeconds * 1000;
    const t = accept(
      applyTransition(
        { ...a.current, lockWaitAttempts: attempts },
        { kind: "SCRIPT_EXITED", dispatchToken: a.token, exitCode: 50, v3Valid: v3.ok, now, nextAttemptAt },
      ),
    );
    // "Waiting holds no slot": session, slot and lock are released before the state moves back to WAITING_LOCK.
    await cleanup(item, res);
    if (t.transitionId === "X15") return commitDeploying(a, t, now, { result });
    const outcome = await commitDeploying(a, t, now, undefined, nextAttemptAt + WAITING_LOCK_GRACE_MS);
    if (outcome.outcome !== "TRANSITIONED") return outcome;
    await publishRetry(item.executionId, t.next.attempt + 1, delaySeconds);
    return outcome;
  }

  /** X16: `UNKNOWN_TARGET_STATE` and the `unresolved[]` append in one transaction. */
  async function commitUnknown(a: Attempt, t: Accepted, now: number, extra: Record<string, unknown>): Promise<DeployOutcome> {
    const done = await deps.transactions.markUnknownTargetState({
      executionId: a.item.executionId,
      expected: { status: "DEPLOYING", version: a.version, dispatchToken: a.token },
      patch: buildPatch(t, now, { extra }),
      lockKey: a.item.targetId,
      entry: { executionId: a.item.executionId, since: now },
      now,
    });
    return done.outcome === "COMMITTED" ? transitioned(t) : conflict;
  }

  return { evaluateQueued, handleLockRetry };
}
