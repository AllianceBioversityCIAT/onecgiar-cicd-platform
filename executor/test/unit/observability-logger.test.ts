// @akili-spec changes/cicd-executor-poc design §7 (observability row), §12; requirements FR-17
//
// Proves the JSON logger: structured lines over an injectable sink (no
// console noise in tests), bound context (`executionId`, `stepId`,
// `eventType`, `attempt`, design §7's observability row), redaction applied
// before serialization, and the `EventRouterLogger` adapter the event-router
// (T-04) consumes without this module reaching into it.
//
// Rework (attempt 3, reviewer round 2, bullet 2): `redactValue`'s cycle
// guard stops a cyclic object from crashing the logger with a stack
// overflow, but a `BigInt` field crashes `JSON.stringify` itself (a
// `TypeError`, not a `RangeError`) even after redaction — redaction doesn't
// make a value JSON-safe, it only removes secrets. The logger's `log()` must
// never let that escape to the caller either; proven below end-to-end
// (through `createLogger`, not just `JSON.stringify` in isolation).
import { describe, expect, it } from "vitest";
import { createLogger, createEventRouterLogger, type LogSink } from "../../src/observability/logger/index.js";
import type { EventRouterLogger } from "../../src/application/event-router/index.js";

function fakeClock(iso: string) {
  return { now: () => new Date(iso) };
}

function capturingSink(): LogSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
  };
}

describe("createLogger — JSON logger with context and redaction (FR-17, design §7)", () => {
  it("emits one JSON line per call, through the injected sink only (no console noise)", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    logger.info("execution created");

    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed).toMatchObject({ level: "info", message: "execution created", timestamp: "2026-10-05T12:00:00.000Z" });
  });

  it("includes bound context fields (executionId, stepId, eventType, attempt) on every line once bound via withContext", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });
    const bound = logger.withContext({ executionId: "exec-1", stepId: "step-ssh-1", eventType: "STEP_SUCCEEDED", attempt: 2 });

    bound.info("step dispatched");
    bound.warn("step delayed");

    for (const line of sink.lines) {
      const parsed = JSON.parse(line);
      expect(parsed.executionId).toBe("exec-1");
      expect(parsed.stepId).toBe("step-ssh-1");
      expect(parsed.eventType).toBe("STEP_SUCCEEDED");
      expect(parsed.attempt).toBe(2);
    }
  });

  it("redacts secrets out of both the message and extra fields before writing the line", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    logger.error("ssh connect failed", { password: "fake-hunter2", detail: "Bearer fake.jwt.token" });

    const parsed = JSON.parse(sink.lines[0]!);
    expect(JSON.stringify(parsed)).not.toContain("fake-hunter2");
    expect(JSON.stringify(parsed)).not.toContain("fake.jwt.token");
  });

  it("never leaks a secret through console output (the sink is the only writer)", () => {
    const sink = capturingSink();
    const originalLog = console.log;
    let consoleCalls = 0;
    console.log = () => {
      consoleCalls += 1;
    };
    try {
      const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });
      logger.info("quiet by design");
    } finally {
      console.log = originalLog;
    }
    expect(consoleCalls).toBe(0);
  });

  it("does not let a field override the bound context, level, or timestamp (reviewer round 1, advisory a)", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });
    const bound = logger.withContext({ executionId: "exec-real" });

    bound.info("step dispatched", {
      executionId: "exec-forged",
      level: "forged-level",
      timestamp: "1999-01-01T00:00:00.000Z",
      message: "forged message",
    });

    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.executionId).toBe("exec-real");
    expect(parsed.level).toBe("info");
    expect(parsed.timestamp).toBe("2026-10-05T12:00:00.000Z");
    expect(parsed.message).toBe("step dispatched");
  });

  describe("end-to-end: the FR-17 redaction corpus survives a real logger call (reviewer round 1, advisory b)", () => {
    const FAKE_PASSWORD_VALUE = "hunter2-fake-password";
    const FAKE_BEARER_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.signature";
    const FAKE_AWS_TEMP_ACCESS_KEY_ID = "ASIAFAKEACCESSKEYID9";
    const FAKE_SECURITY_TOKEN = "SEC-TOKEN-LEAK-FAKE-0123456789";
    const FAKE_PEM_BODY = "MIIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
    const FAKE_PRESIGNED_URL =
      `https://fake-bucket.s3.amazonaws.com/fake-key?X-Amz-Credential=${FAKE_AWS_TEMP_ACCESS_KEY_ID}/20261005/us-east-1/s3/aws4_request` +
      `&X-Amz-Security-Token=${FAKE_SECURITY_TOKEN}&X-Amz-Signature=abcfakefake`;

    it("logs a message and fields carrying every corpus category, and none of the raw secrets survive in the written line", () => {
      const sink = capturingSink();
      const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

      logger
        .withContext({ executionId: "exec-1", stepId: "step-ssh-1" })
        .error("ssh step failed", {
          password: FAKE_PASSWORD_VALUE,
          authHeader: `Authorization header: ${FAKE_BEARER_TOKEN}`,
          presignedUrl: FAKE_PRESIGNED_URL,
          hostKey: `-----BEGIN PRIVATE KEY-----\n${FAKE_PEM_BODY}\n-----END PRIVATE KEY-----`,
          nested: { detail: `db_password=${FAKE_PASSWORD_VALUE}` },
        });

      expect(sink.lines).toHaveLength(1);
      const line = sink.lines[0]!;
      for (const secret of [FAKE_PASSWORD_VALUE, FAKE_BEARER_TOKEN, FAKE_SECURITY_TOKEN, FAKE_PEM_BODY]) {
        expect(line).not.toContain(secret);
      }
      const parsed = JSON.parse(line);
      expect(parsed.executionId).toBe("exec-1");
      expect(parsed.stepId).toBe("step-ssh-1");
      expect(parsed.message).toBe("ssh step failed");
    });
  });
});

