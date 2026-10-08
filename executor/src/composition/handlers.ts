// @akili-spec changes/cicd-executor-poc design §3.3, §6.1, §6.4, §7 (message-router, execution-service, deploy-coordinator, reconciler rows); requirements FR-04, FR-14, FR-15, FR-21; tasks R-4, R-5 (AC-02 V1)
// Binds the router's `MessageHandlers` to the services (N-17b). Every handler
// either resolves (the router acknowledges) or rejects (no ack, SQS
// redelivers). Notifications are best effort and never alter the outcome;
// background work is awaited before the handler resolves so what the operator
// sees is already persisted. AC-02 V1: requests and operator events name the
// `targetId`; every rejection is recorded under the SQS message identity.
import { randomUUID } from "node:crypto";
import type { MessageHandlers } from "../application/message-router/index.js";
import type { ExecutionService } from "../application/execution-service/index.js";
import type { DeployCoordinator } from "../application/deploy-coordinator/index.js";
import type { Reconciler } from "../application/reconciler/index.js";
import type { DeployWindowService, TargetResolutionService } from "../application/deploy-window-service/index.js";
import type { Logger } from "../observability/logger/index.js";
import type { Metrics } from "../observability/metrics/index.js";
import type { LifecycleNotifier } from "./lifecycle-notifier.js";
import type { PendingTasks } from "./pending-tasks.js";

/** A write lost a race: the message must NOT be acknowledged so SQS redelivers it. */
export class RedeliverError extends Error {
  public constructor(what: string) {
    super(`${what}: a concurrent writer won; leaving the message for redelivery`);
    this.name = "RedeliverError";
  }
}

export interface HandlerDeps {
  readonly executionService: ExecutionService;
  /** The coordinator as seen by the handlers: already wrapped so every outcome is announced (see `withNotifications`). */
  readonly coordinator: DeployCoordinator;
  readonly reconciler: Reconciler;
  readonly windows: Pick<DeployWindowService, "open" | "close">;
  readonly resolution: Pick<TargetResolutionService, "record">;
  readonly notifier: LifecycleNotifier;
  readonly metrics: Pick<Metrics, "recordRejectedRequest">;
  readonly logger: Logger;
  readonly pending: PendingTasks;
  /** Correlation id for internal events that carry no sender-supplied eventId (RECONCILE_TICK, G-8). Defaults to `randomUUID`. */
  readonly newCorrelationId?: () => string;
}

/** Wraps the coordinator so each outcome it persisted is announced afterwards (SUPERSEDED, DEPLOY_WINDOW_CLOSED, LOCK_TIMEOUT, DEPLOY_FAILED, UNKNOWN_TARGET_STATE, SUCCEEDED). */
export function withNotifications(
  coordinator: DeployCoordinator,
  notifier: LifecycleNotifier,
  pending: PendingTasks,
): DeployCoordinator {
  return {
    async evaluateQueued(executionId) {
      const outcome = await coordinator.evaluateQueued(executionId);
      await pending.idle();
      await notifier.outcome(executionId);
      return outcome;
    },
    async handleLockRetry(event) {
      const outcome = await coordinator.handleLockRetry(event);
      await pending.idle();
      await notifier.outcome(event.executionId);
      return outcome;
    },
  };
}

const roleOf = (senderId: string | undefined): string => (senderId === undefined ? "UNKNOWN" : (senderId.split(":")[0] ?? "UNKNOWN"));

export function createMessageHandlers(deps: HandlerDeps): MessageHandlers {
  const { executionService, coordinator, notifier, logger } = deps;
  const newCorrelationId = deps.newCorrelationId ?? randomUUID;

  return {
    async deployRequested(validated) {
      const outcome = await executionService.deployRequested(validated);
      const { targetId, requestId } = validated.request;
      if (outcome.outcome === "DUPLICATE") {
        logger.info("duplicate DEPLOY_REQUESTED ignored", { targetId, requestId, ...(outcome.executionId === undefined ? {} : { executionId: outcome.executionId }) });
        return;
      }
      await notifier.accepted(outcome.executionId);
      if (outcome.status === "SUPERSEDED") {
        await notifier.outcome(outcome.executionId);
        return;
      }
      await coordinator.evaluateQueued(outcome.executionId);
    },

    async rejected(rejection) {
      const created = await executionService.rejected(rejection);
      // The authorizer already counted UNAUTHORIZED_SENDER when it decided: never count it twice.
      if (created && rejection.reason !== "UNAUTHORIZED_SENDER") deps.metrics.recordRejectedRequest(rejection.reason);
      await notifier.rejected({
        rejectionId: `MSG#${rejection.sqsMessageId}`,
        reason: rejection.reason,
        senderRef: rejection.senderRef,
      });
    },

    async unauthorizedInternalEvent(info) {
      // Counted by the authorizer's decision; here only the audit line (role-ID prefix, never the session suffix).
      logger.warn("internal event from an unauthorized sender acknowledged without handling", {
        eventType: info.eventType,
        senderRef: roleOf(info.senderId),
      });
    },

    async lockRetryRequested(event) {
      await coordinator.handleLockRetry(event);
    },

    async reconcileTick() {
      // G-8: the tick has no external identity; the correlation id is generated here, inside the trusted boundary.
      // No event mark exists for it: reconcile is idempotent by design (DD-13), so a redelivered or duplicated tick is harmless.
      logger.info("RECONCILE_TICK consumed", { correlationId: newCorrelationId() });
      await deps.reconciler.reconcile();
      await deps.pending.idle();
    },

    async deployWindowOpenRequested(event) {
      const outcome = await deps.windows.open({
        targetId: event.targetId,
        openedBy: event.openedBy,
        externalJobsDisabled: event.externalJobsDisabled,
        closesAt: event.closesAt,
        ...(event.note === undefined ? {} : { note: event.note }),
      });
      if (outcome.outcome === "CONFLICT") throw new RedeliverError("deploy window open");
      if (outcome.outcome === "REJECTED") logger.warn("deploy window open rejected", { targetId: event.targetId, reason: outcome.reason });
    },

    async deployWindowCloseRequested(event) {
      const outcome = await deps.windows.close({ targetId: event.targetId, closedBy: event.closedBy });
      if (outcome.outcome === "CONFLICT") throw new RedeliverError("deploy window close");
    },

    async targetResolutionRecorded(event, context) {
      const outcome = await deps.resolution.record(
        {
          eventId: event.eventId,
          targetId: event.targetId,
          executionId: event.executionId,
          resolvedBy: event.resolvedBy,
          observedDigests: event.observedDigests,
          ...(event.note === undefined ? {} : { note: event.note }),
        },
        { senderId: context.senderRef },
      );
      if (outcome.outcome === "CONFLICT") throw new RedeliverError("target resolution");
      if (outcome.outcome === "REJECTED") logger.warn("target resolution rejected", { targetId: event.targetId, reason: outcome.reason });
    },
  };
}
