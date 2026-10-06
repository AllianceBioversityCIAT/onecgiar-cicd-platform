// @akili-spec changes/cicd-executor-poc design §12 (observability row), §7; requirements FR-17
//
// EMF (CloudWatch Embedded Metric Format) metrics emission. Each call
// produces exactly one JSON line through the injected `MetricsSink` —
// CloudWatch Logs parses the `_aws.CloudWatchMetrics` block and extracts the
// named metric(s) automatically; no CloudWatch SDK call is made here (design
// §7's `observability` row lists no AWS dependency beyond the log line
// itself).
//
// Design §12's exact metric set: `ExecutionsStarted/Succeeded/Failed`,
// `StepDurationMs` per step type, `LockWaitMs`, `DispatchLatencyMs`
// (NFR-05's coordination latency), the event-router's `OrphanEvents` and
// `RetryLater` counters, and the liveness `ExecutorHeartbeat` metric (design
// §12 "Liveness": "emits a heartbeat metric every minute").
import type { Clock } from "../../ports/clock.js";

/** Orphan-event counter seam, inlined here when the `application/event-router` shim was deleted (N-08). Types only. */
export interface EventRouterMetrics {
  recordOrphanEvent(): void;
}

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

export interface Metrics extends EventRouterMetrics {
  recordExecutionStarted(): void;
  recordExecutionSucceeded(): void;
  recordExecutionFailed(): void;
  recordStepDuration(stepType: string, durationMs: number): void;
  recordLockWaitMs(durationMs: number): void;
  recordDispatchLatencyMs(durationMs: number): void;
  /** design §12's event-router counter for the `RETRY_LATER` outcome (the CodeBuild early-arrival race, event-router's `routeEvent`). */
  recordRetryLater(): void;
  /** design §12 "Liveness": emitted once per heartbeat tick (T-17's heartbeat, every minute). */
  recordHeartbeat(): void;
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
    recordStepDuration(stepType, durationMs) {
      emit(deps, "StepDurationMs", durationMs, "Milliseconds", { StepType: stepType });
    },
    recordLockWaitMs(durationMs) {
      emit(deps, "LockWaitMs", durationMs, "Milliseconds");
    },
    recordDispatchLatencyMs(durationMs) {
      emit(deps, "DispatchLatencyMs", durationMs, "Milliseconds");
    },
    recordOrphanEvent() {
      emit(deps, "OrphanEvents", 1, "Count");
    },
    recordRetryLater() {
      emit(deps, "RetryLater", 1, "Count");
    },
    recordHeartbeat() {
      emit(deps, "ExecutorHeartbeat", 1, "Count");
    },
  };
}
