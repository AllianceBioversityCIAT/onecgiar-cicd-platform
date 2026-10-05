// @akili-spec changes/cicd-executor-poc design §12 "Liveness"; requirements NFR-06
//
// Proves the liveness heartbeat (design §12: "the Executor emits a
// heartbeat metric every minute and writes a file for the container's
// healthcheck. Exposes no ports"): it ticks once immediately on `start()`
// (a probe run right after startup must already see a fresh file) and then
// on a fixed one-minute interval, it (1) records the `ExecutorHeartbeat`
// metric and (2) writes the healthcheck file through an injected writer —
// never `node:fs` directly from this module (the fs adapter is a separate,
// thin file) — and a tick that throws is caught and reported, never left to
// crash the process. Scheduling is driven by vitest's fake timers so the
// one-minute cadence is provable without a real wait.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat, type HealthcheckWriter } from "../../src/observability/heartbeat/index.js";

function fakeClock(iso: string) {
  return { now: () => new Date(iso) };
}

function fakeMetrics() {
  let heartbeats = 0;
  return {
    get heartbeats() {
      return heartbeats;
    },
    recordHeartbeat() {
      heartbeats += 1;
    },
  };
}

function fakeHealthcheckWriter(): HealthcheckWriter & { readonly writes: Array<{ path: string; contents: string }> } {
  const writes: Array<{ path: string; contents: string }> = [];
  return {
    writes,
    write(path, contents) {
      writes.push({ path, contents });
    },
  };
}

describe("createHeartbeat — liveness (design §12)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing until started", () => {
    const metrics = fakeMetrics();
    const writer = fakeHealthcheckWriter();
    createHeartbeat({
      metrics,
      clock: fakeClock("2026-10-05T12:00:00.000Z"),
      healthcheckWriter: writer,
      healthcheckPath: "/tmp/healthcheck.json",
    });

    vi.advanceTimersByTime(5 * 60_000);

    expect(metrics.heartbeats).toBe(0);
    expect(writer.writes).toHaveLength(0);
  });

  it("ticks once immediately on start(), then every minute", () => {
    const metrics = fakeMetrics();
    const writer = fakeHealthcheckWriter();
    const heartbeat = createHeartbeat({
      metrics,
      clock: fakeClock("2026-10-05T12:00:00.000Z"),
      healthcheckWriter: writer,
      healthcheckPath: "/tmp/healthcheck.json",
    });

    heartbeat.start();

    // Ticked immediately, with no time advanced yet: a healthcheck probe
    // run right after startup must already see a fresh file.
    expect(metrics.heartbeats).toBe(1);
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]?.path).toBe("/tmp/healthcheck.json");
    expect(writer.writes[0]?.contents).toContain("2026-10-05T12:00:00.000Z");

    vi.advanceTimersByTime(60_000);
    expect(metrics.heartbeats).toBe(2);
    expect(writer.writes).toHaveLength(2);

    vi.advanceTimersByTime(60_000 * 3);

    expect(metrics.heartbeats).toBe(5);
    expect(writer.writes).toHaveLength(5);
  });

  it("stops scheduling once stopped", () => {
    const metrics = fakeMetrics();
    const writer = fakeHealthcheckWriter();
    const heartbeat = createHeartbeat({
      metrics,
      clock: fakeClock("2026-10-05T12:00:00.000Z"),
      healthcheckWriter: writer,
      healthcheckPath: "/tmp/healthcheck.json",
    });

    heartbeat.start();
    vi.advanceTimersByTime(60_000);
    heartbeat.stop();
    vi.advanceTimersByTime(60_000 * 5);

    expect(metrics.heartbeats).toBe(2);
  });

  it("does not start a second schedule nor re-tick immediately if start() is called again", () => {
    const metrics = fakeMetrics();
    const writer = fakeHealthcheckWriter();
    const heartbeat = createHeartbeat({
      metrics,
      clock: fakeClock("2026-10-05T12:00:00.000Z"),
      healthcheckWriter: writer,
      healthcheckPath: "/tmp/healthcheck.json",
    });

    heartbeat.start();
    heartbeat.start();

    expect(metrics.heartbeats).toBe(1);
  });

  it("catches a tick that throws, reports it through the logger, and never crashes nor stops the schedule (design §12 liveness)", () => {
    const failingMetrics = {
      recordHeartbeat(): void {
        throw new Error("metrics sink unavailable");
      },
    };
    const writer = fakeHealthcheckWriter();
    const errors: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      error(message: string, fields?: Record<string, unknown>): void {
        errors.push({ message, fields });
      },
    };
    const heartbeat = createHeartbeat({
      metrics: failingMetrics,
      clock: fakeClock("2026-10-05T12:00:00.000Z"),
      healthcheckWriter: writer,
      healthcheckPath: "/tmp/healthcheck.json",
      logger,
    });

    expect(() => heartbeat.start()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("heartbeat tick failed: metric emission");

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(errors).toHaveLength(2);
  });

  it("swallows a failed tick silently when no logger is provided (never crashes)", () => {
    const failingMetrics = {
      recordHeartbeat(): void {
        throw new Error("metrics sink unavailable");
      },
    };
    const writer = fakeHealthcheckWriter();
    const heartbeat = createHeartbeat({
      metrics: failingMetrics,
      clock: fakeClock("2026-10-05T12:00:00.000Z"),
      healthcheckWriter: writer,
      healthcheckPath: "/tmp/healthcheck.json",
    });

    expect(() => heartbeat.start()).not.toThrow();
  });

  it("still writes the healthcheck file when the metric sink throws (reviewer round 2, advisory: separate try blocks)", () => {
    const failingMetrics = {
      recordHeartbeat(): void {
        throw new Error("metrics sink unavailable");
      },
    };
    const writer = fakeHealthcheckWriter();
    const heartbeat = createHeartbeat({
      metrics: failingMetrics,
      clock: fakeClock("2026-10-05T12:00:00.000Z"),
      healthcheckWriter: writer,
      healthcheckPath: "/tmp/healthcheck.json",
    });

    heartbeat.start();

    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]?.contents).toContain("2026-10-05T12:00:00.000Z");
  });

  it("still records the heartbeat metric when the healthcheck writer throws (reviewer round 2, advisory: separate try blocks)", () => {
    const metrics = fakeMetrics();
    const failingWriter: HealthcheckWriter = {
      write(): void {
        throw new Error("disk full");
      },
    };
    const errors: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      error(message: string, fields?: Record<string, unknown>): void {
        errors.push({ message, fields });
      },
    };
    const heartbeat = createHeartbeat({
      metrics,
      clock: fakeClock("2026-10-05T12:00:00.000Z"),
      healthcheckWriter: failingWriter,
      healthcheckPath: "/tmp/healthcheck.json",
      logger,
    });

    expect(() => heartbeat.start()).not.toThrow();

    expect(metrics.heartbeats).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("heartbeat tick failed: healthcheck write");
  });
});
