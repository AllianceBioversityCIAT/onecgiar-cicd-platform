// @akili-spec changes/cicd-executor-poc design §12 "Liveness"; requirements NFR-06
//
// Liveness heartbeat (design §12: "the Executor emits a heartbeat metric
// every minute and writes a file for the container's healthcheck. Exposes
// no ports"). On every tick: records the `ExecutorHeartbeat` metric
// (`Metrics.recordHeartbeat`, `src/observability/metrics/index.ts`) and
// writes the healthcheck file through an injected `HealthcheckWriter` — this
// module never imports `node:fs` directly (kept in the thin
// `fs-healthcheck-writer.ts` adapter alongside it), and never a real timer
// directly either: `setInterval`/`clearInterval` are taken from `globalThis`
// by default, which is exactly what `vi.useFakeTimers()` replaces, making
// the one-minute cadence provable without a real wait.
//
// Rework (attempt 3, reviewer round 2, advisory): the metric emission and
// the healthcheck write are now in separate `try` blocks — previously a
// single `try` meant a failing metric sink (common: the sink is down) also
// silently skipped the healthcheck file write, which a container
// orchestrator's liveness probe depends on regardless of whether metrics
// made it out.
import type { Clock } from "../../ports/clock.js";

const DEFAULT_INTERVAL_MS = 60_000;

/** The handful of `Metrics` this module needs (`src/observability/metrics/index.ts` satisfies it). */
export interface HeartbeatMetrics {
  recordHeartbeat(): void;
}

/** Injectable file writer for the container healthcheck file — no `node:fs` dependency in the core. */
export interface HealthcheckWriter {
  write(filePath: string, contents: string): void;
}

/** The subset of the timer API this module needs, swappable for a non-global scheduler if ever required; defaults to `globalThis.setInterval`/`clearInterval`. */
export interface TimerPort {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimer: TimerPort = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]),
};

/** The minimal logging seam this module needs to report a failed tick without crashing — not the full `Logger` (`../logger/index.ts`), to keep this module decoupled from it; `Logger.error` satisfies this structurally. */
export interface HeartbeatLogger {
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CreateHeartbeatDeps {
  readonly metrics: HeartbeatMetrics;
  readonly clock: Clock;
  readonly healthcheckWriter: HealthcheckWriter;
  readonly healthcheckPath: string;
  readonly intervalMs?: number;
  readonly timer?: TimerPort;
  /** Reports a tick that threw (metric emission or file write failed) instead of letting it crash the process. Optional: defaults to swallowing silently, since liveness must never take the Executor down over a logging dependency. */
  readonly logger?: HeartbeatLogger;
}

export interface Heartbeat {
  start(): void;
  stop(): void;
}

export function createHeartbeat(deps: CreateHeartbeatDeps): Heartbeat {
  const timer = deps.timer ?? defaultTimer;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let handle: unknown;

  function tick(): void {
    // A failed tick (metric sink down, disk full, …) must never crash the
    // Executor (design §12 "Liveness" is about surviving, not about any one
    // tick succeeding) — caught, reported, and the schedule keeps running.
    // The two operations are independent concerns on separate failure modes
    // (a metrics sink outage vs. a disk/fs problem) in separate try blocks:
    // a failing metric sink must never prevent the healthcheck file from
    // being written (the container orchestrator's liveness probe reads that
    // file regardless of whether metrics made it out), and vice versa.
    try {
      deps.metrics.recordHeartbeat();
    } catch (error) {
      deps.logger?.error("heartbeat tick failed: metric emission", { error });
    }
    try {
      deps.healthcheckWriter.write(
        deps.healthcheckPath,
        JSON.stringify({ lastHeartbeatAt: deps.clock.now().toISOString() }),
      );
    } catch (error) {
      deps.logger?.error("heartbeat tick failed: healthcheck write", { error });
    }
  }

  return {
    start() {
      if (handle !== undefined) {
        return;
      }
      // Tick once immediately: liveness starts the moment the Executor
      // comes up, not up to a full interval later — a healthcheck probe
      // run right after start() must already see a fresh file.
      tick();
      handle = timer.setInterval(tick, intervalMs);
    },
    stop() {
      if (handle === undefined) {
        return;
      }
      timer.clearInterval(handle);
      handle = undefined;
    },
  };
}