describe("createLogger — never throws on a value JSON.stringify cannot serialize (reviewer round 2, bullet 2)", () => {
  it("does not throw when a field carries a BigInt (TypeError: Do not know how to serialize a BigInt)", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    expect(() => logger.info("build finished", { durationNanos: 123456789012345678901234567890n })).not.toThrow();
  });

  it("still writes a usable fallback line (level, timestamp, message) when serialization fails", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    logger.error("build failed", { exitCode: 7n });

    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.level).toBe("error");
    expect(parsed.timestamp).toBe("2026-10-05T12:00:00.000Z");
    expect(parsed.message).toBe("build failed");
    expect(parsed.serializationError).toBe(true);
  });

  it("does not throw and still produces a line when a logged object is cyclic", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });
    const cyclic: Record<string, unknown> = { stepId: "step-1" };
    cyclic.self = cyclic;

    expect(() => logger.error("ssh step failed", { detail: cyclic })).not.toThrow();
    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.detail.self).toBe("[Circular]");
  });
});

describe("createLogger — idempotencyToken survives redaction end-to-end (design DD-04, reviewer round 2, bullet 3)", () => {
  it("logs idempotencyToken unredacted, unlike a bare token field", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });

    logger.info("codebuild dispatched", { idempotencyToken: "dispatch-fake-123", apiKey: "fake-api-key-leak" });

    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.idempotencyToken).toBe("dispatch-fake-123");
    expect(parsed.apiKey).toBe("[REDACTED]");
  });
});

describe("createEventRouterLogger — adapts the logger to the event-router's EventRouterLogger seam", () => {
  it("logs an orphan event with its reason, executionId and stepId, satisfying EventRouterLogger structurally", () => {
    const sink = capturingSink();
    const logger = createLogger({ sink, clock: fakeClock("2026-10-05T12:00:00.000Z") });
    const routerLogger: EventRouterLogger = createEventRouterLogger(logger);

    routerLogger.orphanEvent({
      reason: "STALE_ATTEMPT",
      executionId: "exec-9",
      stepId: "step-codebuild-1",
      externalId: "build-123",
      currentExternalRef: "build-999",
    });

    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.executionId).toBe("exec-9");
    expect(parsed.stepId).toBe("step-codebuild-1");
    expect(parsed.eventType).toBe("ORPHAN_EVENT");
    expect(parsed.reason).toBe("STALE_ATTEMPT");
  });
});
