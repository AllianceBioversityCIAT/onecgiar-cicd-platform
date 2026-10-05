// @akili-spec changes/cicd-executor-poc design §7 (observability row), §12; requirements FR-17
// Barrel export for the observability module: JSON logger with redaction,
// EMF metrics, and the liveness heartbeat (design §12). Downstream wiring
// (src/main, T-17's consumers) imports from here rather than reaching into
// the submodules directly.
export {
  createLogger,
  createEventRouterLogger,
  redactString,
  redactValue,
  type Logger,
  type LogContext,
  type LogLevel,
  type LogSink,
  type CreateLoggerDeps,
} from "./logger/index.js";

export {
  createMetrics,
  type Metrics,
  type MetricsSink,
  type CreateMetricsDeps,
} from "./metrics/index.js";

export {
  createHeartbeat,
  type Heartbeat,
  type HeartbeatMetrics,
  type HeartbeatLogger,
  type HealthcheckWriter,
  type TimerPort,
  type CreateHeartbeatDeps,
} from "./heartbeat/index.js";

export { createFsHealthcheckWriter } from "./heartbeat/fs-healthcheck-writer.js";
