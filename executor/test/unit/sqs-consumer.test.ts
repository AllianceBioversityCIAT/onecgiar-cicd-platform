// @akili-spec changes/cicd-executor-poc design §7 (sqs-consumer row), DD-14, DD-25; requirements FR-04, NFR-03
// Unit tests for the SQS consumer with a fake SQS client: ack ordering, heartbeat, no-ack paths, shutdown.
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSqsConsumer, type InboundMessage } from "../../src/inbound/sqs-consumer/index.js";
import { createLogger, createMetrics } from "../../src/observability/index.js";

interface SentCommand {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

class FakeSqs {
  readonly sent: SentCommand[] = [];
  readonly events: string[] = [];
  private readonly batches: Message[][] = [];
  failReceiveTimes = 0;

  enqueue(...messages: Message[]): void {
    for (const message of messages) {
      this.batches.push([message]);
    }
  }

  asClient(): SQSClient {
    return {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) =>
        this.dispatch(command, options),
    } as unknown as SQSClient;
  }

  private dispatch(
    command: { constructor: { name: string }; input: Record<string, unknown> },
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown> {
    const name = command.constructor.name;
    this.sent.push({ name, input: command.input });
    if (name === "ReceiveMessageCommand") {
      this.events.push("receive");
      if (this.failReceiveTimes > 0) {
        this.failReceiveTimes -= 1;
        return Promise.reject(new Error("receive boom"));
      }
      const next = this.batches.shift();
      if (next !== undefined) {
        return Promise.resolve({ Messages: next });
      }
      // Emulates an empty long poll that only ends when the client aborts it.
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (name === "ChangeMessageVisibilityCommand") {
      this.events.push("heartbeat");
    } else if (name === "DeleteMessageCommand") {
      this.events.push("delete");
    }
    return Promise.resolve({});
  }

  count(name: string): number {
    return this.sent.filter((entry) => entry.name === name).length;
  }
}

function message(id: string, body = '{"eventType":"X","secret":"hunter2"}', attributes: Record<string, string> = {}): Message {
  return {
    MessageId: id,
    ReceiptHandle: `handle-${id}`,
    Body: body,
    Attributes: { ApproximateReceiveCount: "1", ...attributes },
  };
}

function deferred(): { promise: Promise<{ ack: boolean }>; resolve(value: { ack: boolean }): void } {
  let resolve!: (value: { ack: boolean }) => void;
  const promise = new Promise<{ ack: boolean }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createSqsConsumer", () => {
  let sqs: FakeSqs;
  let logLines: string[];

  function build(
    handle: (message: InboundMessage) => Promise<{ ack: boolean }>,
    extra: Partial<Parameters<typeof createSqsConsumer>[0]> = {},
  ): ReturnType<typeof createSqsConsumer> {
    const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
    return createSqsConsumer({
      client: sqs.asClient(),
      queueUrl: "http://queue.invalid/events",
      handle,
      logger: createLogger({ sink: { write: (line) => logLines.push(line) }, clock }),
      metrics: createMetrics({ sink: { write: () => undefined }, clock }),
      ...extra,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sqs = new FakeSqs();
    logLines = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("requests SenderId and ApproximateReceiveCount on receipt and maps them to the handler (DD-25)", async () => {
    const seen: InboundMessage[] = [];
    sqs.enqueue(message("m1", "{}", { SenderId: "ROLE:session", ApproximateReceiveCount: "3" }));
    const consumer = build((m) => {
      seen.push(m);
      return Promise.resolve({ ack: true });
    });
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.stop();

    const receive = sqs.sent.find((entry) => entry.name === "ReceiveMessageCommand");
    expect(receive?.input["MessageSystemAttributeNames"]).toEqual(["SenderId", "ApproximateReceiveCount"]);
    expect(receive?.input["WaitTimeSeconds"]).toBe(20);
    expect(receive?.input["MaxNumberOfMessages"]).toBe(1);
    expect(seen).toEqual([{ messageId: "m1", body: "{}", senderId: "ROLE:session", approximateReceiveCount: 3 }]);
  });

  test("deletes the message only after the handler resolved with ack:true", async () => {
    sqs.enqueue(message("m1"));
    const consumer = build(() => {
      sqs.events.push("handler:start");
      return Promise.resolve().then(() => {
        sqs.events.push("handler:end");
        return { ack: true };
      });
    });
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.stop();

    expect(sqs.events.filter((event) => event !== "receive")).toEqual(["handler:start", "handler:end", "delete"]);
    const del = sqs.sent.find((entry) => entry.name === "DeleteMessageCommand");
    expect(del?.input["ReceiptHandle"]).toBe("handle-m1");
  });

  test("ack:false leaves the message on the queue (no delete, no visibility reset)", async () => {
    sqs.enqueue(message("m1"));
    const consumer = build(() => Promise.resolve({ ack: false }));
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.stop();

    expect(sqs.count("DeleteMessageCommand")).toBe(0);
    expect(sqs.count("ChangeMessageVisibilityCommand")).toBe(0);
  });

  test("a throwing handler leaves the message and the consumer keeps polling", async () => {
    sqs.enqueue(message("bad"), message("good"));
    const acked: string[] = [];
    const consumer = build((m) => {
      if (m.messageId === "bad") {
        return Promise.reject(new Error("handler boom"));
      }
      acked.push(m.messageId);
      return Promise.resolve({ ack: true });
    });
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.stop();

    expect(acked).toEqual(["good"]);
    const deleted = sqs.sent.filter((entry) => entry.name === "DeleteMessageCommand").map((entry) => entry.input["ReceiptHandle"]);
    expect(deleted).toEqual(["handle-good"]);
  });

  test("extends visibility every heartbeat interval while the handler runs and stops when it finishes (DD-14)", async () => {
    sqs.enqueue(message("m1"));
    const gate = deferred();
    const consumer = build(() => gate.promise, { visibilityTimeoutSeconds: 120, heartbeatIntervalSeconds: 60 });
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sqs.count("ChangeMessageVisibilityCommand")).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sqs.count("ChangeMessageVisibilityCommand")).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sqs.count("ChangeMessageVisibilityCommand")).toBe(2);
    const heartbeat = sqs.sent.find((entry) => entry.name === "ChangeMessageVisibilityCommand");
    expect(heartbeat?.input).toMatchObject({ ReceiptHandle: "handle-m1", VisibilityTimeout: 120 });

    gate.resolve({ ack: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sqs.count("ChangeMessageVisibilityCommand")).toBe(2);
    expect(sqs.events.at(-1)).toBe("receive");
    expect(sqs.events.filter((event) => event === "delete")).toHaveLength(1);
    expect(sqs.events.indexOf("delete")).toBeGreaterThan(sqs.events.lastIndexOf("heartbeat"));
    await consumer.stop();
  });

  test("a failing heartbeat does not fail the handler", async () => {
    sqs.enqueue(message("m1"));
    const gate = deferred();
    const failing = sqs.asClient();
    const original = failing.send.bind(failing) as (command: { constructor: { name: string } }, options?: unknown) => Promise<unknown>;
    (failing as unknown as { send: unknown }).send = (command: { constructor: { name: string } }, options?: unknown) =>
      command.constructor.name === "ChangeMessageVisibilityCommand" ? Promise.reject(new Error("hb boom")) : original(command, options);
    const consumer = build(() => gate.promise, { client: failing, heartbeatIntervalSeconds: 1 });
    await consumer.start();
    await vi.advanceTimersByTimeAsync(1_500);
    gate.resolve({ ack: true });
    await vi.advanceTimersByTimeAsync(0);
    await consumer.stop();

    expect(sqs.count("DeleteMessageCommand")).toBe(1);
    expect(logLines.some((line) => line.includes("visibility heartbeat failed"))).toBe(true);
  });

  test("never logs the raw message body", async () => {
    sqs.enqueue(message("m1", '{"eventType":"X","secret":"hunter2-body-marker"}'));
    const consumer = build(() => Promise.reject(new Error("handler boom")));
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.stop();

    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain("hunter2-body-marker");
  });

  test("stop() stops polling and waits for the in-flight handler before returning", async () => {
    sqs.enqueue(message("m1"));
    const gate = deferred();
    const consumer = build(() => gate.promise);
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false);

    gate.resolve({ ack: true });
    await stopping;
    expect(stopped).toBe(true);
    expect(sqs.count("DeleteMessageCommand")).toBe(1);
    const receivesAfterStop = sqs.count("ReceiveMessageCommand");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sqs.count("ReceiveMessageCommand")).toBe(receivesAfterStop);
  });

  test("stop() is bounded: a stuck handler is abandoned, its message is not deleted", async () => {
    sqs.enqueue(message("m1"));
    const gate = deferred();
    const consumer = build(() => gate.promise, { shutdownTimeoutMs: 5_000, heartbeatIntervalSeconds: 1 });
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopping = consumer.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    const heartbeatsAtStop = sqs.count("ChangeMessageVisibilityCommand");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sqs.count("DeleteMessageCommand")).toBe(0);
    expect(sqs.count("ChangeMessageVisibilityCommand")).toBe(heartbeatsAtStop);
    expect(logLines.some((line) => line.includes("shutdown timeout"))).toBe(true);
  });

  test("a failed receive is retried after a backoff", async () => {
    sqs.failReceiveTimes = 1;
    sqs.enqueue(message("m1"));
    const handled: string[] = [];
    const consumer = build(
      (m) => {
        handled.push(m.messageId);
        return Promise.resolve({ ack: true });
      },
      { receiveErrorBackoffMs: 500 },
    );
    await consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(handled).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    await consumer.stop();

    expect(handled).toEqual(["m1"]);
  });
});
