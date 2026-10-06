// @akili-spec changes/cicd-executor-poc design §4.2, §5.1 (GSI2), §7 (reconciler row), §7.1, §7.3 (X7, X11, X16, CW-2), §7.7, DD-13; requirements FR-15, FR-17, FR-24
// Reconciler (N-14), reduced: handles RECONCILE_TICK (EventBridge Scheduler
// through the same queue, DD-13). Exactly TWO GSI2 `Query`s per tick, never a
// scan (design §5.1): partition `EXECUTION` (`deadlineAt < now`) and partition
// `WINDOW` (`deadlineAt = closesAt < now`).
//
// It COORDINATES; it never re-runs a script and publishes nothing that could
// exec (design §7 Forbidden). Per overdue execution (the item is re-read first,
// so a stale index row never drives a decision):
//   QUEUED        -> S1 first (persisted `order`, TARGET ordering): newer
//                    request -> X3 SUPERSEDED (terminal, publishes nothing);
//                    a source mismatch throws like execution-service. Else
//                    the coordinator's `evaluateQueued` (V1 -> X4/X5; it
//                    persists, then publishes, CW-2).
//   WAITING_LOCK  -> budget exhausted: X7 `FAILED (LOCK_TIMEOUT)`, the SAME
//                    canonical write the lock-retry handler makes (conditional
//                    on status + version: one wins). Budget left: publish a
//                    fresh LOCK_RETRY_REQUESTED, no state change (the
//                    `nextAttemptAt` was persisted before the lost send, CW-2);
//                    it is re-driven on EVERY tick until the execution moves
//                    (duplicates are absorbed: the handler accepts only
//                    `event.attempt === execution.attempt + 1` and every write
//                    is conditional); its `attempt` is `execution.attempt + 1` (event `attempt`
//                    convention pinned by N-12: the handler accepts only
//                    `event.attempt === execution.attempt + 1`).
//   DEPLOYING     -> `RECONCILE_OVERDUE_DEPLOYING`: `execStartedAt` for the
//                    current attempt -> X16 UNKNOWN_TARGET_STATE together with
//                    the `TARGET.unresolved[]` append (one transaction); else
//                    X11 `FAILED (DISPATCH_INTERRUPTED)`. Never a re-run.
//   OPEN window past `closesAt` -> closed (`EXPIRED`), conditional on
//                    `state = OPEN` + `version` (design §7.7).
//
// Lock leases: the reconciler does NOT touch locks. Design §7.5 ("Executor
// crash" row: "Lease expires"), QAS-2 ("lock free <= lease") and the §7
// reconciler row (executions and windows only; DD-13 scope "deploy state and
// windows only") make an orphan lease expire by itself, and a new acquirer
// takes an expired lease over with a higher fencing token (DD-09). Releasing
// it from here would add a second release path that could free a lock whose
// script is still running. (FR-15's prose also names "orphan locks"; the
// approved design resolves that by lease expiry.)
//
// Metric: `ExecutionsPastDeadline` = number of overdue executions found in
// the tick (FR-17 alarm; see infra/RESOURCES.md), emitted on every tick.
import type { ExecutionStatus, TransitionId } from "../../domain/state-machine/index.js";
import { applyTransition } from "../../domain/state-machine/index.js";
import { evaluateS1, type OrderingValue } from "../../domain/supersede-policy/index.js";
import { OrderingSourceMismatchError } from "../execution-service/index.js";
import type { Clock } from "../../ports/clock.js";
import type { QueuePublisher } from "../../ports/queue-publisher.js";
import type { LockRetryRequestedEvent } from "../../domain/request-contract/index.js";
import type { Metrics } from "../../observability/metrics/index.js";
import { GSI2_NAME } from "../../adapters/dynamodb-state-store/table-schema.js";
import type { DeployWindowItem, ExecutionItem } from "../../adapters/dynamodb-state-store/types.js";
import type { DeployCoordinator, DeployExecutionStore, DeployTargetPort, DeployTransactionPort } from "../deploy-coordinator/index.js";
import { buildPatch, toExecutionSnapshot } from "../deploy-coordinator/index.js";
import type { WindowStore } from "../deploy-window-service/index.js";

/** GSI2 partition values (design §5.1). */
const EXECUTION_PARTITION = "EXECUTION";
const WINDOW_PARTITION = "WINDOW";

