// @akili-spec changes/cicd-executor-poc design §12 (observability row); requirements FR-17
//
// Proves the EMF metrics emitter: each call writes one CloudWatch Embedded
// Metric Format (EMF) JSON line through the injected sink, shaped per the
// EMF spec (`_aws.CloudWatchMetrics` with `Namespace`/`Dimensions`/`Metrics`)
// and the metric names: `ExecutionsStarted/Succeeded/Failed`, `LockWaitMs`,
// `DispatchLatencyMs`, `NotificationFailures` and the liveness heartbeat metric.
import { describe, expect, it } from "vitest";
import { createMetrics, type MetricsSink } from "../../src/observability/metrics/index.js";

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

describe("createMetrics — NotificationFailures by provider (FR-14)", () => {
  it("emits NotificationFailures = 1 dimensioned by provider", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    metrics.recordNotificationFailed("slack");

    const doc = parseEmfLine(sink.lines[0]!);
    expect(doc.NotificationFailures).toBe(1);
    expect(doc.provider).toBe("slack");
  });
});

describe("createMetrics — RejectedRequests by reason (design §12, DD-25)", () => {
  it("emits RejectedRequests = 1 with the reason dimension", () => {
    const sink = capturingSink();
    const metrics = createMetrics({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    metrics.recordRejectedRequest("UNAUTHORIZED_SENDER");

    const doc = parseEmfLine(sink.lines[0]!) as Record<string, unknown>;
    expect(doc.RejectedRequests).toBe(1);
    expect(doc.reason).toBe("UNAUTHORIZED_SENDER");
    const directive = (doc._aws as { CloudWatchMetrics: { Dimensions: string[][]; Metrics: { Name: string }[] }[] }).CloudWatchMetrics[0]!;
    expect(directive.Dimensions).toEqual([["reason"]]);
    expect(directive.Metrics.map((m) => m.Name)).toEqual(["RejectedRequests"]);
  });
});
