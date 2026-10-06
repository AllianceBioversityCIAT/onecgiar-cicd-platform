// @akili-spec changes/cicd-executor-poc design §12 (observability row), §7; requirements FR-17
//
// EMF (CloudWatch Embedded Metric Format) metrics emission. Each call
// produces exactly one JSON line through the injected `MetricsSink` —
// CloudWatch Logs parses the `_aws.CloudWatchMetrics` block and extracts the
// named metric(s) automatically; no CloudWatch SDK call is made here (design
// §7's `observability` row lists no AWS dependency beyond the log line
// itself).
//
// Metric set: `ExecutionsStarted/Succeeded/Failed`, `LockWaitMs`,
// `DispatchLatencyMs` (NFR-05's coordination latency), `RejectedRequests`,
// `NotificationFailures` (FR-14: provider failure is logged and counted,
// never state-changing) and the liveness `ExecutorHeartbeat` metric (design
// §12 "Liveness": "emits a heartbeat metric every minute") and
// `ExecutionsPastDeadline` (FR-17; emitted by the reconciler once per tick).
import type { Clock } from "../../ports/clock.js";
import type { RejectReason } from "../../domain/errors/index.js";

const NAMESPACE = "CicdExecutor";

/** Injectable write target for one already-serialized EMF JSON line. */
export interface MetricsSink {
  write(line: string): void;
}

export interface CreateMetricsDeps {
  readonly sink: MetricsSink;
  readonly clock: Clock;
  readonly namespace?: string;
}

export interface Metrics {
  recordExecutionStarted(): void;
  recordExecutionSucceeded(): void;
  recordExecutionFailed(): void;
  recordLockWaitMs(durationMs: number): void;
  recordDispatchLatencyMs(durationMs: number): void;
  /** FR-14: a notification provider call failed (dimension `provider`); never changes execution state. */
  recordNotificationFailed(provider: string): void;
  /** design §12 "Liveness": emitted once per heartbeat tick (T-17's heartbeat, every minute). */
  recordHeartbeat(): void;
  /** design §12: EMF `RejectedRequests` = 1 with dimension `reason` (any X2 reason; alarm on `reason=UNAUTHORIZED_SENDER`, DD-25). */
  recordRejectedRequest(reason: RejectReason): void;
  /** FR-17: executions found past `deadlineAt` by one reconcile pass (0 is emitted too, so the alarm has data); no dimensions. */
  recordExecutionsPastDeadline(count: number): void;
}

interface EmfUnit {
  readonly Name: string;
  readonly Unit: "Count" | "Milliseconds";
}

function emit(
  deps: CreateMetricsDeps,
  metricName: string,
  value: number,
  unit: EmfUnit["Unit"],
  dimensions: Record<string, string> = {},
): void {
  const dimensionKeys = Object.keys(dimensions);
  const document = {
    _aws: {
      Timestamp: deps.clock.now().getTime(),
      CloudWatchMetrics: [
        {
          Namespace: deps.namespace ?? NAMESPACE,
          Dimensions: [dimensionKeys],
          Metrics: [{ Name: metricName, Unit: unit } satisfies EmfUnit],
        },
      ],
    },
    ...dimensions,
    [metricName]: value,
  };
  deps.sink.write(JSON.stringify(document));
}

export function createMetrics(deps: CreateMetricsDeps): Metrics {
  return {
    recordExecutionStarted() {
      emit(deps, "ExecutionsStarted", 1, "Count");
    },
    recordExecutionSucceeded() {
      emit(deps, "ExecutionsSucceeded", 1, "Count");
    },
    recordExecutionFailed() {
      emit(deps, "ExecutionsFailed", 1, "Count");
    },
    recordLockWaitMs(durationMs) {
      emit(deps, "LockWaitMs", durationMs, "Milliseconds");
    },
    recordDispatchLatencyMs(durationMs) {
      emit(deps, "DispatchLatencyMs", durationMs, "Milliseconds");
    },
    recordNotificationFailed(provider) {
      emit(deps, "NotificationFailures", 1, "Count", { provider });
    },
    recordHeartbeat() {
      emit(deps, "ExecutorHeartbeat", 1, "Count");
    },
    recordRejectedRequest(reason) {
      emit(deps, "RejectedRequests", 1, "Count", { reason });
    },
    recordExecutionsPastDeadline(count) {
      emit(deps, "ExecutionsPastDeadline", count, "Count");
    },
  };
}