/** The read side of the table: `DynamoDbStateStore.queryIndex` satisfies it structurally (Query only, no scan). */
export interface DeadlineIndex {
  queryIndex<TItem>(
    indexName: string,
    partitionValue: string,
    options?: { readonly sortKeyBefore?: string | number },
  ): Promise<TItem[]>;
}

export interface ReconcilerDeps {
  readonly index: DeadlineIndex;
  readonly executions: DeployExecutionStore;
  readonly transactions: Pick<DeployTransactionPort, "markUnknownTargetState">;
  readonly windows: Pick<WindowStore, "close">;
  /** Ordering attributes of `TARGET#{lockKey}` for S1 (`TargetStateRepository.get` satisfies it). */
  readonly target: Pick<DeployTargetPort, "get">;
  readonly coordinator: Pick<DeployCoordinator, "evaluateQueued">;
  readonly queue: QueuePublisher;
  readonly metrics: Pick<Metrics, "recordExecutionsPastDeadline">;
  readonly clock: Clock;
  readonly newEventId?: () => string;
  /** Called after this reconciler wrote a terminal transition (best effort; the composition wires notifications). */
  readonly onTransitioned?: (info: ReconciledTransition) => void;
}

export interface ReconciledTransition {
  readonly executionId: string;
  readonly transitionId: TransitionId;
  readonly status: ExecutionStatus;
  readonly errorCode?: string;
}

export type ReconcileAction =
  | "QUEUED_REEVALUATED"
  /** S1 found a newer request: X3 SUPERSEDED, nothing published. */
  | "SUPERSEDED"
  | "LOCK_RETRY_REDRIVEN"
  | "LOCK_TIMEOUT"
  | "DISPATCH_INTERRUPTED"
  | "UNKNOWN_TARGET_STATE"
  /** Moved on, no longer overdue, or another writer won the conditional write. */
  | "SKIPPED";

export interface ReconcileSummary {
  /** Executions the GSI2 `EXECUTION` query returned (the `ExecutionsPastDeadline` value). */
  readonly overdueExecutions: number;
  readonly actions: ReadonlyArray<{ readonly executionId: string; readonly action: ReconcileAction }>;
  readonly windowsClosed: number;
}

export interface Reconciler {
  /** One RECONCILE_TICK. Idempotent; a failure on one item never stops the others (an `AggregateError` is thrown at the end). */
  reconcile(): Promise<ReconcileSummary>;
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const newEventId = deps.newEventId ?? (() => globalThis.crypto.randomUUID());
  const nowMs = (): number => deps.clock.now().getTime();

  function notify(info: ReconciledTransition): void {
    try {
      deps.onTransitioned?.(info);
    } catch {
      // Notifications are best effort and never state-changing (FR-14).
    }
  }

  /** CW-2: a fresh retry message for an overdue WAITING_LOCK with budget left. No state change; the attempt is `execution.attempt + 1`. */
  async function redriveLockRetry(item: ExecutionItem): Promise<void> {
    const event: LockRetryRequestedEvent = {
      specVersion: 1,
      eventId: newEventId(),
      eventType: "LOCK_RETRY_REQUESTED",
      timestamp: deps.clock.now().toISOString(),
      source: "executor",
      executionId: item.executionId,
      attempt: item.attempt + 1,
    };
    await deps.queue.publish({ body: { ...event }, delaySeconds: 0 });
  }

