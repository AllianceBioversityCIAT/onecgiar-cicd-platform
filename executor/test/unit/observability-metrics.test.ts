// @akili-spec changes/cicd-executor-poc design §12 (observability row); requirements FR-17
//
// Proves the EMF metrics emitter: each call writes one CloudWatch Embedded
// Metric Format (EMF) JSON line through the injected sink, shaped per the
// EMF spec (`_aws.CloudWatchMetrics` with `Namespace`/`Dimensions`/`Metrics`)
// and design §12's exact metric names: `ExecutionsStarted/Succeeded/Failed`,
// `StepDurationMs` per step type, `LockWaitMs`, `DispatchLatencyMs`, plus the
// event-router's `OrphanEvents`/`RetryLater` counters and the liveness
// heartbeat metric.
import { describe, expect, it } from "vitest";
import { createMetrics, type MetricsSink } from "../../src/observability/metrics/index.js";
import type { EventRouterMetrics } from "../../src/application/event-router/index.js";

function fakeClock(iso: string) {
  return { now: () => new Date(iso) };
}

function capturingSink(): MetricsSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
  };
}

function parseEmfLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("createMetrics — EMF metrics emission (design §12)", () => {
  it("emits a valid EMF document for a dimensionless counter (ExecutionsStarted)", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    metrics.recordExecutionStarted();

    expect(sink.lines).toHaveLength(1);
    const doc = parseEmfLine(sink.lines[0]!);
    const aws = doc._aws as { Timestamp: number; CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string }> }> };
    expect(aws.Timestamp).toBe(new Date("2026-10-05T12:00:00.000Z").getTime());
    expect(aws.CloudWatchMetrics[0]?.Namespace).toBe("CicdExecutor");
    expect(aws.CloudWatchMetrics[0]?.Metrics).toEqual([{ Name: "ExecutionsStarted", Unit: "Count" }]);
    expect(doc.ExecutionsStarted).toBe(1);
  });

  it("emits ExecutionsSucceeded and ExecutionsFailed under their own metric names", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    metrics.recordExecutionSucceeded();
    metrics.recordExecutionFailed();

    const names = sink.lines.map((line) => Object.keys(parseEmfLine(line)).find((key) => key !== "_aws"));
    expect(names).toEqual(["ExecutionsSucceeded", "ExecutionsFailed"]);
  });

  it("emits StepDurationMs dimensioned by step type", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    metrics.recordStepDuration("ssh", 4321);

    const doc = parseEmfLine(sink.lines[0]!);
    const aws = doc._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: string }> }> };
    expect(aws.CloudWatchMetrics[0]?.Dimensions).toEqual([["StepType"]]);
    expect(aws.CloudWatchMetrics[0]?.Metrics).toEqual([{ Name: "StepDurationMs", Unit: "Milliseconds" }]);
    expect(doc.StepType).toBe("ssh");
    expect(doc.StepDurationMs).toBe(4321);
  });

  it("emits LockWaitMs and DispatchLatencyMs (NFR-05 coordination latency)", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    metrics.recordLockWaitMs(1500);
    metrics.recordDispatchLatencyMs(2500);

    const first = parseEmfLine(sink.lines[0]!);
    const second = parseEmfLine(sink.lines[1]!);
    expect(first.LockWaitMs).toBe(1500);
    expect(second.DispatchLatencyMs).toBe(2500);
  });

  it("emits the ExecutorHeartbeat liveness metric (design §12 liveness)", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    metrics.recordHeartbeat();

    const doc = parseEmfLine(sink.lines[0]!);
    expect(doc.ExecutorHeartbeat).toBe(1);
  });
});

describe("createMetrics — event-router counters (design §12: OrphanEvents, RetryLater)", () => {
  it("satisfies EventRouterMetrics structurally via recordOrphanEvent", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });
    const routerMetrics: EventRouterMetrics = metrics;

    routerMetrics.recordOrphanEvent();

    const doc = parseEmfLine(sink.lines[0]!);
    expect(doc.OrphanEvents).toBe(1);
  });

  it("exposes recordRetryLater for the RETRY_LATER outcome (design §12's RetryLater counter)", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    metrics.recordRetryLater();

    const doc = parseEmfLine(sink.lines[0]!);
    expect(doc.RetryLater).toBe(1);
  });
});
