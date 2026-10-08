// @akili-spec changes/cicd-executor-poc design §1.2, §6.6, §5.1, §12, DD-12; requirements FR-14, FR-15, FR-17; tasks R-4 (AC-02 V1)
// Lifecycle notifications wiring (N-17b). Observes outcomes AFTER they are
// persisted and asks notification-service to announce them; it never changes
// execution state (FR-14: best effort), and the only thing it writes back is
// the write-once `slackThreadTs` audit field. Every message carries a logs
// link (`logsUrl` is always supplied) and is built from logical names only.
// AC-02 V1: every message goes to the platform channel (no per-target
// channel, design §6.6) and names the `targetId`.
import type { NotificationService, NotificationInput } from "../application/notification-service/index.js";
import type { ExecutionItem } from "../adapters/dynamodb-state-store/types.js";
import type { Logger } from "../observability/logger/index.js";
import type { Metrics } from "../observability/metrics/index.js";
import type { PendingTasks } from "./pending-tasks.js";

export interface LifecycleNotifierDeps {
  readonly notifications: NotificationService;
  readonly executions: {
    get(executionId: string): Promise<ExecutionItem | undefined>;
    setAuditOnce(executionId: string, field: "slackThreadTs", value: string): Promise<boolean>;
  };
  readonly platformSlack: { readonly channelRef: string; readonly tokenRef: string };
  readonly logsUrlTemplate: string;
  readonly runbookUrl: string;
  readonly metrics: Pick<Metrics, "recordExecutionStarted" | "recordExecutionSucceeded" | "recordExecutionFailed">;
  readonly logger: Logger;
  readonly pending: PendingTasks;
}

export interface LifecycleNotifier {
  /** X1: the ACCEPTED root message; persists `slackThreadTs`. */
  accepted(executionId: string): Promise<void>;
  /** Announces the CURRENT persisted outcome when it is a terminal one (a no-op for non-terminal states). */
  outcome(executionId: string): Promise<void>;
  /** REJECTED to the platform channel; `rejectionId` is the rejection identity (`MSG#{sqsMessageId}`, AC-02 V1). */
  rejected(input: { readonly rejectionId: string; readonly reason: string; readonly senderRef: string }): Promise<void>;
  /** Fire-and-track variant for synchronous hooks (the reconciler's `onTransitioned`). */
  outcomeInBackground(executionId: string): void;
}

export function createLifecycleNotifier(deps: LifecycleNotifierDeps): LifecycleNotifier {
  const logsUrlFor = (executionId: string): string => deps.logsUrlTemplate.split("{executionId}").join(encodeURIComponent(executionId));

  function runUrlOf(item: ExecutionItem): string {
    return item.ci.runUrl ?? `https://github.com/${item.ci.repository}/actions/runs/${item.ci.runId}`;
  }

  function base(item: ExecutionItem) {
    const destination = deps.platformSlack;
    return {
      executionId: item.executionId,
      targetId: item.targetId,
      commitSha: item.commitSha,
      runUrl: runUrlOf(item),
      logsUrl: logsUrlFor(item.executionId),
      destination,
      ...(item.slackThreadTs === undefined ? {} : { threadRef: item.slackThreadTs }),
      ...(item.finishedAt === undefined ? {} : { durationMs: Math.max(0, item.finishedAt - item.startedAt) }),
    };
  }

  function inputFor(item: ExecutionItem): NotificationInput | undefined {
    const b = base(item);
    switch (item.status) {
      case "SUCCEEDED":
        return { ...b, kind: "SUCCEEDED" };
      case "SUPERSEDED":
        return { ...b, kind: "SUPERSEDED" };
      case "UNKNOWN_TARGET_STATE":
        return { ...b, kind: "UNKNOWN_TARGET_STATE", runbookUrl: deps.runbookUrl };
      case "FAILED": {
        const code = item.error?.code ?? "UNKNOWN";
        if (code === "DEPLOY_WINDOW_CLOSED") return { ...b, kind: "DEPLOY_WINDOW_CLOSED" };
        if (code === "LOCK_TIMEOUT") return { ...b, kind: "LOCK_TIMEOUT" };
        return { ...b, kind: "DEPLOY_FAILED", code };
      }
      default:
        return undefined;
    }
  }

  function safely<T>(label: string, executionId: string | undefined, fn: () => Promise<T>): Promise<T | undefined> {
    return fn().catch((error: unknown) => {
      // Notifications are best effort (FR-14): record and carry on.
      deps.logger.error(`lifecycle notification step failed: ${label}`, {
        ...(executionId === undefined ? {} : { executionId }),
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
  }

  const api: LifecycleNotifier = {
    async accepted(executionId) {
      await safely("accepted", executionId, async () => {
        const item = await deps.executions.get(executionId);
        if (item === undefined) return;
        deps.metrics.recordExecutionStarted();
        const b = base(item);
        const { threadRef } = await deps.notifications.notify({ ...b, kind: "ACCEPTED" });
        if (threadRef !== undefined && item.slackThreadTs === undefined) {
          await deps.executions.setAuditOnce(executionId, "slackThreadTs", threadRef);
        }
      });
    },

    async outcome(executionId) {
      await safely("outcome", executionId, async () => {
        const item = await deps.executions.get(executionId);
        if (item === undefined) return;
        if (item.status === "SUCCEEDED") deps.metrics.recordExecutionSucceeded();
        else if (item.status === "FAILED" || item.status === "UNKNOWN_TARGET_STATE") deps.metrics.recordExecutionFailed();
        const input = inputFor(item);
        if (input !== undefined) await deps.notifications.notify(input);
      });
    },

    async rejected(input) {
      await safely("rejected", undefined, async () => {
        await deps.notifications.notify({ kind: "REJECTED", ...input, destination: deps.platformSlack });
      });
    },

    outcomeInBackground(executionId) {
      deps.pending.track(api.outcome(executionId));
    },
  };
  return api;
}