  async function reconcileExecution(candidate: ExecutionItem, now: number): Promise<ReconcileAction> {
    // The index row may be stale: decide on the persisted item.
    const item = await deps.executions.get(candidate.executionId);
    if (item === undefined || item.deadlineAt === undefined || !(item.deadlineAt < now)) return "SKIPPED";

    switch (item.status) {
      case "QUEUED": {
        // S1 first (design §7.3 CW-2: re-evaluate X3-X5). Ordering value from the persisted `order`, never rebuilt.
        const value: OrderingValue = { sourceRef: item.order.sourceRef, runNumber: item.order.runNumber };
        const s1 = evaluateS1(value, (await deps.target.get(item.lockKey)) ?? {});
        if (s1.decision === "REJECTED_SOURCE_MISMATCH") throw new OrderingSourceMismatchError(item.executionId);
        if (s1.decision === "SUPERSEDED") {
          const x3 = applyTransition(toExecutionSnapshot(item), { kind: "SUPERSEDE_QUEUED", superseded: true });
          if (!x3.accepted) return "SKIPPED";
          if (!(await deps.executions.update(item.executionId, { status: "QUEUED", version: item.version }, buildPatch(x3, now)))) return "SKIPPED";
          notify({ executionId: item.executionId, transitionId: "X3", status: x3.next.status, errorCode: "SUPERSEDED" });
          return "SUPERSEDED";
        }
        const outcome = await deps.coordinator.evaluateQueued(item.executionId);
        return outcome.outcome === "NOOP" ? "SKIPPED" : "QUEUED_REEVALUATED";
      }

      case "WAITING_LOCK": {
        const expected = { status: "WAITING_LOCK", version: item.version } as const;
        const x7 = applyTransition(toExecutionSnapshot(item), { kind: "LOCK_WAIT_TIMEOUT", now });
        if (x7.accepted) {
          // Canonical X7: identical result to the lock-retry handler's; the conditional write lets one of them win.
          if (!(await deps.executions.update(item.executionId, expected, buildPatch(x7, now)))) return "SKIPPED";
          notify({ executionId: item.executionId, transitionId: "X7", status: x7.next.status, errorCode: "LOCK_TIMEOUT" });
          return "LOCK_TIMEOUT";
        }
        await redriveLockRetry(item);
        return "LOCK_RETRY_REDRIVEN";
      }

      case "DEPLOYING": {
        const t = applyTransition(toExecutionSnapshot(item), { kind: "RECONCILE_OVERDUE_DEPLOYING", now });
        if (!t.accepted || item.dispatchToken === undefined) return "SKIPPED";
        const expected = { status: "DEPLOYING", version: item.version, dispatchToken: item.dispatchToken } as const;
        if (t.transitionId === "X16") {
          const done = await deps.transactions.markUnknownTargetState({
            executionId: item.executionId,
            expected,
            patch: buildPatch(t, now),
            lockKey: item.lockKey,
            entry: { executionId: item.executionId, since: now },
            now,
          });
          if (done.outcome !== "COMMITTED") return "SKIPPED";
          notify({ executionId: item.executionId, transitionId: "X16", status: t.next.status, errorCode: "UNKNOWN_TARGET_STATE" });
          return "UNKNOWN_TARGET_STATE";
        }
        if (!(await deps.executions.update(item.executionId, expected, buildPatch(t, now)))) return "SKIPPED";
        notify({ executionId: item.executionId, transitionId: "X11", status: t.next.status, errorCode: "DISPATCH_INTERRUPTED" });
        return "DISPATCH_INTERRUPTED";
      }

      default:
        return "SKIPPED"; // terminal (should not be in the sparse index)
    }
  }

  /** Design §7.7: an expired OPEN window is closed, conditional on `state = OPEN` + `version`. */
  async function closeExpiredWindow(window: DeployWindowItem, now: number): Promise<boolean> {
    if (window.state !== "OPEN" || window.closesAt === undefined || !(window.closesAt < now)) return false;
    return deps.windows.close(window.lockKey, window.version, { closedReason: "EXPIRED", closedAt: now });
  }

  async function reconcile(): Promise<ReconcileSummary> {
    const now = nowMs();
    const failures: unknown[] = [];

    // Query 1 of 2.
    const overdue = await deps.index.queryIndex<ExecutionItem>(GSI2_NAME, EXECUTION_PARTITION, { sortKeyBefore: now });
    try {
      deps.metrics.recordExecutionsPastDeadline(overdue.length);
    } catch (error) {
      failures.push(error);
    }

    const actions: Array<{ executionId: string; action: ReconcileAction }> = [];
    for (const candidate of overdue) {
      try {
        actions.push({ executionId: candidate.executionId, action: await reconcileExecution(candidate, now) });
      } catch (error) {
        failures.push(error);
      }
    }

    // Query 2 of 2.
    let windowsClosed = 0;
    try {
      const expired = await deps.index.queryIndex<DeployWindowItem>(GSI2_NAME, WINDOW_PARTITION, { sortKeyBefore: now });
      for (const window of expired) {
        try {
          if (await closeExpiredWindow(window, now)) windowsClosed += 1;
        } catch (error) {
          failures.push(error);
        }
      }
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `reconcile tick: ${String(failures.length)} item(s) failed (the tick is idempotent and will be retried)`);
    }
    return { overdueExecutions: overdue.length, actions, windowsClosed };
  }

  return { reconcile };
}
