// @akili-spec changes/cicd-executor-poc design §7 (observability row), §12; requirements FR-17
//
// JSON logger with bound context (`executionId`, `stepId`, `eventType`,
// `attempt`, design §7's observability row) and secret redaction (design
// §12, `redactValue` — FR-17 "any log contains no secrets, credentials, or
// tokens"). Writes through an injectable `LogSink` only — no `console.*`
// call anywhere in this module, by design (so tests capture lines instead of
// polluting test output, and production wiring picks whatever sink it
// wants, e.g. `process.stdout.write`).
//
// `createEventRouterLogger` adapts a `Logger` to the event-router's
// `EventRouterLogger` seam (design §6.1: "log with every identifier
// received" under `ORPHAN_EVENT`) without this module importing anything
// from the event-router — the adapter direction is observability -> router
// contract, never the reverse.
import type { Clock } from "../../ports/clock.js";
import type { EventRouterLogger, OrphanEventDetails } from "../../application/event-router/index.js";
import { redactValue } from "./redaction.js";

export { redactString, redactValue } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Context fields bound once per execution/step and stamped on every subsequent log line (design §7's observability row). */
export interface LogContext {
  readonly executionId?: string;
  readonly stepId?: string;
  readonly eventType?: string;
  readonly attempt?: number;
}

/** Injectable write target for one already-serialized JSON log line. */
export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  /** Returns a new logger with `context` merged over the current one; the original is left untouched. */
  withContext(context: LogContext): Logger;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CreateLoggerDeps {
  readonly sink: LogSink;
  readonly clock: Clock;
  readonly context?: LogContext;
}

/**
 * `JSON.stringify` throws on a value it cannot represent (a `BigInt` field,
 * most commonly — an SDK/HTTP error body can carry one) even after
 * `redactValue` has run (redaction only removes secrets; it does not make a
 * value JSON-safe). A log call must never throw from the caller's
 * perspective (FR-17's reconstruction scenario needs the record to exist at
 * all, especially on a failure path), so a failed stringify falls back to a
 * minimal line carrying only the already-known-safe core fields plus a
 * marker, instead of propagating the `TypeError`.
 */
function safeStringify(redacted: unknown, level: LogLevel, timestamp: string, message: string): string {
  try {
    return JSON.stringify(redacted);
  } catch {
    try {
      return JSON.stringify({ level, timestamp, message, serializationError: true });
    } catch {
      return `{"level":"${level}","timestamp":"${timestamp}","message":"log serialization failed","serializationError":true}`;
    }
  }
}

function log(deps: CreateLoggerDeps, level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  // `fields` is spread first (lowest precedence): a caller-supplied field
  // named `level`, `timestamp`, `executionId`, `message`, etc. must never be
  // able to forge the record's identity, so every fixed field below is
  // applied AFTER the spread and wins the collision.
  const timestamp = deps.clock.now().toISOString();
  const record = {
    ...fields,
    ...deps.context,
    level,
    timestamp,
    message,
  };
  const redacted = redactValue(record);
  deps.sink.write(safeStringify(redacted, level, timestamp, message));
}

export function createLogger(deps: CreateLoggerDeps): Logger {
  return {
    withContext(context: LogContext): Logger {
      return createLogger({ ...deps, context: { ...deps.context, ...context } });
    },
    debug(message, fields) {
      log(deps, "debug", message, fields);
    },
    info(message, fields) {
      log(deps, "info", message, fields);
    },
    warn(message, fields) {
      log(deps, "warn", message, fields);
    },
    error(message, fields) {
      log(deps, "error", message, fields);
    },
  };
}

/**
 * Adapts a `Logger` to the event-router's `EventRouterLogger` seam
 * (`src/application/event-router/index.ts`). One log line per orphan event,
 * at `warn` (an orphan is a notable, non-fatal anomaly, never a crash), with
 * `eventType: "ORPHAN_EVENT"` plus every identifier `OrphanEventDetails`
 * carries (design §6.1: "log with every identifier received").
 */
export function createEventRouterLogger(logger: Logger): EventRouterLogger {
  return {
    orphanEvent(details: OrphanEventDetails): void {
      const { executionId, stepId, ...rest } = details;
      logger
        .withContext({ executionId, stepId, eventType: "ORPHAN_EVENT" })
        .warn("orphan event: no effects applied", rest);
    },
  };
}
